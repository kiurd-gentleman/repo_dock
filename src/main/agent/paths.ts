import fs from 'node:fs'
import path from 'node:path'
import { agentDir, dataDir } from '../store'

const fwd = (p: string): string => p.replace(/\\/g, '/')

/**
 * The helper runs with RepoDock's own executable in Node mode (ELECTRON_RUN_AS_NODE), so users
 * don't need Node installed. It is copied out of the app bundle to a stable path on every start.
 */
export const helperScript = (): string => path.join(agentDir(), 'repodock-agent.js')
// An AppImage runs from a temporary mount that changes every launch; $APPIMAGE is the stable file.
export const helperExe = (): string => process.env.APPIMAGE || process.execPath

export function installHelper(): void {
  const copy = (src: string, dest: string) => {
    const body = fs.readFileSync(src)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(body)) fs.writeFileSync(dest, body)
    return body.toString('utf8')
  }
  const built = path.join(__dirname, 'agent-cli.js')
  if (!fs.existsSync(built)) throw new Error(`${built} is missing. Restart \`npm run dev\` (or rebuild) so the MCP helper gets built.`)
  const main = copy(built, helperScript())
  // The bundler may split shared code into chunks; copy those along with the helper.
  for (const m of main.matchAll(/require\("\.\/(chunks\/[^"]+)"\)/g)) copy(path.join(__dirname, m[1]), path.join(agentDir(), m[1]))
}

/** MCP stdio server entry, in the shape every MCP client understands. */
export function mcpEntry(): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: helperExe(),
    args: [helperScript(), 'mcp'],
    env: { ELECTRON_RUN_AS_NODE: '1', REPODOCK_HOME: dataDir() }
  }
}

/** Shell form for git's `!helper` syntax (run by Git for Windows' sh). */
export function gitHelperCommand(sub: string): string {
  const q = (s: string) => `'${fwd(s).replace(/'/g, `'\\''`)}'`
  return `!ELECTRON_RUN_AS_NODE=1 REPODOCK_HOME=${q(dataDir())} ${q(helperExe())} ${q(helperScript())} ${sub}`
}
