import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { applyTheme, handlers, themeBackground } from './handlers'
import { installHelper } from './agent/paths'
import { startBridge, stopBridge } from './agent/bridge'
import { repairClients } from './agent/clients'
import { refreshLinks } from './agent/gitlink'
import { backupData } from './store'
import { initUpdater } from './updater'

// Pin the data folder. Electron would otherwise name it after "productName" (RepoDock) in installed
// builds and "name" (repodock) in development; one fixed folder means every version, dev or
// installed, old or new, reads the same accounts, keys and repos.
app.setPath('userData', path.join(app.getPath('appData'), 'repodock'))

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'RepoDock',
    backgroundColor: themeBackground(),
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  // Links inside the UI open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

ipcMain.handle('rpc', async (_e, method: string, args: unknown[]) => {
  const fn = (handlers as Record<string, (...a: unknown[]) => unknown>)[method]
  if (typeof fn !== 'function') throw new Error(`Unknown method ${method}`)
  return fn(...args)
})

// One RepoDock at a time: the AI bridge pipe can only have one owner.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0]
  if (w) (w.isMinimized() && w.restore(), w.show(), w.focus())
})

// Apps started from Finder get a minimal PATH; add the usual git/ssh locations (Homebrew, MacPorts).
if (process.platform === 'darwin') process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'].filter(Boolean).join(':')

// Needed on Windows for notifications (AI approval requests) to show the app's name.
app.setAppUserModelId('com.repodock.app')

app.whenReady().then(() => {
  backupData()
  applyTheme()
  createWindow()
  initUpdater()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
  // Independent steps: one failing must not keep the others (especially the MCP server) from starting.
  const step = (name: string, fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      console.error(`[agent] ${name}:`, (e as Error).message)
    }
  }
  step('helper', installHelper)
  step('bridge', startBridge)
  if (app.isPackaged) step('clients', repairClients)
  step('git links', () => refreshLinks())
})

app.on('before-quit', () => stopBridge())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
