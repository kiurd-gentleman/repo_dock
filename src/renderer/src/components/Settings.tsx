import { useEffect, useState } from 'react'
import type { ThemeSetting, UpdateStatus } from '../../../shared/types'
import { api, onEvent } from '../api'
import { ago, fullDate, Spinner, useApp, useLoad } from './ui'

const REPO_URL = 'https://github.com/kiurd-gentleman/repo_dock'

/** Live update status, shared by the Settings page and the ⚙ dot in the sidebar. */
export function useUpdateStatus(): UpdateStatus | null {
  const [u, setU] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void api.updateStatus().then(setU)
    return onEvent<UpdateStatus>('update:status', setU)
  }, [])
  return u
}

export const updateFound = (u: UpdateStatus | null): boolean => u?.state === 'available' || u?.state === 'ready' || u?.state === 'downloading'

export function Settings() {
  return (
    <div className="page settings-page">
      <div className="page-head"><h2>Settings</h2></div>
      <div className="settings-col">
        <Appearance />
        <Updates />
        <DataSection />
        <About />
      </div>
    </div>
  )
}

const THEMES: { id: ThemeSetting; label: string; text: string }[] = [
  { id: 'light', label: 'Light', text: 'Always light' },
  { id: 'dark', label: 'Dark', text: 'Always dark' },
  { id: 'system', label: 'System', text: 'Follows your OS setting' }
]

function Appearance() {
  const { act } = useApp()
  const [theme, setTheme] = useState<ThemeSetting | null>(null)
  useEffect(() => void api.getTheme().then(setTheme), [])
  const pick = async (t: ThemeSetting) => {
    setTheme(t)
    await act(() => api.setTheme(t))
  }
  return (
    <section className="card set-card">
      <h3>Appearance</h3>
      <p className="hint">Theme for the whole app, including the window frame and menus.</p>
      <div className="theme-cards" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t.id} role="radio" aria-checked={theme === t.id} className={`theme-card ${theme === t.id ? 'sel' : ''}`} onClick={() => pick(t.id)}>
            <span className={`theme-preview tp-${t.id}`} aria-hidden>
              <i className="tp-side" /><i className="tp-line a" /><i className="tp-line b" /><i className="tp-line c" />
            </span>
            <span className="theme-label"><b>{t.label}</b><span className="sub">{t.text}</span></span>
          </button>
        ))}
      </div>
    </section>
  )
}

function Updates() {
  const { act } = useApp()
  const u = useUpdateStatus()
  if (!u) return null
  const isMac = navigator.platform.startsWith('Mac')
  const found = u.state === 'available' || u.state === 'ready'
  const dev = !u.autoInstall && !isMac
  const line =
    u.state === 'checking' ? 'Checking for updates…'
    : u.state === 'latest' ? `You're on the latest version${u.checkedAt ? ` · checked ${ago(u.checkedAt)}` : ''}`
    : u.state === 'available' ? `Version ${u.version} is available`
    : u.state === 'downloading' ? `Downloading version ${u.version ?? ''}… ${u.percent ?? 0}%`
    : u.state === 'ready' ? `Version ${u.version} is ready, restarting…`
    : u.state === 'error' ? `Couldn't check for updates: ${u.message ?? 'unknown error'}`
    : u.state === 'unsupported' ? u.message
    : 'Not checked yet'
  return (
    <section className={`card set-card ${found ? 'update-found' : ''}`}>
      <h3>Updates</h3>
      <div className="set-row">
        <div className="grow">
          <div><b>RepoDock {u.current}</b></div>
          <div className={`sub ${u.state === 'error' ? 'err-text' : found ? 'accent-text' : ''}`}>{line}</div>
          {u.state === 'downloading' && <span className="update-bar wide"><i style={{ width: `${u.percent ?? 0}%` }} /></span>}
        </div>
        {found ? (
          <button className="primary" disabled={u.state === 'ready'} onClick={() => act(() => api.installUpdate())}>{u.autoInstall ? 'Update now' : 'Download ↗'}</button>
        ) : (
          <button disabled={u.state === 'checking' || u.state === 'downloading'} onClick={() => act(() => api.checkForUpdates())}>⟳ Check for updates</button>
        )}
      </div>
      <p className="hint">
        RepoDock checks GitHub on startup and every 4 hours. <b>Update now</b> downloads the new version, installs it and restarts; your accounts, keys and repos stay as they are.
        {isMac && ' On macOS, unsigned apps cannot update themselves yet, so the download page opens instead.'}
        {dev && ' This is a development copy (npm run dev): checking works, but to install, download the new installer.'}
      </p>
      <div className="row">
        <button className="link" onClick={() => api.openExternal(`${REPO_URL}/releases`)}>What's new (release notes) ↗</button>
      </div>
    </section>
  )
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

function DataSection() {
  const { act } = useApp()
  const { data: info, reload } = useLoad(() => api.appInfo(), [])
  if (!info) return <section className="card set-card"><h3>Data &amp; backups</h3><Spinner /></section>
  const latest = info.backups[0]
  return (
    <section className="card set-card">
      <h3>Data &amp; backups</h3>
      <p className="hint">Accounts, SSH keys, repo list, groups and settings live in one folder. Every version of RepoDock uses it, and uninstalling or updating never deletes it.</p>
      <div className="set-row">
        <div className="grow"><div className="sub">Data folder</div><code className="path-code">{info.dataDir}</code></div>
        <button onClick={() => api.openPath(info.dataDir)}>Open folder</button>
      </div>
      <div className="set-row">
        <div className="grow">
          <div className="sub">Backups</div>
          <div>
            {info.backups.length
              ? <>{info.backups.length} saved (the newest 20 are kept) · latest <span title={fullDate(latest.date)}>{ago(latest.date)}</span>, {size(latest.size)}</>
              : 'No backups yet'}
          </div>
        </div>
        {info.backups.length > 0 && <button onClick={() => api.openPath(info.backupsDir)}>Open backups</button>}
        <button className="primary" onClick={() => act(() => api.backupNow(), 'Backup saved').then(reload)}>Back up now</button>
      </div>
      <p className="hint">A backup is also made automatically every time RepoDock starts. To restore one, close RepoDock and copy it over <code>repodock.json</code> in the data folder.</p>
    </section>
  )
}

function About() {
  const { data: info } = useLoad(() => api.appInfo(), [])
  const os = info ? ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[info.platform] ?? info.platform) : ''
  return (
    <section className="card set-card">
      <h3>About</h3>
      {info && (
        <table className="about-table">
          <tbody>
            <tr><td>RepoDock</td><td>{info.version}{!info.packaged && <span className="pill">development</span>}</td></tr>
            <tr><td>Git</td><td>{info.git ?? <span className="err-text">Not found: install Git and restart RepoDock</span>}</td></tr>
            <tr><td>System</td><td>{os} ({info.arch})</td></tr>
            <tr><td>Electron</td><td>{info.electron} · Chromium {info.chrome} · Node {info.node}</td></tr>
          </tbody>
        </table>
      )}
      <div className="row">
        <button onClick={() => api.openExternal(REPO_URL)}>GitHub repository ↗</button>
        <button onClick={() => api.openExternal(`${REPO_URL}/issues/new`)}>Report a problem ↗</button>
        {info && <button className="link" onClick={() => navigator.clipboard.writeText(`RepoDock ${info.version}\n${info.git ?? 'git not found'}\n${os} ${info.arch}\nElectron ${info.electron}`)}>Copy version info</button>}
      </div>
    </section>
  )
}
