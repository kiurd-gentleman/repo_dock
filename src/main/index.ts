import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { handlers } from './handlers'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'RepoDock',
    backgroundColor: '#0f1115',
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

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
