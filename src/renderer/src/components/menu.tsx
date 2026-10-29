import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type MenuItem =
  | { label: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; hint?: string; title?: string }
  | 'sep'
  | { heading: string }

/** What a menu accepts: falsy entries (from `cond && item`) are skipped. */
export type MenuEntry = MenuItem | false | null | undefined | '' | 0

/** Drops separators that would end up first, last or doubled after items were filtered out. */
const tidy = (items: MenuEntry[]): MenuItem[] => {
  const out: MenuItem[] = []
  for (const it of items) {
    if (!it) continue
    if (it === 'sep' && (!out.length || out[out.length - 1] === 'sep')) continue
    out.push(it)
  }
  while (out[out.length - 1] === 'sep') out.pop()
  return out
}

/**
 * One menu at a time, opened at the mouse (right-click) or under a button.
 * Usage: const [openMenu, menu] = useMenu(); <div onContextMenu={(e) => openMenu(e, items)}> … {menu}
 */
export function useMenu(): [(e: React.MouseEvent, items: MenuEntry[]) => void, ReactNode] {
  const [state, setState] = useState<{ x: number; y: number; below?: DOMRect; items: MenuItem[] } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setState(null), [])

  const open = useCallback((e: React.MouseEvent, items: MenuEntry[]) => {
    e.preventDefault()
    e.stopPropagation()
    const isButton = e.type === 'click'
    const rect = isButton ? (e.currentTarget as HTMLElement).getBoundingClientRect() : undefined
    setState({ x: rect ? rect.left : e.clientX, y: rect ? rect.bottom + 4 : e.clientY, below: rect, items: tidy(items) })
  }, [])

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !state) return
    const r = el.getBoundingClientRect()
    let { x, y } = state
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, (state.below ? state.below.right : x) - r.width)
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, (state.below ? state.below.top - 4 : y) - r.height)
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.visibility = 'visible'
  }, [state])

  useEffect(() => {
    if (!state) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [state, close])

  const node = state && (
    <div className="menu ctx-menu" ref={ref} role="menu" style={{ left: state.x, top: state.y, visibility: 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      {state.items.map((it, i) =>
        it === 'sep' ? <hr key={i} />
        : 'heading' in it ? <div key={i} className="menu-heading">{it.heading}</div>
        : (
          <button
            key={i}
            role="menuitem"
            className={it.danger ? 'danger-item' : ''}
            disabled={it.disabled}
            title={it.title}
            onClick={() => (close(), it.onClick())}
          >
            <span className="grow">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        )
      )}
    </div>
  )
  return [open, node]
}
