import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// Remembers the window's size, position and maximized state, and makes sure it opens fully on a
// screen that exists now (monitors get unplugged, resolutions change, windows get dragged off-edge).

interface Saved {
  bounds: Rectangle
  maximized: boolean
}

const file = (): string => path.join(app.getPath('userData'), 'window.json')
const DEFAULT = { width: 1440, height: 900 }
const MIN = { width: 960, height: 600 }

function read(): Saved | null {
  try {
    const s = JSON.parse(fs.readFileSync(file(), 'utf8')) as Saved
    return s?.bounds && Number.isFinite(s.bounds.width) ? s : null
  } catch {
    return null
  }
}

/** Pulls a rectangle fully onto the work area of the screen it overlaps most (or the primary one). */
function fitOnScreen(b: Rectangle): Rectangle {
  const area = screen.getDisplayMatching(b).workArea
  const width = Math.max(MIN.width, Math.min(b.width, area.width))
  const height = Math.max(MIN.height, Math.min(b.height, area.height))
  const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

/** Options for new BrowserWindow: the last bounds, moved back on-screen if needed. */
export function initialBounds(): { bounds: Partial<Rectangle>; maximized: boolean } {
  const saved = read()
  if (!saved) {
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(DEFAULT.width, area.width)
    const height = Math.min(DEFAULT.height, area.height)
    return { bounds: { width, height, x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2) }, maximized: false }
  }
  return { bounds: fitOnScreen(saved.bounds), maximized: saved.maximized }
}

export function trackWindow(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return
      const s: Saved = { bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized() }
      try {
        fs.writeFileSync(file(), JSON.stringify(s))
      } catch {
        // not worth bothering the user about
      }
    }, 400)
  }
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize'] as const) win.on(ev as 'resize', save)
  win.on('close', () => {
    clearTimeout(timer)
    if (win.isMinimized()) return
    try {
      fs.writeFileSync(file(), JSON.stringify({ bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized() }))
    } catch {
      // ignore
    }
  })
}
