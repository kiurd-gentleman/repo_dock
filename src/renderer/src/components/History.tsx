import { useEffect, useMemo, useRef, useState } from 'react'
import type { Commit, CommitDetail, Repo } from '../../../shared/types'
import { api } from '../api'
import { Avatar, Diff, Spinner, ago, fullDate, splitPatch, useApp, useLoad } from './ui'

const PAGE = 150
const ROW_H = 52
const LANE_W = 14
const LANE_COLORS = ['#5b8def', '#3fb950', '#f778ba', '#d29922', '#a371f7', '#39c5cf', '#f0883e', '#e5534b']
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length]

interface GraphRow {
  col: number
  /** Lanes entering the row from above: [fromLane, toLane] (toLane === col when they end at this commit). */
  top: [number, number][]
  /** Lanes leaving the row downwards: [fromLane, toLane]. */
  bottom: [number, number][]
  width: number
  merge: boolean
}

/**
 * Classic lane assignment: each lane "waits" for a commit sha. A commit takes the lane waiting for it
 * (or a free one), hands that lane to its first parent and opens/joins lanes for any other parents.
 */
function buildGraph(commits: Commit[]): GraphRow[] {
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  const free = () => {
    const i = lanes.indexOf(null)
    return i === -1 ? lanes.length : i
  }
  for (const c of commits) {
    // Lines coming in from above: lanes waiting for this commit bend into it, the rest pass straight through.
    const top: [number, number][] = []
    let col = lanes.indexOf(c.sha)
    if (col === -1) col = free() // branch tip nobody was waiting for: no line above
    lanes.forEach((s, i) => s !== null && top.push([i, s === c.sha ? col : i]))
    lanes.forEach((s, i) => s === c.sha && (lanes[i] = null))

    // Lines going down: first parent continues in this lane, other parents join or open lanes.
    const bottom: [number, number][] = []
    const passing = lanes.map((s, i) => (s !== null ? i : -1)).filter((i) => i >= 0)
    lanes[col] = c.parents[0] ?? null
    if (lanes[col]) bottom.push([col, col])
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p)
      if (k === -1) lanes[(k = free())] = p
      bottom.push([col, k])
    }
    for (const i of passing) bottom.push([i, i])
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const width = Math.max(col + 1, ...top.flat().map((x) => x + 1), ...bottom.flat().map((x) => x + 1))
    rows.push({ col, top, bottom, width, merge: c.parents.length > 1 })
  }
  return rows
}

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const x = (i: number) => i * LANE_W + LANE_W / 2 + 2
  const mid = ROW_H / 2
  const curve = (x1: number, y1: number, x2: number, y2: number) =>
    x1 === x2 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`
  return (
    <svg className="graph" width={width * LANE_W + 4} height={ROW_H}>
      {row.top.map(([f, t], i) => (
        <path key={'t' + i} d={f === t && t !== row.col ? `M${x(f)},0 L${x(f)},${mid}` : curve(x(f), 0, x(t), mid)} stroke={laneColor(f)} />
      ))}
      {row.bottom.map(([f, t], i) => (
        <path key={'b' + i} d={f === t ? `M${x(f)},${mid} L${x(f)},${ROW_H}` : curve(x(f), mid, x(t), ROW_H)} stroke={laneColor(f === row.col ? t : f)} />
      ))}
      <circle cx={x(row.col)} cy={mid} r={row.merge ? 4 : 5} fill={row.merge ? 'var(--panel)' : laneColor(row.col)} stroke={laneColor(row.col)} strokeWidth={2} />
    </svg>
  )
}

function RefChips({ refs }: { refs: string }) {
  if (!refs) return null
  return (
    <>
      {refs.split(', ').map((r) => {
        const head = r.startsWith('HEAD -> ')
        const name = r.replace('HEAD -> ', '').replace('tag: ', '')
        const kind = head ? 'head' : r.startsWith('tag:') ? 'tagref' : r.includes('/') ? 'remote' : 'local'
        return <span key={r} className={`ref ${kind}`} title={r}>{kind === 'tagref' ? '🏷 ' : head ? '● ' : kind === 'remote' ? '☁ ' : '⎇ '}{name}</span>
      })}
    </>
  )
}

export function History({ repo, version }: { repo: Repo; version: number }) {
  const { toast } = useApp()
  const [all, setAll] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [commits, setCommits] = useState<Commit[]>([])
  const [more, setMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  // Optional decoration: never surface an error for it.
  const { data: unpushedList } = useLoad(() => api.unpushed(repo.id).catch(() => [] as string[]), [repo.id, version])
  const unpushed = useMemo(() => new Set(unpushedList ?? []), [unpushedList])

  const loadPage = async (skip: number) => {
    setLoading(true)
    try {
      const page = await api.log(repo.id, { skip, limit: PAGE, all, search: query || undefined })
      setCommits((c) => (skip ? [...c, ...page] : page))
      setMore(page.length === PAGE)
      if (!skip && page[0]) setSel((s) => (s && page.some((c) => c.sha === s) ? s : page[0].sha))
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.id, all, query, version])

  // A graph only makes sense for an unfiltered, connected history.
  const graph = useMemo(() => (query ? null : buildGraph(commits)), [commits, query])
  const graphWidth = graph ? Math.min(Math.max(1, ...graph.map((r) => r.width)), 12) : 0

  // Arrow keys move through the list.
  const listRef = useRef<HTMLDivElement>(null)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = commits.findIndex((c) => c.sha === sel)
    const next = commits[Math.max(0, Math.min(commits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      setSel(next.sha)
      listRef.current?.querySelector(`[data-sha="${next.sha}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }

  return (
    <div className="split">
      <div className="split-left wide history-left">
        <div className="toolbar compact">
          <input className="grow" placeholder="Search commit messages… (Enter)" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setQuery(search)} />
          {query && <button className="link" onClick={() => (setSearch(''), setQuery(''))}>Clear</button>}
          <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All branches</label>
        </div>
        <div className="commit-list graph-list" ref={listRef} tabIndex={0} onKeyDown={onKey}>
          {commits.map((c, i) => (
            <div key={c.sha} data-sha={c.sha} className={`commit-row ${sel === c.sha ? 'active' : ''}`} style={{ height: ROW_H }} onClick={() => setSel(c.sha)}>
              {graph && <GraphCell row={graph[i]} width={graphWidth} />}
              <Avatar name={c.author} email={c.email} />
              <div className="commit-main">
                <div className="commit-subject">
                  <RefChips refs={c.refs} />
                  <span className={c.parents.length > 1 ? 'muted' : ''}>{c.subject}</span>
                </div>
                <div className="sub">
                  <code>{c.shortSha}</code> · {c.author} · <span title={fullDate(c.date)}>{ago(c.date)}</span>
                  {unpushed.has(c.sha) && <span className="unpushed" title="This commit is not on the remote yet">↑ not pushed</span>}
                </div>
              </div>
            </div>
          ))}
          {loading && <Spinner />}
          {!loading && more && commits.length > 0 && <button className="link load-more" onClick={() => loadPage(commits.length)}>Load {PAGE} more…</button>}
          {!loading && !commits.length && <div className="empty small">{query ? 'No commits match' : 'No commits yet'}</div>}
        </div>
      </div>
      <div className="split-right">
        <CommitPanel repo={repo} sha={sel} onSelect={setSel} unpushed={sel ? unpushed.has(sel) : false} />
      </div>
    </div>
  )
}

function CommitPanel({ repo, sha, onSelect, unpushed }: { repo: Repo; sha: string | null; onSelect: (s: string) => void; unpushed: boolean }) {
  const { toast } = useApp()
  const { data: d, loading } = useLoad(async () => (sha ? api.showCommit(repo.id, sha) : null), [repo.id, sha])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setCollapsed({})
    scrollRef.current?.scrollTo({ top: 0 })
  }, [sha])

  if (!sha) return <div className="empty">Select a commit</div>
  if (loading || !d) return <Spinner />

  const patches = splitPatch(d.patch)
  const adds = d.files.reduce((n, f) => n + (f.additions || 0), 0)
  const dels = d.files.reduce((n, f) => n + (f.deletions || 0), 0)
  const body = d.body.split('\n').slice(1).join('\n').trim()
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`))
  const jump = (path: string) => document.getElementById(fileId(path))?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="commit-panel" ref={scrollRef}>
      <div className="commit-card">
        <div className="commit-title">
          <h3>{d.subject}</h3>
          <div className="chips"><RefChips refs={d.refs} />{unpushed && <span className="unpushed">↑ not pushed</span>}</div>
        </div>
        {body && <pre className="body">{body}</pre>}
        <div className="commit-meta">
          <Avatar name={d.author} email={d.email} size={34} />
          <div className="grow">
            <div><b>{d.author}</b> <span className="muted">&lt;{d.email}&gt;</span></div>
            <div className="sub">committed {ago(d.date)} · {fullDate(d.date)}</div>
          </div>
          <div className="sha-box">
            <button className="sha" onClick={() => copy(d.sha, 'Commit id')} title="Copy full commit id"><code>{d.sha.slice(0, 10)}</code> ⧉</button>
            {d.parents.length > 0 && (
              <div className="sub">
                {d.parents.length > 1 ? 'parents ' : 'parent '}
                {d.parents.map((p) => <a key={p} onClick={() => onSelect(p)}><code>{p.slice(0, 7)}</code> </a>)}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="stat-line">
        <b>{d.files.length}</b> file{d.files.length === 1 ? '' : 's'} changed
        <span className="add-text">+{adds}</span>
        <span className="del-text">−{dels}</span>
        <StatBar add={adds} del={dels} />
        {d.parents.length > 1 && <span className="muted">· compared with first parent</span>}
        <span className="grow" />
        <button className="link" onClick={() => setCollapsed(Object.fromEntries(d.files.map((f) => [f.path, true])))}>Collapse all</button>
        <button className="link" onClick={() => setCollapsed({})}>Expand all</button>
      </div>

      <div className="file-table">
        {d.files.map((f) => <FileRow key={f.path} f={f} onClick={() => jump(f.path)} />)}
      </div>

      {d.files.map((f) => {
        const p = patches.get(f.path) ?? ''
        const isCollapsed = collapsed[f.path]
        return (
          <div key={f.path} id={fileId(f.path)} className="file-diff">
            <div className="file-diff-head" onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))}>
              <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
              <StatusBadge s={f.status} />
              <PathLabel path={f.path} oldPath={f.oldPath} />
              <span className="grow" />
              {!f.binary && <><span className="add-text">+{f.additions}</span><span className="del-text">−{f.deletions}</span></>}
              <button className="icon small" title="Copy path" onClick={(e) => (e.stopPropagation(), copy(f.path, 'Path'))}>⧉</button>
            </div>
            {!isCollapsed && (f.binary ? <div className="diff-notes">Binary file</div> : <Diff text={p} />)}
          </div>
        )
      })}
      {d.truncated && <div className="empty small">Diff is very large and was truncated.</div>}
    </div>
  )
}

const fileId = (p: string) => 'f-' + p.replace(/[^a-z0-9]/gi, '_')

const STATUS: Record<string, [string, string]> = { A: ['added', 'A'], M: ['modified', 'M'], D: ['deleted', 'D'], R: ['renamed', 'R'], C: ['copied', 'C'], T: ['type', 'T'] }

function StatusBadge({ s }: { s: string }) {
  const [title, letter] = STATUS[s] ?? [s, s]
  return <span className={`status-badge s-${letter}`} title={title}>{letter}</span>
}

function PathLabel({ path, oldPath }: { path: string; oldPath?: string }) {
  const i = path.lastIndexOf('/')
  return (
    <span className="path-label" title={oldPath ? `${oldPath} → ${path}` : path}>
      {oldPath && <span className="muted">{oldPath} → </span>}
      <span className="muted">{i >= 0 ? path.slice(0, i + 1) : ''}</span>
      <b>{path.slice(i + 1)}</b>
    </span>
  )
}

function FileRow({ f, onClick }: { f: CommitDetail['files'][number]; onClick: () => void }) {
  return (
    <div className="file-row" onClick={onClick}>
      <StatusBadge s={f.status} />
      <PathLabel path={f.path} oldPath={f.oldPath} />
      <span className="grow" />
      {f.binary ? <span className="muted">binary</span> : <>
        <span className="add-text">+{f.additions}</span>
        <span className="del-text">−{f.deletions}</span>
        <StatBar add={f.additions} del={f.deletions} />
      </>}
    </div>
  )
}

/** GitHub-style five-block bar showing the add/delete ratio. */
function StatBar({ add, del }: { add: number; del: number }) {
  const total = add + del
  const g = total ? Math.round((add / total) * 5) : 0
  const r = total ? 5 - g : 0
  return (
    <span className="stat-bar">
      {Array.from({ length: 5 }, (_, i) => <i key={i} className={i < g ? 'g' : i < g + r ? 'r' : ''} />)}
    </span>
  )
}
