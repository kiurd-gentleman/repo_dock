import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Account, Group, Repo } from '../shared/types'

interface Data {
  accounts: Account[]
  groups: Group[]
  repos: Repo[]
  /** accountId -> token encrypted with the OS keychain (DPAPI on Windows), base64. */
  secrets: Record<string, string>
}

export const dataDir = (): string => app.getPath('userData')
export const keysDir = (): string => path.join(dataDir(), 'keys')
export const knownHostsFile = (): string => path.join(dataDir(), 'known_hosts')
const file = (): string => path.join(dataDir(), 'repodock.json')

let cache: Data | null = null

export function load(): Data {
  if (cache) return cache
  try {
    cache = { accounts: [], groups: [], repos: [], secrets: {}, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }
  } catch {
    cache = { accounts: [], groups: [], repos: [], secrets: {} }
  }
  return cache!
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
