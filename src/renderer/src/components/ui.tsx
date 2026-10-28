import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Account, AppState, Group, RepoSummary } from '../../../shared/types'

// ---------- app context ----------

export interface Ctx {
  state: AppState
  summaries: Record<string, RepoSummary>
  reload: () => Promise<void>
  refreshSummaries: (ids?: string[]) => Promise<void>
  toast: (msg: string, kind?: 'ok' | 'err') => void
  /** Runs an async action, shows its error as a toast, and returns undefined on failure. */
  act: <T>(fn: () => Promise<T>, okMsg?: string) => Promise<T | undefined>
  busy: boolean
  accountById: (id: string | null | undefined) => Account | undefined
  groupById: (id: string | null | undefined) => Group | undefined
}

export const AppCtx = createContext<Ctx>(null!)
export const useApp = (): Ctx => useContext(AppCtx)

// ---------- small hooks ----------

/** Loads data with `fn` whenever deps change; exposes reload. Errors become toasts. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; reload: () => void; error: string | null } {
  const { toast } = useApp()
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    fn()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && (setError(e.message), toast(e.message, 'err')))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, loading, error, reload: useCallback(() => setTick((t) => t + 1), []) }
}

// ---------- formatting ----------

export function ago(ms: number | string): string {
  const t = typeof ms === 'string' ? Date.parse(ms) : ms
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  const units: [number, string][] = [[60, 'm'], [3600, 'h'], [86400, 'd'], [2592000, 'mo'], [31536000, 'y']]
  let label = ''
  for (const [sec, u] of units) if (s >= sec) label = `${Math.floor(s / sec)}${u}`
  return label + ' ago'
}

export const fullDate = (ms: number | string): string => new Date(ms).toLocaleString()

// ---------- components ----------

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

/** Unified diff with old/new line-number gutters. Git's header lines are reduced to short notes. */
export function Diff({ text }: { text: string }) {
  if (!text.trim()) return <div className="empty">No textual changes</div>
  const rows: { cls: string; a: number | ''; b: number | ''; text: string }[] = []
  const notes: string[] = []
  let a = 0
  let b = 0
  let inHunk = false
  for (const l of text.split('\n')) {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
    if (h) {
      a = Number(h[1])
      b = Number(h[2])
      inHunk = true
      rows.push({ cls: 'hunk', a: '', b: '', text: h[3].trim() ? `⋯ ${h[3].trim()}` : '⋯' })
    } else if (!inHunk) {
      if (/^(new file|deleted file|rename |similarity|old mode|new mode)/.test(l)) notes.push(l)
      else if (l.startsWith('Binary files')) notes.push('Binary file changed')
      else if (/^[^@]/.test(l) && !/^(diff |index |--- |\+\+\+ )/.test(l) && l.trim()) notes.push(l)
    } else if (l[0] === '+') rows.push({ cls: 'add', a: '', b: b++, text: l.slice(1) })
    else if (l[0] === '-') rows.push({ cls: 'del', a: a++, b: '', text: l.slice(1) })
    else if (l[0] === '\\') rows.push({ cls: 'meta', a: '', b: '', text: l.slice(2) })
    else if (l.startsWith('diff --git')) inHunk = false
    else rows.push({ cls: '', a: a++, b: b++, text: l.slice(1) })
  }
  // Drop the empty context row produced by the trailing newline of git output.
  while (rows.length && rows[rows.length - 1].cls === '' && !rows[rows.length - 1].text) rows.pop()
  return (
    <div className="diff">
      {notes.length > 0 && <div className="diff-notes">{notes.join(' · ')}</div>}
      {rows.length > 0 && (
        <table>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.cls}>
                <td className="ln">{r.a}</td>
                <td className="ln">{r.b}</td>
                <td className="sign">{r.cls === 'add' ? '+' : r.cls === 'del' ? '−' : ''}</td>
                <td className="txt">{r.text || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Splits a multi-file patch into per-file chunks keyed by the new path. */
export function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of patch.split(/^(?=diff --git )/m)) {
    const m = part.match(/^diff --git a\/(.*?) b\/(.*)$/m)
    if (m) out.set(m[2], (out.get(m[2]) ?? '') + part)
  }
  return out
}

const AVATAR_COLORS = ['#5b8def', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#39c5cf', '#f0883e', '#e5534b']

export function hashColor(s: string, palette = AVATAR_COLORS): string {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
  return palette[Math.abs(h) % palette.length]
}

/** Initials avatar coloured by email, so the same author is the same colour everywhere. */
export function Avatar({ name, email, size = 22 }: { name: string; email?: string; size?: number }) {
  const initials = name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?'
  return (
    <span className="avatar" title={email ? `${name} <${email}>` : name} style={{ width: size, height: size, fontSize: size * 0.42, background: hashColor(email || name) }}>
      {initials}
    </span>
  )
}

export function AccountBadge({ account, size = 18 }: { account?: Account; size?: number }) {
  if (!account) return <span className="badge muted">no account</span>
  return (
    <span className="acct-badge" title={`${account.label} (${account.login || 'unknown login'}) · ${methodLabel(account)}`}>
      {account.avatarUrl ? <img src={account.avatarUrl} width={size} height={size} /> : <span className="avatar-fallback" style={{ width: size, height: size }}>{(account.login || account.label)[0]?.toUpperCase()}</span>}
      <span>{account.login || account.label}</span>
    </span>
  )
}

export const methodLabel = (a: Account): string =>
  a.authMethod === 'token' ? 'HTTPS + token' : a.authMethod === 'ssh-auto' ? 'SSH (auto-uploaded)' : 'SSH (manual)'

export function Spinner() {
  return <span className="spinner" />
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={t.id === value ? 'active' : ''} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  )
}

export const GROUP_COLORS = ['#5b8def', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#39c5cf', '#f0883e', '#8b949e']
