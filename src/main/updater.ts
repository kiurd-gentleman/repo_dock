import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

// Updates come from the GitHub Releases of the repo in package.json → build.publish. CI uploads
// latest*.yml next to the installers; electron-updater reads those to find newer versions.

const RELEASES = 'https://github.com/kiurd-gentleman/repo_dock/releases/latest'
const LATEST_API = 'https://api.github.com/repos/kiurd-gentleman/repo_dock/releases/latest'
const CHECK_EVERY = 4 * 60 * 60 * 1000

let installAfterDownload = false

function set(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('event', 'update:status', status)
}

/** macOS refuses to auto-install unsigned apps, so there the button opens the download page instead. */
const canInstall = (): boolean => app.isPackaged && process.platform !== 'darwin'

let status: UpdateStatus = { state: 'idle', current: app.getVersion(), autoInstall: canInstall() }

export const updateStatus = (): UpdateStatus => status

export function initUpdater(): void {
  if (!app.isPackaged) return // development: checks go straight to the GitHub API, see checkForUpdates
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', message: undefined }))
  autoUpdater.on('update-available', (i) => set({ state: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => set({ state: 'latest', checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => {
    set({ state: 'ready', version: i.version, percent: 100 })
    if (installAfterDownload) setTimeout(() => autoUpdater.quitAndInstall(true, true), 800)
  })
  autoUpdater.on('error', (e) => {
    installAfterDownload = false
    set({ state: 'error', message: String(e?.message ?? e).split('\n')[0] })
  })
  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 10_000)
  setInterval(check, CHECK_EVERY)
}

/** 1.2.10 > 1.2.9; a leading v and any -suffix are ignored. */
function newer(a: string, b: string): boolean {
  const p = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0)
  const [x, y] = [p(a), p(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** Development builds can't install updates, but can still tell whether a newer release exists. */
async function checkGitHub(): Promise<void> {
  set({ state: 'checking', message: undefined })
  try {
    const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RepoDock' } })
    if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`)
    const tag = String((await res.json()).tag_name ?? '')
    if (tag && newer(tag, app.getVersion())) set({ state: 'available', version: tag.replace(/^v/, '') })
    else set({ state: 'latest', checkedAt: Date.now() })
  } catch (e) {
    set({ state: 'error', message: (e as Error).message })
    throw e
  }
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    await checkGitHub()
    return status
  }
  await autoUpdater.checkForUpdates()
  return status
}

/** Downloads the new version (if needed), then restarts into it. Data in the app folder is untouched. */
export async function installUpdate(): Promise<void> {
  if (!canInstall()) {
    await shell.openExternal(RELEASES)
    return
  }
  if (status.state === 'ready') return autoUpdater.quitAndInstall(true, true)
  installAfterDownload = true
  set({ state: 'downloading', percent: 0 })
  await autoUpdater.downloadUpdate()
}
