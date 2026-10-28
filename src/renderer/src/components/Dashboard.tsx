import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Group } from '../../../shared/types'
import { api } from '../api'
import { AccountBadge, ago, fullDate, useApp } from './ui'
import { GroupModal } from './Sidebar'

export function Dashboard({ open }: { open: (id: string) => void }) {
  const { state, summaries, act, reload, refreshSummaries, accountById, groupById, toast, busy } = useApp()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [acctFilter, setAcctFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [onlyDirty, setOnlyDirty] = useState(false)
  const [newGroupFor, setNewGroupFor] = useState<string[] | null>(null)

  const rows = useMemo(() => state.repos
    .map((r) => ({ r, s: summaries[r.id] }))
    .filter(({ s }) => !acctFilter || (acctFilter === 'none' ? !s?.effectiveAccountId : s?.effectiveAccountId === acctFilter))
    .filter(({ r }) => !groupFilter || (groupFilter === 'none' ? !r.groupId : r.groupId === groupFilter))
    .filter(({ s }) => !onlyDirty || (s && (s.staged + s.unstaged + s.untracked + s.conflicted + s.ahead + s.behind > 0)))
    .sort((a, b) => a.r.name.localeCompare(b.r.name)), [state.repos, summaries, acctFilter, groupFilter, onlyDirty])

  // Drop selections that are no longer visible (filtered out or removed).
  useEffect(() => {
    const visible = new Set(rows.map((x) => x.r.id))
    setSelected((s) => ([...s].every((id) => visible.has(id)) ? s : new Set([...s].filter((id) => visible.has(id)))))
  }, [rows])

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal, .menu') && setSelected(new Set())
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const totals = useMemo(() => {
    const all = Object.values(summaries)
    return {
      dirty: all.filter((s) => s.staged + s.unstaged + s.untracked + s.conflicted > 0).length,
      ahead: all.filter((s) => s.ahead > 0).length,
      behind: all.filter((s) => s.behind > 0).length,
      unlinked: all.filter((s) => s.owner && !s.effectiveAccountId).length
    }
  }, [summaries])

  /** Click toggles one row; Shift+click selects the range from the last clicked row. */
  const clickRow = (id: string, shift: boolean) => {
    if (shift && anchor) {
      const ids = rows.map((x) => x.r.id)
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y)
      if (a >= 0) {
        setSelected((s) => new Set([...s, ...ids.slice(a, b + 1)]))
        return
      }
    }
    setAnchor(id)
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  const nameOf = (id: string) => state.repos.find((r) => r.id === id)?.name ?? id

  const runBulk = async (ids: string[], op: 'fetch' | 'pull' | 'push') => {
    const res = await act(() => api.bulk(ids, op))
    if (!res) return
    const failed = res.filter((r) => r.error)
    if (failed.length) toast(`${op}: ${res.length - failed.length} ok, ${failed.length} failed\n` + failed.map((f) => `• ${nameOf(f.id)}: ${f.error!.split('\n')[0]}`).join('\n'), 'err')
    else toast(`${op} finished for ${res.length} repo(s)`)
    await refreshSummaries(ids)
  }

  const moveTo = async (ids: string[], g: Group | null) => {
    await act(() => api.setRepoGroup(ids, g?.id ?? null), `Moved ${ids.length} repo(s) to ${g?.name ?? 'Ungrouped'}`)
    await reload()
  }

  const setAccount = async (ids: string[], accountId: string | null) => {
    const a = accountById(accountId)
    await act(() => api.setReposAccount(ids, accountId), `${ids.length} repo(s) now use ${a ? a.label : 'auto-detect'}`)
    await reload()
    await refreshSummaries(ids)
  }

  const bulkRemove = async () => {
    if (!confirm(`Remove ${selected.size} repo(s) from RepoDock? Files on disk are not touched.`)) return
    await act(() => api.removeRepos([...selected]), `Removed ${selected.size} repo(s)`)
    setSelected(new Set())
    await reload()
  }

  const sel = [...selected]
  const allChecked = rows.length > 0 && rows.every((x) => selected.has(x.r.id))

  return (
    <div className="page">
      <div className="page-head">
        <h2>Overview</h2>
        <div className="stats">
          <span><b>{state.repos.length}</b> repos</span>
          <a onClick={() => setOnlyDirty(true)}><b>{totals.dirty}</b> with uncommitted changes</a>
          <span><b>{totals.ahead}</b> to push</span>
          <span><b>{totals.behind}</b> to pull</span>
          {totals.unlinked > 0 && <a className="warn-text" onClick={() => setAcctFilter('none')}><b>{totals.unlinked}</b> without a matching account</a>}
        </div>
      </div>

      {selected.size === 0 ? (
        <div className="toolbar">
          <button onClick={() => act(() => refreshSummaries(), 'Refreshed')} disabled={busy}>↻ Refresh</button>
          <button onClick={() => runBulk(state.repos.map((r) => r.id), 'fetch')} disabled={busy}>⇣ Fetch all</button>
          <select value={acctFilter} onChange={(e) => setAcctFilter(e.target.value)}>
            <option value="">All accounts</option>
            {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.login})</option>)}
            <option value="none">No account</option>
          </select>
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            <option value="">All groups</option>
            {state.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            <option value="none">Ungrouped</option>
          </select>
          <label className="check"><input type="checkbox" checked={onlyDirty} onChange={(e) => setOnlyDirty(e.target.checked)} /> Only repos needing attention</label>
          <span className="grow" />
          <span className="muted">Click rows to select · Shift+click for a range</span>
        </div>
      ) : (
        <div className="toolbar bulk-bar">
          <b>{selected.size} selected</b>
          <button className="link" onClick={() => setSelected(new Set())}>Clear</button>
          <span className="sep" />
          <Menu label="Move to group">
            {(close) => <>
              {state.groups.map((g) => (
                <button key={g.id} onClick={() => (close(), moveTo(sel, g))}><span className="dot" style={{ background: g.color }} /> {g.name}</button>
              ))}
              <button onClick={() => (close(), moveTo(sel, null))}><span className="dot hollow" /> Ungrouped</button>
              <hr />
              <button onClick={() => (close(), setNewGroupFor(sel))}>+ New group…</button>
            </>}
          </Menu>
          <Menu label="Set account">
            {(close) => <>
              <button onClick={() => (close(), setAccount(sel, null))}>Auto-detect from remote</button>
              {state.accounts.map((a) => (
                <button key={a.id} onClick={() => (close(), setAccount(sel, a.id))}><AccountBadge account={a} size={16} /> <span className="muted">{a.label}</span></button>
              ))}
              {!state.accounts.length && <div className="menu-empty">No accounts yet</div>}
            </>}
          </Menu>
          <span className="sep" />
          <button disabled={busy} onClick={() => runBulk(sel, 'fetch')}>⇣ Fetch</button>
          <button disabled={busy} onClick={() => runBulk(sel, 'pull')}>↓ Pull</button>
          <button disabled={busy} onClick={() => confirm(`Push ${selected.size} repo(s)?`) && runBulk(sel, 'push')}>↑ Push</button>
          <span className="grow" />
          <button className="danger" onClick={bulkRemove}>Remove from list</button>
        </div>
      )}

      <div className="table-wrap">
        <table className="table selectable">
          <thead>
            <tr>
              <th><input type="checkbox" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((x) => x.r.id)) : new Set())} /></th>
              <th>Repository</th><th>Group</th><th>Account</th><th>GitHub</th><th>Branch</th><th>Changes</th><th>Sync</th><th>Last commit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, s }) => {
              const g = groupById(r.groupId)
              return (
                <tr
                  key={r.id}
                  className={selected.has(r.id) ? 'sel' : ''}
                  onClick={(e) => clickRow(r.id, e.shiftKey)}
                  onMouseDown={(e) => e.shiftKey && e.preventDefault() /* no text selection on shift+click */}
                  onDoubleClick={() => open(r.id)}
                >
                  <td><input type="checkbox" checked={selected.has(r.id)} readOnly /></td>
                  <td><a onClick={(e) => (e.stopPropagation(), open(r.id))}>{r.name}</a><div className="sub">{r.path}</div></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Menu
                      className="group-pill"
                      style={g ? { borderColor: g.color, color: g.color } : undefined}
                      label={g ? <><span className="dot" style={{ background: g.color }} /> {g.name}</> : <span className="muted">No group</span>}
                    >
                      {(close) => <>
                        {state.groups.map((x) => (
                          <button key={x.id} className={x.id === r.groupId ? 'current' : ''} onClick={() => (close(), x.id !== r.groupId && moveTo([r.id], x))}>
                            <span className="dot" style={{ background: x.color }} /> {x.name} {x.id === r.groupId && <span className="check-mark">✓</span>}
                          </button>
                        ))}
                        {r.groupId && <button onClick={() => (close(), moveTo([r.id], null))}><span className="dot hollow" /> Remove from group</button>}
                        <hr />
                        <button onClick={() => (close(), setNewGroupFor([r.id]))}>+ New group…</button>
                      </>}
                    </Menu>
                  </td>
                  <td>{s?.owner || r.accountId ? <AccountBadge account={accountById(s?.effectiveAccountId)} /> : <span className="muted">local only</span>}{r.accountId && <span className="sub"> (manual)</span>}</td>
                  <td>{s?.owner ? `${s.owner}/${s.repoName}` : <span className="muted">{s?.remoteUrl ? 'non-GitHub' : 'no remote'}</span>}</td>
                  <td>{s?.error ? <span className="err-text" title={s.error}>error</span> : s?.branch ?? <span className="muted">detached</span>}</td>
                  <td>
                    {s && (s.staged + s.unstaged + s.untracked + s.conflicted === 0 ? <span className="ok-text">clean</span> : (
                      <span className="changes">
                        {s.staged > 0 && <span title="staged">●{s.staged}</span>}
                        {s.unstaged > 0 && <span title="modified">✎{s.unstaged}</span>}
                        {s.untracked > 0 && <span title="untracked">+{s.untracked}</span>}
                        {s.conflicted > 0 && <span className="err-text" title="conflicts">⚠{s.conflicted}</span>}
                      </span>
                    ))}
                  </td>
                  <td>{s?.upstream ? <>{s.ahead > 0 && <span className="pill">↑{s.ahead}</span>} {s.behind > 0 && <span className="pill">↓{s.behind}</span>} {!s.ahead && !s.behind && <span className="muted">up to date</span>}</> : <span className="muted">no upstream</span>}</td>
                  <td title={s?.lastCommit ? fullDate(s.lastCommit.date) : ''}>{s?.lastCommit ? <>{s.lastCommit.subject.slice(0, 60)}<div className="sub">{s.lastCommit.author} · {ago(s.lastCommit.date)}</div></> : <span className="muted">—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && <div className="empty">Nothing to show. Use “Add repo” or “Import folder” in the sidebar.</div>}
      </div>
      {newGroupFor && (
        <GroupModal group={null} onClose={() => setNewGroupFor(null)} onCreated={(g) => moveTo(newGroupFor, g)} />
      )}
    </div>
  )
}

/** Small dropdown menu that closes on outside click or Escape. */
function Menu({ label, children, className, style }: { label: ReactNode; children: (close: () => void) => ReactNode; className?: string; style?: CSSProperties }) {
  // Fixed position computed from the button so the menu is never clipped by the scrolling table.
  const [pos, setPos] = useState<CSSProperties | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => setPos(null)
  useEffect(() => {
    if (!pos) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [pos])
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (pos) return close()
    const r = e.currentTarget.getBoundingClientRect()
    const openUp = window.innerHeight - r.bottom < 260 && r.top > 260
    setPos(openUp ? { left: r.left, bottom: window.innerHeight - r.top + 4 } : { left: r.left, top: r.bottom + 4 })
  }
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`${className ?? ''} ${pos ? 'active' : ''}`} style={style} onClick={toggle}>{label} <span className="caret-down">▾</span></button>
      {pos && <div className="menu" style={pos}>{children(close)}</div>}
    </div>
  )
}
