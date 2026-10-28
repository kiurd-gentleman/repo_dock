/**
 * RepoDock's helper, launched by AI tools (as an MCP server) and by git (as a credential helper).
 * Runs as plain Node through RepoDock's own executable (ELECTRON_RUN_AS_NODE=1), and forwards
 * every request to the running RepoDock app, which holds the keys and asks the user for approval.
 *
 *   repodock-agent.js mcp                    MCP server over stdio
 *   repodock-agent.js credential <repoId> get   git credential helper
 *   repodock-agent.js selftest               connection check used by the UI
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { AGENT_TOOLS, SERVER_INSTRUCTIONS } from '../shared/agentTools'

const HOME = process.env.REPODOCK_HOME || path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'repodock')
const INFO = path.join(HOME, 'agent', 'bridge.json')

interface BridgeInfo {
  pipe: string
  secret: string
  launch: { command: string; args: string[] } | null
}

const readInfo = (): BridgeInfo | null => {
  try {
    return JSON.parse(fs.readFileSync(INFO, 'utf8'))
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Bridge {
  private sock: net.Socket | null = null
  private info: BridgeInfo | null = null
  private seq = 0
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  private tryConnect(): Promise<boolean> {
    const info = readInfo()
    if (!info) return Promise.resolve(false)
    return new Promise((resolve) => {
      const s = net.connect(info.pipe)
      s.once('connect', () => {
        this.sock = s
        this.info = info
        let buf = ''
        s.setEncoding('utf8')
        s.on('data', (chunk: string) => {
          buf += chunk
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            const msg = JSON.parse(buf.slice(0, i))
            buf = buf.slice(i + 1)
            const w = this.waiting.get(msg.id)
            if (!w) continue
            this.waiting.delete(msg.id)
            msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result)
          }
        })
        const drop = () => {
          this.sock = null
          for (const w of this.waiting.values()) w.reject(new Error('RepoDock closed while handling the request.'))
          this.waiting.clear()
        }
        s.on('close', drop)
        s.on('error', drop)
        resolve(true)
      })
      s.once('error', () => resolve(false))
    })
  }

  /** Connects, starting RepoDock first if it's installed but not running. */
  async connect(autoLaunch: boolean): Promise<void> {
    if (this.sock) return
    if (await this.tryConnect()) return
    const launch = readInfo()?.launch
    if (!autoLaunch || !launch || !fs.existsSync(launch.command)) {
      throw new Error('RepoDock is not running. Ask the user to open RepoDock, then try again.')
    }
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    spawn(launch.command, launch.args, { detached: true, stdio: 'ignore', env, windowsHide: false }).unref()
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      if (await this.tryConnect()) return
    }
    throw new Error('RepoDock did not start in time. Ask the user to open it, then try again.')
  }

  async call<T = any>(method: string, params: unknown, autoLaunch = true): Promise<T> {
    await this.connect(autoLaunch)
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.sock!.write(JSON.stringify({ id, secret: this.info!.secret, method, params }) + '\n')
    })
  }

  close(): void {
    this.sock?.end()
  }
}

// ---------- MCP over stdio (newline-delimited JSON-RPC 2.0) ----------

async function mcp(): Promise<void> {
  const bridge = new Bridge()
  let client = 'AI tool'
  let inflight = 0
  let ended = false
  const finish = () => {
    bridge.close()
    process.stdout.write('', () => process.exit(0)) // flush before exiting
  }
  const write = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

  const onMessage = async (msg: any) => {
    const { id, method, params } = msg
    if (id === undefined) return // notifications need no answer
    try {
      switch (method) {
        case 'initialize':
          client = prettyClient(params?.clientInfo?.name) ?? client
          return write({
            id,
            result: {
              protocolVersion: params?.protocolVersion ?? '2025-06-18',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'repodock', title: 'RepoDock', version: '1.0.0' },
              instructions: SERVER_INSTRUCTIONS
            }
          })
        case 'ping':
          return write({ id, result: {} })
        case 'tools/list':
          return write({
            id,
            result: {
              tools: AGENT_TOOLS.map((t) => ({
                name: t.name,
                title: t.title,
                description: t.description,
                inputSchema: t.inputSchema,
                annotations: { title: t.title, readOnlyHint: t.risk === 'read', destructiveHint: t.name === 'push', openWorldHint: t.risk === 'remote' }
              }))
            }
          })
        case 'tools/call': {
          inflight++
          try {
            const text = await bridge.call<string>('tool', { client, cwd: process.cwd(), name: params?.name, args: params?.arguments ?? {} })
            return write({ id, result: { content: [{ type: 'text', text }] } })
          } catch (e) {
            // Tool failures go back to the model as results so it can react, not as protocol errors.
            return write({ id, result: { content: [{ type: 'text', text: (e as Error).message }], isError: true } })
          } finally {
            if (--inflight === 0 && ended) finish()
          }
        }
        case 'resources/list':
          return write({ id, result: { resources: [] } })
        case 'prompts/list':
          return write({ id, result: { prompts: [] } })
        default:
          return write({ id, error: { code: -32601, message: `Method not found: ${method}` } })
      }
    } catch (e) {
      write({ id, error: { code: -32603, message: (e as Error).message } })
    }
  }

  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch {
        write({ id: null, error: { code: -32700, message: 'Parse error' } })
      }
    }
  })
  process.stdin.on('end', () => {
    ended = true
    if (!inflight) finish()
  })
}

function prettyClient(name?: string): string | undefined {
  if (!name) return undefined
  const known: Record<string, string> = {
    'claude-code': 'Claude Code', 'claude-ai': 'Claude Desktop', cursor: 'Cursor', 'cursor-vscode': 'Cursor', 'Visual Studio Code': 'VS Code',
    windsurf: 'Windsurf', codex: 'Codex', 'codex-mcp-client': 'Codex', 'gemini-cli-mcp-client': 'Gemini CLI'
  }
  return known[name] ?? name
}

// ---------- git credential helper ----------

async function credential(repoId: string, op: string): Promise<void> {
  if (op !== 'get') return // store/erase: RepoDock owns the token, nothing to do
  // git sends key=value lines; we only answer for github.com.
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const host = input.match(/^host=(.*)$/m)?.[1]?.trim()
  if (host && host !== 'github.com') return
  try {
    const bridge = new Bridge()
    const cred = await bridge.call<{ username: string; password: string } | null>('credential', { repoId }, false)
    bridge.close()
    if (cred) process.stdout.write(`username=${cred.username}\npassword=${cred.password}\n`)
    else process.stderr.write('RepoDock: no token for this repository’s account.\n')
  } catch (e) {
    process.stderr.write(`RepoDock: ${(e as Error).message.replace('Ask the user to open', 'Open')}\n`)
  }
}

// ---------- self test ----------

async function selftest(): Promise<void> {
  const bridge = new Bridge()
  try {
    const hello = await bridge.call('hello', {}, false)
    process.stdout.write(JSON.stringify({ ok: true, hello }) + '\n')
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).message }) + '\n')
  }
  bridge.close()
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'mcp') mcp()
else if (cmd === 'credential') credential(rest[0], rest[1]).then(() => process.exit(0))
else if (cmd === 'selftest') selftest().then(() => process.exit(0))
else {
  process.stderr.write('Usage: repodock-agent <mcp | credential <repoId> get | selftest>\n')
  process.exit(2)
}
