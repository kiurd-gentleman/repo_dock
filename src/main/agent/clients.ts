import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentClient } from '../../shared/types'
import { mcpEntry } from './paths'

const NAME = 'repodock'
const home = os.homedir()
/** Per-user app settings folder: %APPDATA% on Windows, ~/Library/Application Support on macOS, ~/.config on Linux. */
const appData =
  process.platform === 'win32' ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
  : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
  : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'))

interface Target {
  id: string
  name: string
  /** The tool's own folder. It counts as installed only if the tool put something there (see installed()). */
  detect: string
  file: string
  format: 'json-mcpServers' | 'json-servers' | 'toml-codex'
}

const TARGETS: Target[] = [
  { id: 'claude-code', name: 'Claude Code', detect: path.join(home, '.claude'), file: path.join(home, '.claude.json'), format: 'json-mcpServers' },
  { id: 'claude-desktop', name: 'Claude Desktop', detect: path.join(appData, 'Claude'), file: path.join(appData, 'Claude', 'claude_desktop_config.json'), format: 'json-mcpServers' },
  { id: 'cursor', name: 'Cursor', detect: path.join(home, '.cursor'), file: path.join(home, '.cursor', 'mcp.json'), format: 'json-mcpServers' },
  { id: 'vscode', name: 'VS Code (Copilot)', detect: path.join(appData, 'Code', 'User'), file: path.join(appData, 'Code', 'User', 'mcp.json'), format: 'json-servers' },
  { id: 'windsurf', name: 'Windsurf', detect: path.join(home, '.codeium', 'windsurf'), file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), format: 'json-mcpServers' },
  { id: 'codex', name: 'Codex CLI', detect: path.join(home, '.codex'), file: path.join(home, '.codex', 'config.toml'), format: 'toml-codex' },
  { id: 'gemini', name: 'Gemini CLI', detect: path.join(home, '.gemini'), file: path.join(home, '.gemini', 'settings.json'), format: 'json-mcpServers' }
]

/** Files RepoDock itself may have written into a tool's folder. */
const ours = (t: Target): Set<string> => {
  const base = path.basename(t.file)
  return new Set([base, base + '.repodock-backup', base + '.repodock-tmp'])
}

/**
 * The folder alone isn't proof: older RepoDock versions created it when you clicked Connect.
 * Installed means the folder holds something RepoDock didn't write (the tool's own settings, cache, …).
 */
function installed(t: Target): boolean {
  try {
    const mine = path.dirname(t.file) === t.detect ? ours(t) : new Set<string>()
    return fs.readdirSync(t.detect).some((f) => !mine.has(f))
  } catch {
    return false
  }
}

function target(id: string): Target {
  const t = TARGETS.find((x) => x.id === id)
  if (!t) throw new Error(`Unknown AI tool: ${id}`)
  return t
}

function readJson(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {}
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${path.basename(file)} is not plain JSON (it may contain comments), so RepoDock won't edit it. Use “Copy config” and paste it in yourself.`)
  }
}

/** Writes atomically and keeps one backup of the user's original file. */
function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const backup = file + '.repodock-backup'
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup)
  const tmp = file + '.repodock-tmp'
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

const tomlStr = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`)
const CODEX_BLOCK = /^\[mcp_servers\.repodock(?:\.[^\]]*)?\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/gm

function codexBlock(): string {
  const e = mcpEntry()
  const env = Object.entries(e.env).map(([k, v]) => `${k} = ${tomlStr(v)}`).join(', ')
  return `[mcp_servers.${NAME}]\ncommand = ${tomlStr(e.command)}\nargs = [${e.args.map(tomlStr).join(', ')}]\nenv = { ${env} }\n`
}

/** Returns the configured command, or null if RepoDock isn't configured in this tool. */
function configuredCommand(t: Target): string | null {
  if (!fs.existsSync(t.file)) return null
  if (t.format === 'toml-codex') {
    const block = fs.readFileSync(t.file, 'utf8').match(CODEX_BLOCK)?.[0]
    if (!block) return null
    return block.match(/^command\s*=\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/m)?.slice(1).find((x) => x !== undefined)?.replace(/\\\\/g, '\\') ?? ''
  }
  const j = readJson(t.file)
  const entry = (t.format === 'json-servers' ? j.servers : j.mcpServers)?.[NAME]
  return entry ? String(entry.command ?? '') : null
}

function write(t: Target, on: boolean): void {
  if (t.format === 'toml-codex') {
    const cur = fs.existsSync(t.file) ? fs.readFileSync(t.file, 'utf8') : ''
    let next = cur.replace(CODEX_BLOCK, '').replace(/\n{3,}/g, '\n\n')
    if (on) next = (next.trimEnd() ? next.trimEnd() + '\n\n' : '') + codexBlock()
    if (!on && !next.trim()) return removeOwnFile(t)
    writeFile(t.file, next)
    return
  }
  const j = readJson(t.file)
  const key = t.format === 'json-servers' ? 'servers' : 'mcpServers'
  j[key] = j[key] ?? {}
  if (on) j[key][NAME] = t.format === 'json-servers' ? { type: 'stdio', ...mcpEntry() } : mcpEntry()
  else delete j[key][NAME]
  if (!on && !Object.keys(j[key]).length && Object.keys(j).length === 1) return removeOwnFile(t)
  writeFile(t.file, JSON.stringify(j, null, 2) + '\n')
}

/**
 * Disconnecting left nothing but an empty shell. If RepoDock created that file (no backup of an
 * original exists), delete it, and the tool's folder too when RepoDock created that as well.
 */
function removeOwnFile(t: Target): void {
  const backup = t.file + '.repodock-backup'
  if (fs.existsSync(backup)) {
    writeFile(t.file, t.format === 'toml-codex' ? '' : '{}\n')
    return
  }
  fs.rmSync(t.file, { force: true })
  for (let dir = path.dirname(t.file); dir.startsWith(t.detect) && dir.length >= t.detect.length; dir = path.dirname(dir)) {
    try {
      if (fs.readdirSync(dir).length) break
      fs.rmdirSync(dir)
    } catch {
      break
    }
  }
}

export function listClients(): AgentClient[] {
  return TARGETS.map((t) => {
    try {
      const cmd = configuredCommand(t)
      return { id: t.id, name: t.name, detected: installed(t), connected: cmd !== null, configPath: t.file }
    } catch (e) {
      return { id: t.id, name: t.name, detected: installed(t), connected: false, configPath: t.file, error: (e as Error).message }
    }
  })
}

export function setClient(id: string, on: boolean): void {
  const t = target(id)
  if (on && !installed(t)) throw new Error(`${t.name} doesn't seem to be installed on this PC, so there's nothing to connect. Install it first, or use “Other MCP tool” to copy the config by hand.`)
  write(t, on)
}

/** If RepoDock moved (update, reinstall, dev vs installed), point already-connected tools at the new location. */
export function repairClients(): void {
  const cmd = mcpEntry().command.toLowerCase()
  for (const t of TARGETS) {
    try {
      const cur = configuredCommand(t)
      if (cur !== null && cur.toLowerCase() !== cmd) write(t, true)
    } catch {
      // leave files we can't parse alone
    }
  }
}
