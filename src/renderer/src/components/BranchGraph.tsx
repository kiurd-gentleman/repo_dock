import { useEffect, useMemo, useState } from 'react'
import type { Commit, Repo } from '../../../shared/types'
import { api } from '../api'
import { Avatar, Spinner, ago, fullDate, useApp } from './ui'

// The commit graph of every branch. It used to sit behind the History list; it lives in Branches → Graph now.

const ROW_H = 44
const PAGE = 200
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

export function RefChips({ refs }: { refs: string }) {
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


export function BranchGraph({ repo, version }: { repo: Repo; version: number }) {
  const { toast } = useApp()
  const [commits, setCommits] = useState<Commit[]>([])
  const [more, setMore] = useState(true)
  const [loading, setLoading] = useState(false)

  const load = async (skip: number) => {
    setLoading(true)
    try {
      const page = await api.log(repo.id, { skip, limit: PAGE, all: true })
      setCommits((c) => (skip ? [...c, ...page] : page))
      setMore(page.length === PAGE)
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.id, version])

  const graph = useMemo(() => buildGraph(commits), [commits])
  const width = Math.min(Math.max(1, ...graph.map((r) => r.width)), 16)

  return (
    <div className="bg-list">
      {commits.map((c, i) => (
        <div key={c.sha} className="bg-row" style={{ height: ROW_H }}>
          <GraphCell row={graph[i]} width={width} />
          <div className="bg-main">
            <div className="bg-subject"><RefChips refs={c.refs} /><span className={c.parents.length > 1 ? 'muted' : ''}>{c.subject}</span></div>
            <div className="sub"><code>{c.shortSha}</code> · {c.author} · <span title={fullDate(c.date)}>{ago(c.date)}</span></div>
          </div>
          <Avatar name={c.author} email={c.email} size={20} />
        </div>
      ))}
      {loading && <Spinner />}
      {!loading && more && commits.length > 0 && <button className="link load-more" onClick={() => load(commits.length)}>Load {PAGE} more…</button>}
      {!loading && !commits.length && <div className="empty small">No commits yet</div>}
    </div>
  )
}
