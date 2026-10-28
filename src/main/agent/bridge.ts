import { app, BrowserWindow, Notification } from 'electron'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AgentApproval, AgentLogEntry, Repo } from '../../shared/types'
import { AGENT_TOOLS } from '../../shared/agentTools'
import { agentDir, getToken, load, newId, save } from '../store'
import { detectAccount } from '../handlers'
import * as git from '../git'
import { runTool, resolveRepo, describeAction } from './tools'

const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\repodock-${os.userInfo().username}` : path.join(os.tmpdir(), `repodock-${os.userInfo().username}.sock`)
const APPROVAL_TIMEOUT = 3 * 60_000
const LOG_MAX = 400

let server: net.Server | null = null
let secret = ''
const pending = new Map<string, { approval: AgentApproval; resolve: (ok: boolean) => void }>()
/** "client|repo|tool" allowed until RepoDock restarts. */
const sessionAllow = new Set<string>()

// ---------- events to the UI ----------

function send(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('event', channel, payload)
}

export function pendingApprovals(): AgentApproval[] {
  return [...pending.values()].map((p) => p.approval)
}

function log(entry: Omit<AgentLogEntry, 'id' | 'time'>): AgentLogEntry {
  const e: AgentLogEntry = { id: newId(), time: Date.now(), ...entry }
  const d = load()
  d.agent.log.unshift(e)
  d.agent.log.length = Math.min(d.agent.log.length, LOG_MAX)
  save()
  send('agent:log', e)
  return e
}

function updateLog(id: string, patch: Partial<AgentLogEntry>): void {
  const e = load().agent.log.find((x) => x.id === id)
  if (!e) return
  Object.assign(e, patch)
  save()
  send('agent:log', e)
}

// ---------- approvals ----------

function needsApproval(client: string, repo: Repo, tool: string, args: Record<string, unknown>): boolean {
  const def = AGENT_TOOLS.find((t) => t.name === tool)!
  if (tool === 'push' && args.force) return true // never silently force-push
  const { policy, rules } = load().agent
  const key = `${client}|${repo.id}|${tool}`
  if (sessionAllow.has(key) || rules.some((r) => r.client === client && r.repoId === repo.id && r.tool === tool)) return false
  if (def.risk === 'read' || policy === 'trust') return false
  if (def.risk === 'write') return policy === 'ask-writes'
  return true
}

function ask(approval: AgentApproval): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => answer(approval.id, 'deny'), APPROVAL_TIMEOUT)
    pending.set(approval.id, {
      approval,
      resolve: (ok) => {
        clearTimeout(timer)
        resolve(ok)
      }
    })
    send('agent:approvals', pendingApprovals())
    // Get the user's attention without stealing focus from their editor.
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isFocused()) {
      win.flashFrame(true)
      if (Notification.isSupported()) {
        const n = new Notification({ title: `${approval.client} needs your OK`, body: `${approval.title} · ${approval.repoName}` })
        n.on('click', () => (win.isMinimized() && win.restore(), win.show(), win.focus()))
        n.show()
      }
    }
  })
}

export function answer(id: string, decision: 'once' | 'session' | 'always' | 'deny'): void {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  const { client, repoId, tool } = p.approval
  if (decision === 'session') sessionAllow.add(`${client}|${repoId}|${tool}`)
  if (decision === 'always') {
    load().agent.rules.push({ client, repoId, tool })
    save()
  }
  p.resolve(decision !== 'deny')
  send('agent:approvals', pendingApprovals())
  if (!pending.size) BrowserWindow.getAllWindows()[0]?.flashFrame(false)
}

// ---------- requests from the helper ----------

interface Request {
  id: number
  secret: string
  method: 'hello' | 'tool' | 'credential'
  params: any
}

async function callTool(p: { client: string; cwd?: string; name: string; args: Record<string, unknown> }): Promise<string> {
  const client = p.client || 'AI tool'
  const def = AGENT_TOOLS.find((t) => t.name === p.name)
  if (!def) throw new Error(`Unknown tool ${p.name}`)
  const args = p.args ?? {}
  const repo = p.name === 'list_repos' || p.name === 'add_repo' ? null : resolveRepo(args.repo as string | undefined, p.cwd)
  const entry = log({ client, repoId: repo?.id ?? null, repoName: repo?.name ?? null, tool: p.name, summary: summarize(p.name, args), status: 'pending' })
  const started = Date.now()
  try {
    if (repo && needsApproval(client, repo, p.name, args)) {
      const action = await describeAction(repo, p.name, args)
      const ok = await ask({ id: newId(), client, repoId: repo.id, repoName: repo.name, tool: p.name, createdAt: Date.now(), timeoutAt: Date.now() + APPROVAL_TIMEOUT, ...action })
      if (!ok) {
        updateLog(entry.id, { status: 'denied', ms: Date.now() - started })
        throw new Error(`The user declined “${def.title}” on ${repo.name} in RepoDock. Do not retry unless they ask you to.`)
      }
    }
    const out = await runTool(p.name, repo, args, p.cwd)
    updateLog(entry.id, { status: 'ok', ms: Date.now() - started })
    if (repo && def.risk !== 'read') send('repos:changed', [repo.id])
    if (p.name === 'fetch' && repo) send('repos:changed', [repo.id])
    return out
  } catch (e) {
    const msg = (e as Error).message
    if (!/declined/.test(msg)) updateLog(entry.id, { status: 'error', error: msg, ms: Date.now() - started })
    throw e
  }
}

function summarize(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'commit': return `“${String(args.message ?? '').split('\n')[0].slice(0, 80)}”`
    case 'checkout': return `${args.create ? 'new ' : ''}${args.branch}`
    case 'push': return args.force ? 'force (with lease)' : ''
    case 'create_pull_request': return `“${args.title}”`
    case 'diff': return args.path ? String(args.path) : args.staged ? 'staged' : ''
    case 'add_repo': return String(args.path ?? '')
    default: return ''
  }
}

const lastCredLog = new Map<string, number>()

/** git credential helper: hands the account's token to plain `git` running in a linked repo. */
function credential(p: { repoId: string }): { username: string; password: string } | null {
  const r = load().repos.find((x) => x.id === p.repoId)
  if (!r) return null
  const remoteOwner = git.parseRemote(readRemote(r))?.owner ?? null
  const a = detectAccount(r, remoteOwner)
  if (!a) return null
  const token = getToken(a.id)
  if (!token) return null
  // One log line per repo per minute — git may ask several times per command.
  if (Date.now() - (lastCredLog.get(r.id) ?? 0) > 60_000) {
    lastCredLog.set(r.id, Date.now())
    log({ client: 'git', repoId: r.id, repoName: r.name, tool: 'git', summary: `credentials for ${a.login || a.label}`, status: 'ok' })
  }
  return { username: 'x-access-token', password: token }
}

/** Synchronous best-effort read of origin's URL from .git/config. */
function readRemote(r: Repo): string | null {
  try {
    let gitDir = path.join(r.path, '.git')
    if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(r.path, fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim())
    const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8')
    return cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] ?? null
  } catch {
    return null
  }
}

async function handle(req: Request): Promise<unknown> {
  if (req.method === 'hello') return { app: 'RepoDock', version: app.getVersion() }
  if (req.method === 'tool') return callTool(req.params)
  if (req.method === 'credential') return credential(req.params)
  throw new Error(`Unknown method ${req.method}`)
}

function onConnection(sock: net.Socket): void {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let req: Request
      try {
        req = JSON.parse(line)
      } catch {
        continue
      }
      const reply = (body: object) => sock.writable && sock.write(JSON.stringify({ id: req.id, ...body }) + '\n')
      if (!req.secret || req.secret.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(req.secret), Buffer.from(secret))) {
        reply({ error: 'Not authorized' })
        continue
      }
      handle(req).then(
        (result) => reply({ result }),
        (e) => reply({ error: git.redact((e as Error).message) })
      )
    }
  })
  sock.on('error', () => {})
}

export function startBridge(): void {
  fs.mkdirSync(agentDir(), { recursive: true })
  secret = crypto.randomBytes(32).toString('hex')
  const info = {
    pipe: PIPE,
    secret,
    pid: process.pid,
    // Lets the helper start RepoDock when an AI tool needs it and the app is closed.
    launch: app.isPackaged ? { command: process.execPath, args: [] as string[] } : null
  }
  const infoFile = path.join(agentDir(), 'bridge.json')
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2))
  if (process.platform === 'win32') {
    // Owner-only, like the SSH keys.
    execFile('icacls', [infoFile, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { windowsHide: true }, () => {})
  } else fs.chmodSync(infoFile, 0o600)

  if (process.platform !== 'win32') fs.rmSync(PIPE, { force: true })
  server = net.createServer(onConnection)
  server.on('error', (e) => console.error('[agent bridge]', e.message))
  server.listen(PIPE)
}

export function stopBridge(): void {
  for (const id of [...pending.keys()]) answer(id, 'deny')
  server?.close()
  server = null
}

export const bridgeRunning = (): boolean => !!server?.listening

export function clearLog(): void {
  load().agent.log = []
  save()
}
