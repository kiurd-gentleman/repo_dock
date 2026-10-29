import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Branch, MergePreview, Repo } from '../../../shared/types'
import { api } from '../api'
import { Modal, Spinner, ago, fullDate, useApp, useLoad } from './ui'
import { useMenu, type MenuEntry } from './menu'
import { FormDialog } from './GitDialogs'
import { BranchGraph } from './BranchGraph'

/**
 * One row per branch name: the local branch and its copy on the remote are shown together,
 * so "is it pushed?", "is it only on GitHub?" and "is it merged?" are answered on one line.
 */
export interface BranchRow {
  key: string
  local?: Branch
  remote?: Branch
  current: boolean
}

export function branchRows(list: Branch[]): BranchRow[] {
  const rows = new Map<string, BranchRow>()
  for (const b of list.filter((x) => !x.remote)) rows.set(b.name, { key: b.name, local: b, current: b.current })
  for (const r of list.filter((x) => x.remote)) {
    const owner = [...rows.values()].find((row) => row.local?.upstream === r.name)
    if (owner) owner.remote = r
    else {
      const short = r.name.split('/').slice(1).join('/')
      const sameName = rows.get(short)
      if (sameName && !sameName.remote) sameName.remote = r
      else if (!sameName) rows.set(short, { key: short, remote: r, current: false })
      else rows.set(r.name, { key: r.name, remote: r, current: false }) // e.g. upstream/main next to origin/main
    }
  }
  return [...rows.values()]
}

type Filter = 'all' | 'local' | 'remote' | 'merged' | 'open'

export function Branches({ repo, version, changed }: { repo: Repo; version: number; changed: () => Promise<void> }) {
  const { act, busy, summaries } = useApp()
  const [openMenu, menu] = useMenu()
  const [dialog, setDialog] = useState<ReactNode>(null)
  const [view, setView] = useState<'list' | 'graph'>('list')
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const close = () => setDialog(null)
  const s = summaries[repo.id]
  const ghUrl = s?.owner ? `https://github.com/${s.owner}/${s.repoName}` : null
  const { data: branches, loading } = useLoad(() => api.branches(repo.id), [repo.id, version])

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    const r = await act(fn, ok)
    await changed()
    return r
  }

  const rows = useMemo(() => branchRows(branches ?? []), [branches])
  const current = rows.find((r) => r.current)
  const into = current?.key ?? 'the current branch'
  const ref = (r: BranchRow) => (r.local ?? r.remote)!
  const merged = (r: BranchRow) => !r.current && ref(r).vsHead?.ahead === 0

  const counts: Record<Filter, number> = {
    all: rows.length,
    local: rows.filter((r) => r.local).length,
    remote: rows.filter((r) => !r.local).length,
    merged: rows.filter(merged).length,
    open: rows.filter((r) => !r.current && (ref(r).vsHead?.ahead ?? 0) > 0).length
  }
  const shown = rows
    .filter((r) => filter === 'all' || (filter === 'local' ? r.local : filter === 'remote' ? !r.local : filter === 'merged' ? merged(r) : !r.current && (ref(r).vsHead?.ahead ?? 0) > 0))
    .filter((r) => !q || r.key.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.current) - Number(a.current) || ref(b).date - ref(a).date)

  const openMerge = (name?: string) => setDialog(<MergeDialog repo={repo} rows={rows} into={into} initial={name} onClose={close} done={changed} />)

  const newBranch = (from?: string) => setDialog(
    <FormDialog title={`New branch from ${from ?? into}`} submit="Create & switch" onClose={close} fields={[{ key: 'name', label: 'Branch name', placeholder: 'feature/…' }]}
      onSubmit={(v) => run(() => api.createBranch(repo.id, v.name.trim(), from), `Created ${v.name.trim()}`)} />
  )

  const deleteLocal = async (b: Branch) => {
    if (!confirm(`Delete local branch ${b.name}?`)) return
    try {
      await api.deleteBranch(repo.id, b.name, false)
    } catch (e) {
      if (!confirm(`${(e as Error).message}\n\nForce delete anyway? Unmerged commits will be lost.`)) return
      await act(() => api.deleteBranch(repo.id, b.name, true))
    }
    await changed()
  }

  const remotes = (branches ?? []).filter((b) => b.remote)
  /** Only actions that do something for this particular branch: a merged, up-to-date branch gets no Merge/Push/PR. */
  const rowMenu = (r: BranchRow): MenuEntry[] => {
    const l = r.local
    const rem = r.remote
    const short = rem ? rem.name.split('/').slice(1).join('/') : ''
    const remoteName = rem ? rem.name.split('/')[0] : remotes[0]?.name.split('/')[0] ?? 'origin'
    const isMerged = merged(r)
    const gone = !!l?.track.includes('gone')
    const ahead = Number(l?.track.match(/ahead (\d+)/)?.[1] ?? 0)
    const tracked = !!l?.upstream && !gone
    const status = [
      r.current ? 'current branch' : isMerged ? `merged into ${into}` : null,
      l && !tracked ? (gone ? 'deleted on remote' : 'not published') : null
    ].filter(Boolean).join(' · ')
    return [
      { heading: status ? `${r.key} · ${status}` : r.key },
      !r.current && l && { label: 'Switch to this branch', onClick: () => run(() => api.checkout(repo.id, l.name, false), `Switched to ${l.name}`) },
      !l && rem && { label: 'Check out', hint: `as ${short}`, onClick: () => run(() => api.checkout(repo.id, rem.name, true), `Checked out ${rem.name}`) },
      !l && rem && { label: 'Check out as…', onClick: () => setDialog(
        <FormDialog title={`Check out ${rem.name}`} submit="Create & switch" onClose={close} fields={[{ key: 'name', label: 'Local branch name', initial: short }]}
          onSubmit={(v) => run(() => api.createBranch(repo.id, v.name.trim(), rem.name), `Created ${v.name.trim()}`)} />) },
      !r.current && !isMerged && { label: `Merge into ${into}…`, onClick: () => openMerge(ref(r).name) },
      'sep',
      l && tracked && ahead > 0 && { label: `Push ${ahead} commit${ahead === 1 ? '' : 's'}`, onClick: () => run(() => api.pushBranch(repo.id, l.name), `Pushed ${l.name}`) },
      l && !tracked && remotes.length > 0 && { label: `Publish to ${remoteName}`, hint: 'push -u', onClick: () => run(() => api.pushBranch(repo.id, l.name), `Published ${l.name}`) },
      l && !tracked && remotes.length > 0 && { label: 'Track an existing remote branch…', onClick: () => setDialog(
        <FormDialog title={`Upstream of ${l.name}`} submit="Set upstream" onClose={close} intro="Where pull and push go for this branch."
          fields={[{ key: 'up', label: 'Remote branch', initial: remotes.find((x) => x.name.endsWith('/' + l.name))?.name, options: remotes.map((x) => ({ value: x.name, label: x.name })) }]}
          onSubmit={(v) => run(() => api.setUpstream(repo.id, l.name, v.up), `Tracking ${v.up}`)} />) },
      ghUrl && rem && !r.current && !isMerged && { label: 'Open a pull request on GitHub', onClick: () => api.openExternal(`${ghUrl}/compare/${short}?expand=1`) },
      'sep',
      l && { label: 'Rename…', onClick: () => setDialog(
        <FormDialog title={`Rename ${l.name}`} submit="Rename" onClose={close} fields={[{ key: 'name', label: 'New name', initial: l.name }]}
          intro={tracked ? 'Only the local branch is renamed. The remote branch keeps its name until you publish the new one.' : undefined}
          onSubmit={(v) => run(() => api.renameBranch(repo.id, l.name, v.name.trim()), `Renamed to ${v.name.trim()}`)} />) },
      { label: 'New branch from here…', onClick: () => newBranch(ref(r).name) },
      { label: 'Copy name', onClick: () => navigator.clipboard.writeText(r.key) },
      ghUrl && rem && { label: 'View on GitHub', onClick: () => api.openExternal(`${ghUrl}/tree/${short}`) },
      'sep',
      isMerged && l && rem && { label: `Delete here and on ${remoteName}`, hint: 'merged, safe', danger: true, onClick: () => confirm(`Delete ${r.key} on this PC and on ${remoteName}? Everything in it is already in ${into}.`) && run(async () => {
        await api.deleteBranch(repo.id, l.name, false)
        await api.deleteRemoteBranch(repo.id, rem.name)
      }, `Deleted ${r.key} everywhere`) },
      l && !r.current && { label: 'Delete local branch…', hint: isMerged ? 'merged, safe' : undefined, danger: true, onClick: () => deleteLocal(l) },
      rem && !r.current && { label: `Delete on ${remoteName}…`, hint: isMerged ? 'merged, safe' : undefined, danger: true, onClick: () => confirm(`Delete ${rem.name} on the remote? Others won't see it any more.${isMerged ? '' : '\n\nIt has commits that are not in ' + into + '.'}`) && run(() => api.deleteRemoteBranch(repo.id, rem.name), 'Remote branch deleted') },
      gone && l && { label: 'Forget the deleted remote branch', title: 'The remote copy is gone; stop tracking it', onClick: () => run(() => api.setUpstream(repo.id, l.name, null), 'Stopped tracking') }
    ]
  }

  const FILTERS: { id: Filter; label: string; title: string }[] = [
    { id: 'all', label: 'All', title: 'Every branch, local or on the remote' },
    { id: 'local', label: 'On this PC', title: 'Branches you have locally' },
    { id: 'remote', label: 'Only on remote', title: 'Branches on the remote you have never checked out' },
    { id: 'open', label: 'Not merged', title: `Have commits that ${into} doesn't` },
    { id: 'merged', label: 'Merged', title: `Everything in them is already in ${into}: usually safe to delete` }
  ]

  return (
    <div className="bx">
      <header className="bx-head">
        <div className="bx-current">
          <span className="rh-label">You're on</span>
          <div><span className="ov-branch big">⎇ {into}</span>{current?.local?.upstream && <span className="muted"> → {current.local.upstream}</span>}</div>
        </div>
        <span className="grow" />
        {current && rows.some((r) => !r.current && !merged(r)) && <button className="primary" disabled={busy} onClick={() => openMerge()}>⇄ Merge into {into}…</button>}
        <button disabled={busy} onClick={() => newBranch()}>+ New branch</button>
      </header>

      <div className="bx-bar">
        <div className="seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button>
          <button role="tab" aria-selected={view === 'graph'} className={view === 'graph' ? 'on' : ''} onClick={() => setView('graph')}>Graph</button>
        </div>
        {view === 'list' && <>
          <div className="bx-filters">
            {FILTERS.filter((f) => f.id === 'all' || filter === f.id || counts[f.id] > 0).map((f) => (
              <button key={f.id} className={`ov-chip ${filter === f.id ? 'on' : ''}`} title={f.title} onClick={() => setFilter(f.id)}>
                <b>{counts[f.id]}</b> {f.label}
              </button>
            ))}
          </div>
          <span className="grow" />
          <input className="ov-search" type="search" placeholder="Find a branch…" value={q} onChange={(e) => setQ(e.target.value)} />
        </>}
        {view === 'graph' && <span className="muted small-text">Every branch and how they connect, newest first.</span>}
      </div>

      {view === 'graph' ? <BranchGraph repo={repo} version={version} /> : (
        <div className="table-wrap">
          <table className="table bx-table">
            <thead>
              <tr>
                <th className="bx-c-name">Branch</th>
                <th className="bx-c-where">Where it is</th>
                <th className="bx-c-sync">Compared with the remote</th>
                <th className="bx-c-vs">Compared with {into}</th>
                <th>Last commit</th>
                <th className="ov-actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const b = ref(r)
                return (
                  <tr key={r.key} className={`ov-row ${r.current ? 'bx-current-row' : ''}`} onContextMenu={(e) => openMenu(e, rowMenu(r))} onDoubleClick={() => !r.current && r.local && run(() => api.checkout(repo.id, r.local!.name, false), `Switched to ${r.key}`)}>
                    <td className="bx-c-name"><span className="bx-name" title={r.key}>{r.key}</span>{r.current && <span className="pill accent">current</span>}</td>
                    <td><Where r={r} /></td>
                    <td><VsRemote r={r} /></td>
                    <td>{r.current ? <span className="muted">—</span> : <VsHead b={b} into={into} />}</td>
                    <td className="bx-commit" title={`${b.subject}\n${fullDate(b.date)}`}><span className="ellipsis">{b.subject}</span><span className="sub">{ago(b.date)}</span></td>
                    <td className="ov-actions" onClick={(e) => e.stopPropagation()}>
                      <div className="ov-actions-float">
                        {!r.current && r.local && <button className="small" disabled={busy} onClick={() => run(() => api.checkout(repo.id, r.local!.name, false), `Switched to ${r.key}`)}>Switch</button>}
                        {!r.local && <button className="small" disabled={busy} onClick={() => run(() => api.checkout(repo.id, r.remote!.name, true), `Checked out ${r.key}`)}>Check out</button>}
                        {current && !r.current && !merged(r) && <button className="small" disabled={busy} onClick={() => openMerge(b.name)}>Merge in…</button>}
                        <button className="small icon-btn" onClick={(e) => openMenu(e, rowMenu(r))} aria-label="More actions">⋯</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {loading && !branches && <Spinner />}
          {!loading && !shown.length && <div className="ov-empty">{q || filter !== 'all' ? 'No branches match.' : 'No branches yet.'}</div>}
          <p className="hint bx-tip">Double-click a branch to switch to it. Right-click for everything else: publish, rename, upstream, pull request, delete.</p>
        </div>
      )}
      {menu}
      {dialog}
    </div>
  )
}

function Where({ r }: { r: BranchRow }) {
  return (
    <span className="bx-where">
      {r.local && <span className="bx-loc" title="You have this branch on this PC">Local</span>}
      {r.remote && <span className="bx-rem" title={r.remote.name}>☁ {r.remote.name.split('/')[0]}</span>}
    </span>
  )
}

function VsRemote({ r }: { r: BranchRow }) {
  const l = r.local
  if (!l) return <span className="muted">Not checked out</span>
  if (!l.upstream) return <span className="muted" title="Only on this PC. Publish it to share it.">Not published</span>
  if (l.track.includes('gone')) return <span className="err-text" title="The branch was deleted on the remote">Deleted on remote</span>
  const ahead = Number(l.track.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(l.track.match(/behind (\d+)/)?.[1] ?? 0)
  if (!ahead && !behind) return <span className="muted">Up to date</span>
  return (
    <span className="ov-sync">
      {behind > 0 && <span className="pull-text"><b>{behind}</b> to pull</span>}
      {ahead > 0 && <span className="accent-text"><b>{ahead}</b> to push</span>}
    </span>
  )
}

function VsHead({ b, into }: { b: Branch; into: string }) {
  if (!b.vsHead) return <span className="muted">—</span>
  const { ahead, behind } = b.vsHead
  if (ahead === 0) return <span className="ok-text" title={`Everything in it is already in ${into}`}>✓ Merged</span>
  return (
    <span className="ov-sync" title={`${ahead} commit${ahead === 1 ? '' : 's'} not in ${into}; ${behind} commit${behind === 1 ? '' : 's'} of ${into} not in it`}>
      <span className="warn-text"><b>{ahead}</b> to merge in</span>
      {behind > 0 && <span className="muted"><b>{behind}</b> behind</span>}
    </span>
  )
}

type Mode = 'merge' | 'squash' | 'rebase'

/** Pick a branch, see exactly what would happen (incoming commits, fast-forward, predicted conflicts), then merge. */
export function MergeDialog({ repo, rows, into, initial, onClose, done }: { repo: Repo; rows: BranchRow[]; into: string; initial?: string; onClose: () => void; done: () => Promise<void> }) {
  const { act } = useApp()
  // Already-merged branches have nothing to bring in, so they aren't offered.
  const options = rows.filter((r) => !r.current).map((r) => (r.local ?? r.remote)!).filter((b) => b.vsHead?.ahead !== 0)
  const [other, setOther] = useState(initial ?? options.find((b) => (b.vsHead?.ahead ?? 1) > 0)?.name ?? options[0]?.name ?? '')
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('merge')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!other) return
    setPreview(null)
    setError(null)
    api.mergePreview(repo.id, other).then(setPreview, (e) => setError((e as Error).message))
  }, [repo.id, other])

  const go = async () => {
    setBusy(true)
    const fn = mode === 'rebase' ? () => api.rebaseOnto(repo.id, other) : () => api.merge(repo.id, other, mode === 'squash' ? 'squash' : 'merge')
    const ok = mode === 'rebase' ? `Rebased ${into} onto ${other}` : mode === 'squash' ? `Squashed ${other}: review and commit in Changes` : `Merged ${other} into ${into}`
    const r = await act(fn, ok)
    setBusy(false)
    await done()
    if (r !== undefined) onClose()
  }

  const nothing = preview && preview.incomingCount === 0
  const ALL_MODES: { id: Mode; title: string; text: string }[] = [
    { id: 'merge', title: preview?.fastForward ? 'Fast-forward' : 'Merge commit', text: preview?.fastForward ? `${into} simply moves forward to ${other}. No merge commit is needed.` : `Keeps both histories and adds one merge commit on ${into}.` },
    { id: 'squash', title: 'Squash', text: `All of ${other}'s changes become staged in Changes, for you to commit as one commit.` },
    { id: 'rebase', title: `Rebase ${into} onto it`, text: `Replays ${into}'s own commits on top of ${other}. Linear history, but rewrites ${into}'s commits.` }
  ]
  // With no commits of its own, rebasing is the same as a fast-forward: don't offer it twice.
  const MODES = ALL_MODES.filter((m) => m.id !== 'rebase' || (preview?.outgoingCount ?? 0) > 0)

  return (
    <Modal title={`Merge into ${into}`} onClose={onClose} wide>
      <label>Branch to bring in
        <select value={other} onChange={(e) => setOther(e.target.value)}>
          {options.map((b) => <option key={b.name} value={b.name}>{b.name}{b.vsHead?.ahead === 0 ? ' (already merged)' : b.vsHead ? ` (${b.vsHead.ahead} new)` : ''}</option>)}
        </select>
      </label>

      {error ? <div className="err-text">{error}</div> : !preview ? <Spinner /> : nothing ? (
        <div className="mg-verdict good">✓ Nothing to merge: everything in {other} is already in {into}.</div>
      ) : <>
        <div className="mg-summary">
          <div className="mg-fact"><b>{preview.incomingCount}</b> commit{preview.incomingCount === 1 ? '' : 's'} will come in</div>
          <div className="mg-fact"><b>{preview.outgoingCount}</b> commit{preview.outgoingCount === 1 ? '' : 's'} only on {into}</div>
          {preview.conflicts === null ? <div className="mg-fact muted">Conflicts can't be predicted with this Git version</div>
            : preview.conflicts.length ? <div className="mg-fact bad"><b>{preview.conflicts.length}</b> file{preview.conflicts.length === 1 ? '' : 's'} will conflict</div>
            : <div className="mg-fact good">✓ No conflicts expected</div>}
        </div>
        {!!preview.conflicts?.length && (
          <div className="mg-conflicts">
            You'll need to resolve these in Changes after merging (or choose Abort):
            <ul>{preview.conflicts.slice(0, 12).map((f) => <li key={f}><code>{f}</code></li>)}</ul>
            {preview.conflicts.length > 12 && <span className="muted">and {preview.conflicts.length - 12} more</span>}
          </div>
        )}
        <div className="mg-commits">
          {preview.incoming.map((c) => (
            <div key={c.sha} className="mg-commit"><code>{c.shortSha}</code><span className="ellipsis">{c.subject}</span><span className="muted">{c.author}, {ago(c.date)}</span></div>
          ))}
          {preview.incomingCount > preview.incoming.length && <div className="muted mg-more">and {preview.incomingCount - preview.incoming.length} more</div>}
        </div>
        <div className="choice-list mg-modes">
          {MODES.map((m) => (
            <label key={m.id} className={`choice ${mode === m.id ? 'sel' : ''}`}>
              <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
              <span><b>{m.title}</b><span className="sub">{m.text}</span></span>
            </label>
          ))}
        </div>
      </>}

      <div className="row end">
        <button onClick={onClose}>Cancel</button>
        {preview && !nothing && <button className="primary" disabled={busy} onClick={go}>
          {busy ? 'Working…' : mode === 'rebase' ? `Rebase ${into} onto ${other}` : mode === 'squash' ? `Squash ${other} into ${into}` : `Merge ${other} into ${into}`}
        </button>}
      </div>
    </Modal>
  )
}
