import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Account, AgentLogEntry, AgentPolicy, AgentRule, Group, Repo, ThemeSetting } from '../shared/types'

interface Data {
  accounts: Account[]
  groups: Group[]
  repos: Repo[]
  /** accountId -> token encrypted with the OS keychain (DPAPI on Windows), base64. */
  secrets: Record<string, string>
  agent: { policy: AgentPolicy; rules: AgentRule[]; log: AgentLogEntry[] }
  theme: ThemeSetting
}

const empty = (): Data => ({ accounts: [], groups: [], repos: [], secrets: {}, agent: { policy: 'ask-remote', rules: [], log: [] }, theme: 'system' })

export const dataDir = (): string => app.getPath('userData')
export const keysDir = (): string => path.join(dataDir(), 'keys')
export const knownHostsFile = (): string => path.join(dataDir(), 'known_hosts')
export const agentDir = (): string => path.join(dataDir(), 'agent')
const file = (): string => path.join(dataDir(), 'repodock.json')

let cache: Data | null = null

export function load(): Data {
  if (cache) return cache
  if (!fs.existsSync(file())) return (cache = empty())
  try {
    cache = parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    // Never start over silently: keep the unreadable file aside and fall back to the newest backup.
    fs.copyFileSync(file(), path.join(dataDir(), `repodock.unreadable-${Date.now()}.json`))
    const latest = listBackups()[0]
    cache = latest ? parse(fs.readFileSync(latest, 'utf8')) : empty()
  }
  return cache!
}

function parse(text: string): Data {
  const raw = JSON.parse(text)
  return { ...empty(), ...raw, agent: { ...empty().agent, ...raw.agent } }
}

export const backupsDir = (): string => path.join(dataDir(), 'backups')
const KEEP_BACKUPS = 20

export function listBackups(): string[] {
  if (!fs.existsSync(backupsDir())) return []
  return fs.readdirSync(backupsDir()).filter((f) => /^repodock-.*\.json$/.test(f)).sort().reverse().map((f) => path.join(backupsDir(), f))
}

/** Copies the data file into backups/ (on every launch, or on demand) and keeps the newest few. Returns true when a copy was written. */
export function backupData(): boolean {
  try {
    if (!fs.existsSync(file())) return false
    JSON.parse(fs.readFileSync(file(), 'utf8')) // only back up a readable file
    fs.mkdirSync(backupsDir(), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(file(), path.join(backupsDir(), `repodock-${stamp}.json`))
    for (const old of listBackups().slice(KEEP_BACKUPS)) fs.rmSync(old, { force: true })
    return true
  } catch (e) {
    console.error('[backup]', (e as Error).message)
    return false
  }
}

export function save(): void {
  const tmp = file() + '.tmp'
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2))
  fs.renameSync(tmp, file())
}

export const newId = (): string => crypto.randomUUID()

export function setToken(accountId: string, token: string | null): void {
  const d = load()
  if (!token) delete d.secrets[accountId]
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available; refusing to store token in plain text')
    d.secrets[accountId] = safeStorage.encryptString(token).toString('base64')
  }
}

export function getToken(accountId: string): string | null {
  const enc = load().secrets[accountId]
  if (!enc) return null
  return safeStorage.decryptString(Buffer.from(enc, 'base64'))
}
