import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Group, Repo, RepoSummary } from '../../../shared/types'
import { api } from '../api'
import { AccountBadge, ago, fullDate, useApp } from './ui'
import { GroupModal } from './Sidebar'
import { useMenu, type MenuEntry } from './menu'

/** What a repo needs from you, most urgent first. A repo shows up under every state that applies. */
type State = 'problem' | 'changes' | 'pull' | 'push' | 'clean'

const STATES: { id: State; label: string; hint: string }[] = [
  { id: 'problem', label: 'Problems', hint: 'Errors, conflicts, a missing folder, or no account to sign in with' },
  { id: 'changes', label: 'Uncommitted', hint: 'Files changed but not committed yet' },
  { id: 'pull', label: 'To pull', hint: 'New commits on the remote' },
  { id: 'push', label: 'To push', hint: 'Your commits that are not on the remote yet' },
  { id: 'clean', label: 'All good', hint: 'Committed, pushed and up to date' }
]

const changeCount = (s: RepoSummary) => s.staged + s.unstaged + s.untracked + s.conflicted

function statesOf(s: RepoSummary | undefined): State[] {
  if (!s) return []
  const out: State[] = []
  if (s.error || !s.exists || s.conflicted > 0 || (s.owner && !s.effectiveAccountId)) out.push('problem')
  if (changeCount(s) > 0) out.push('changes')
  if (s.behind > 0) out.push('pull')
  if (s.ahead > 0) out.push('push')
  if (!out.length) out.push('clean')
  return out
}

export function Dashboard({ open }: { open: (id: string) => void }) {
  const { state, summaries, act, reload, refreshSummaries, accountById, toast, busy } = useApp()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [acctFilter, setAcctFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [stateFilter, setStateFilter] = useState<State | null>(null)
  const [query, setQuery] = useState('')
  const [newGroupFor, setNewGroupFor] = useState<string[] | null>(null)
  const [openMenu, menu] = useMenu()

  const all = useMemo(() => state.repos.map((r) => ({ r, s: summaries[r.id], st: statesOf(summaries[r.id]) })), [state.repos, summaries])

  const counts = useMemo(() => {
    const c = { problem: 0, changes: 0, pull: 0, push: 0, clean: 0 } as Record<State, number>
    for (const x of all) for (const st of x.st) c[st]++
    return c
  }, [all])
  const needYou = all.filter((x) => x.st.length && !x.st.includes('clean')).length
  const loaded = all.filter((x) => x.s).length

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all
      .filter(({ s }) => !acctFilter || (acctFilter === 'none' ? !s?.effectiveAccountId : s?.effectiveAccountId === acctFilter))
      .filter(({ r }) => !groupFilter || (groupFilter === 'none' ? !r.groupId : r.groupId === groupFilter))
      .filter(({ st }) => !stateFilter || st.includes(stateFilter))
      .filter(({ r, s }) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q) || (s?.owner ?? '').toLowerCase().includes(q) || (s?.branch ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.r.name.localeCompare(b.r.name))
  }, [all, acctFilter, groupFilter, stateFilter, query])

  // Rows in sections, one per group (in sidebar order), then ungrouped.
  const sections = useMemo(() => {
    const list: { group: Group | null; rows: typeof rows }[] = state.groups.map((g) => ({ group: g, rows: rows.filter((x) => x.r.groupId === g.id) }))
    list.push({ group: null, rows: rows.filter((x) => !x.r.groupId || !state.groups.some((g) => g.id === x.r.groupId)) })
    return list.filter((sec) => sec.rows.length)
  }, [rows, state.groups])
  const ordered = useMemo(() => sections.flatMap((sec) => sec.rows), [sections])

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

  /** Click toggles one row; Shift+click selects the range from the last clicked row. */
  const clickRow = (id: string, shift: boolean) => {
    if (shift && anchor) {
      const ids = ordered.map((x) => x.r.id)
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
    const verb = { fetch: 'Fetch', pull: 'Pull', push: 'Push' }[op]
    if (failed.length) toast(`${verb}: ${res.length - failed.length} done, ${failed.length} failed\n` + failed.map((f) => `• ${nameOf(f.id)}: ${f.error!.split('\n')[0]}`).join('\n'), 'err')
    else toast(`${verb} done for ${res.length} repo${res.length === 1 ? '' : 's'}`)
    await refreshSummaries(ids)
  }

  const one = async (r: Repo, op: 'pull' | 'push') => {
    const acct = accountById(summaries[r.id]?.effectiveAccountId)
    await act(() => (op === 'pull' ? api.pull(r.id) : api.push(r.id)), `${op === 'pull' ? 'Pulled' : 'Pushed'} ${r.name}${acct ? ` as ${acct.login}` : ''}`)
    await refreshSummaries([r.id])
  }

  const moveTo = async (ids: string[], g: Group | null) => {
    await act(() => api.setRepoGroup(ids, g?.id ?? null), `Moved ${ids.length} repo${ids.length === 1 ? '' : 's'} to ${g?.name ?? 'Ungrouped'}`)
    await reload()
  }

  const setAccount = async (ids: string[], accountId: string | null) => {
    const a = accountById(accountId)
    await act(() => api.setReposAccount(ids, accountId), `${ids.length} repo${ids.length === 1 ? '' : 's'} now use ${a ? a.label : 'auto-detect'}`)
    await reload()
    await refreshSummaries(ids)
  }

  const removeRepos = async (ids: string[]) => {
    if (!confirm(`Remove ${ids.length === 1 ? nameOf(ids[0]) : `${ids.length} repos`} from RepoDock? Files on disk are not touched.`)) return
    await act(() => api.removeRepos(ids), `Removed ${ids.length} repo${ids.length === 1 ? '' : 's'}`)
    setSelected(new Set())
    await reload()
  }

  const rowMenu = (r: Repo, s: RepoSummary | undefined): MenuEntry[] => [
    { heading: r.name },
    { label: 'Open', onClick: () => open(r.id) },
    'sep',
    { label: 'Fetch', onClick: () => runBulk([r.id], 'fetch') },
    { label: s?.behind ? `Pull ${s.behind} commit${s.behind === 1 ? '' : 's'}` : 'Pull', onClick: () => one(r, 'pull') },
    { label: s?.ahead ? `Push ${s.ahead} commit${s.ahead === 1 ? '' : 's'}` : 'Push', onClick: () => one(r, 'push') },
    'sep',
    { heading: 'Move to group' },
    ...state.groups.filter((g) => g.id !== r.groupId).map((g): MenuEntry => ({ label: <><span className="dot" style={{ background: g.color }} /> {g.name}</>, onClick: () => moveTo([r.id], g) })),
    r.groupId && { label: <><span className="dot hollow" /> Ungrouped</>, onClick: () => moveTo([r.id], null) },
    { label: '+ New group…', onClick: () => setNewGroupFor([r.id]) },
    'sep',
    { label: 'Open folder', onClick: () => api.openPath(r.path) },
    s?.owner && { label: 'Open on GitHub', onClick: () => api.openExternal(`https://github.com/${s.owner}/${s.repoName}`) },
    { label: 'Copy path', onClick: () => navigator.clipboard.writeText(r.path) },
    'sep',
    { label: 'Remove from RepoDock…', danger: true, onClick: () => removeRepos([r.id]) }
  ]

  const sel = [...selected]
  const allChecked = rows.length > 0 && rows.every((x) => selected.has(x.r.id))
  const filtered = !!(acctFilter || groupFilter || stateFilter || query)
  const clearFilters = () => (setAcctFilter(''), setGroupFilter(''), setStateFilter(null), setQuery(''))

  // Health strip: one block per repo, most urgent first.
  const strip = useMemo(() => {
    const rank = (st: State[]) => (st.length ? Math.min(...st.map((x) => STATES.findIndex((y) => y.id === x))) : 99)
    return [...all].sort((a, b) => rank(a.st) - rank(b.st) || a.r.name.localeCompare(b.r.name))
  }, [all])

  return (
    <div className="page ov">
      <header className="ov-head">
        <div>
          <h2>Overview</h2>
          <p className="ov-summary">
            {!state.repos.length ? 'No repositories yet.'
              : loaded < state.repos.length ? `Reading ${state.repos.length} repositories…`
              : needYou === 0 ? <>All {state.repos.length} repositories are committed, pushed and up to date.</>
              : <><b>{needYou}</b> of {state.repos.length} repositories need your attention.</>}
          </p>
        </div>
        <div className="ov-head-actions">
          <button onClick={() => act(() => refreshSummaries(), 'Refreshed')} disabled={busy} title="Re-read every repository on disk">↻ Refresh</button>
          <button onClick={() => runBulk(state.repos.map((r) => r.id), 'fetch')} disabled={busy || !state.repos.length} title="Download the latest state of every remote. Nothing local changes.">⇣ Fetch all</button>
        </div>
      </header>

      {state.repos.length > 0 && (
        <section className="ov-health" aria-label="Repository health">
          <div className="ov-strip" role="list">
            {strip.map(({ r, s, st }) => {
              const main = st[0]
              const dim = stateFilter && !st.includes(stateFilter)
              return (
                <button
                  key={r.id}
                  role="listitem"
                  className={`ov-tick ${main ? 's-' + main : 's-loading'} ${dim ? 'dim' : ''}`}
                  title={`${r.name}\n${s ? describe(s) : 'Reading…'}`}
                  onClick={() => open(r.id)}
                />
              )
            })}
          </div>
          <div className="ov-chips" role="group" aria-label="Show only">
            {STATES.map((x) => (
              <button
                key={x.id}
                className={`ov-chip s-${x.id} ${stateFilter === x.id ? 'on' : ''}`}
                aria-pressed={stateFilter === x.id}
                disabled={!counts[x.id] && stateFilter !== x.id}
                title={x.hint}
                onClick={() => setStateFilter(stateFilter === x.id ? null : x.id)}
              >
                <i className="ov-swatch" />
                <b>{counts[x.id]}</b> {x.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {selected.size === 0 ? (
        <div className="ov-filters">
          <input className="ov-search" type="search" placeholder="Find a repo, owner or branch…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={acctFilter} onChange={(e) => setAcctFilter(e.target.value)} aria-label="Account">
            <option value="">All accounts</option>
            {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.login})</option>)}
            <option value="none">No account</option>
          </select>
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} aria-label="Group">
            <option value="">All groups</option>
            {state.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            <option value="none">Ungrouped</option>
          </select>
          {filtered && <button className="link" onClick={clearFilters}>Clear filters</button>}
          <span className="grow" />
          <span className="muted small-text">Showing {rows.length} of {state.repos.length} · click to select, Shift+click for a range, right-click for actions</span>
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
          <button disabled={busy} onClick={() => confirm(`Push ${selected.size} repo${selected.size === 1 ? '' : 's'}?`) && runBulk(sel, 'push')}>↑ Push</button>
          <span className="grow" />
          <button className="danger" onClick={() => removeRepos(sel)}>Remove from list</button>
        </div>
      )}

      <div className="table-wrap ov-table-wrap">
        <table className="table selectable ov-table">
          <thead>
            <tr>
              <th className="ov-check"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((x) => x.r.id)) : new Set())} /></th>
              <th className="ov-col-name">Repository</th>
              <th className="ov-col-branch">Branch</th>
              <th className="ov-col-wt">Working tree</th>
              <th className="ov-col-remote">Remote</th>
              <th className="ov-col-account">Signs in as</th>
              <th className="ov-col-commit">Last commit</th>
              <th className="ov-actions" aria-label="Actions" />
            </tr>
          </thead>
          {sections.map(({ group, rows: list }) => (
            <tbody key={group?.id ?? 'none'}>
              {sections.length > 1 || group ? (
                <tr className="ov-section">
                  <td colSpan={8}>
                    <span className="dot" style={group ? { background: group.color } : undefined} />
                    <b>{group?.name ?? 'Ungrouped'}</b>
                    <span className="muted">{list.length} repo{list.length === 1 ? '' : 's'}</span>
                    <SectionHealth items={list.map((x) => x.st)} />
                  </td>
                </tr>
              ) : null}
              {list.map(({ r, s, st }) => (
                <tr
                  key={r.id}
                  className={`ov-row ${selected.has(r.id) ? 'sel' : ''}`}
                  onClick={(e) => clickRow(r.id, e.shiftKey)}
                  onMouseDown={(e) => e.shiftKey && e.preventDefault() /* no text selection on shift+click */}
                  onDoubleClick={() => open(r.id)}
                  onContextMenu={(e) => openMenu(e, rowMenu(r, s))}
                >
                  <td className="ov-check"><i className={`ov-rail s-${st[0] ?? 'loading'}`} /><input type="checkbox" checked={selected.has(r.id)} readOnly aria-label={`Select ${r.name}`} /></td>
                  <td className="ov-name">
                    <a onClick={(e) => (e.stopPropagation(), open(r.id))}>{r.name}</a>
                    <div className="sub" title={r.path}>{s?.owner ? `${s.owner}/${s.repoName}` : s?.remoteUrl ? 'Remote outside GitHub' : 'Local only, no remote'}</div>
                  </td>
                  <td>{s?.branch ? <span className="ov-branch" title={s.upstream ? `Tracks ${s.upstream}` : 'Not linked to a remote branch'}>⎇ {s.branch}</span> : s ? <span className="warn-text" title="HEAD points at a commit, not a branch">No branch</span> : null}</td>
                  <td><WorkTree s={s} /></td>
                  <td><Sync s={s} /></td>
                  <td className="ov-col-account">
                    {s?.owner || r.accountId
                      ? s?.effectiveAccountId
                        ? <span title={r.accountId ? 'Chosen by hand in the repo header' : 'Matched automatically from the GitHub owner'}><AccountBadge account={accountById(s.effectiveAccountId)} /></span>
                        : <span className="err-text" title={`No account matches “${s?.owner}”. Add one in Accounts, or pick one in the repo header.`}>No matching account</span>
                      : <span className="muted">Not needed</span>}
                  </td>
                  <td className="ov-commit ov-col-commit" title={s?.lastCommit ? `${s.lastCommit.subject}\n${s.lastCommit.author}, ${fullDate(s.lastCommit.date)}` : ''}>
                    <div className="ov-commit-fill">
                      {s?.lastCommit ? <><div className="ellipsis">{s.lastCommit.subject}</div><div className="sub">{s.lastCommit.author}, {ago(s.lastCommit.date)}</div></> : <span className="muted">No commits yet</span>}
                    </div>
                  </td>
                  <td className="ov-actions" onClick={(e) => e.stopPropagation()}>
                    <div className="ov-actions-float">
                    {!!s?.behind && <button className="small" disabled={busy} onClick={() => one(r, 'pull')}>↓ Pull</button>}
                    {!!s?.ahead && <button className="small" disabled={busy} onClick={() => one(r, 'push')}>↑ Push</button>}
                    <button className="small" onClick={() => open(r.id)}>Open</button>
                    <button className="small icon-btn" onClick={(e) => openMenu(e, rowMenu(r, s))} aria-label="More actions">⋯</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        {!rows.length && (
          <div className="ov-empty">
            {state.repos.length
              ? <><b>No repositories match these filters.</b><button className="link" onClick={clearFilters}>Clear filters</button></>
              : <><b>Add your first repository.</b><span className="muted">Use <b>+ Add repo</b> for one folder, or <b>Import folder</b> to find every repo inside a folder.</span></>}
          </div>
        )}
      </div>
      {menu}
      {newGroupFor && (
        <GroupModal group={null} onClose={() => setNewGroupFor(null)} onCreated={(g) => moveTo(newGroupFor, g)} />
      )}
    </div>
  )
}

/** One-line description used in tooltips. */
function describe(s: RepoSummary): string {
  if (!s.exists) return 'Folder not found'
  if (s.error) return s.error.split('\n')[0]
  const parts: string[] = []
  if (s.conflicted) parts.push(`${s.conflicted} conflict${s.conflicted === 1 ? '' : 's'}`)
  const n = s.staged + s.unstaged + s.untracked
  if (n) parts.push(`${n} uncommitted change${n === 1 ? '' : 's'}`)
  if (s.behind) parts.push(`${s.behind} to pull`)
  if (s.ahead) parts.push(`${s.ahead} to push`)
  if (s.owner && !s.effectiveAccountId) parts.push('no matching account')
  return parts.join(', ') || 'Up to date'
}

function WorkTree({ s }: { s?: RepoSummary }) {
  if (!s) return <span className="muted">Reading…</span>
  if (!s.exists) return <span className="err-text">Folder not found</span>
  if (s.error) return <span className="err-text ellipsis" title={s.error}>Can’t read: {s.error.split('\n')[0]}</span>
  if (!changeCount(s)) return <span className="ok-text">✓ Clean</span>
  const parts: [number, string, string][] = [
    [s.conflicted, 'conflict', 'err-text'],
    [s.unstaged, 'changed', ''],
    [s.untracked, 'new', ''],
    [s.staged, 'staged', 'muted']
  ]
  return (
    <span className="ov-wt">
      {parts.filter(([n]) => n > 0).map(([n, label, cls]) => (
        <span key={label} className={cls}><b>{n}</b> {label}{label === 'conflict' && n !== 1 ? 's' : ''}</span>
      ))}
    </span>
  )
}

function Sync({ s }: { s?: RepoSummary }) {
  if (!s || !s.exists || s.error) return null
  if (!s.remoteUrl) return <span className="muted">No remote</span>
  if (!s.upstream) return <span className="muted" title="This branch has never been pushed. Push it to publish.">Not published</span>
  if (!s.ahead && !s.behind) return <span className="muted">Up to date</span>
  return (
    <span className="ov-sync">
      {s.behind > 0 && <span className="pull-text"><b>{s.behind}</b> to pull</span>}
      {s.ahead > 0 && <span className="accent-text"><b>{s.ahead}</b> to push</span>}
    </span>
  )
}

/** Small bar in a group header: how much of the group needs attention. */
function SectionHealth({ items }: { items: State[][] }) {
  const order: State[] = ['problem', 'changes', 'pull', 'push', 'clean']
  const main = items.map((st) => st[0]).filter(Boolean) as State[]
  if (!main.length) return null
  return (
    <span className="ov-mini" aria-hidden>
      {order.map((o) => {
        const n = main.filter((m) => m === o).length
        return n ? <i key={o} className={`s-${o}`} style={{ flexGrow: n }} /> : null
      })}
    </span>
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
