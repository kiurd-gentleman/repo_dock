import { useEffect, useState } from 'react'
import type { FileChange, Repo, Stash } from '../../../shared/types'
import { api } from '../api'
import { Diff, Spinner, ago, fullDate, leaveForRight, useApp, usePaneWidth, useLoad } from './ui'
import { FormDialog } from './GitDialogs'
import { useMenu, type MenuEntry, type MenuItem } from './menu'

const LABEL: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict', '?': 'untracked' }

interface Props {
  repo: Repo
  version: number
  changed: () => Promise<void>
  net: (label: string, fn: () => Promise<unknown>) => Promise<unknown>
}

export function Changes({ repo, version, changed, net }: Props) {
  const { act, busy, summaries } = useApp()
  const { data: st, loading } = useLoad(() => api.status(repo.id), [repo.id, version])
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null)
  // Stashes live here, next to the changes they were set aside from. Selecting one shows it in the diff pane.
  const { data: stashes } = useLoad(() => api.stashes(repo.id).catch(() => [] as Stash[]), [repo.id, version])
  const [stashSel, setStashSel] = useState<string | null>(null)
  const [stashOpen, setStashOpen] = useState(true)
  const [dialog, setDialog] = useState<React.ReactNode>(null)
  const selStash = stashes?.find((x) => x.ref === stashSel) ?? null
  const { data: stashDiff, loading: stashLoading } = useLoad(async () => (stashSel ? api.stashShow(repo.id, stashSel) : ''), [repo.id, stashSel, version])
  const [msg, setMsg] = useState('')
  const [amend, setAmend] = useState(false)
  const [openMenu, menu] = useMenu()
  const pane = usePaneWidth('changes', 340, 240, leaveForRight(360))

  const files = st?.files ?? []
  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => f.unstaged || f.conflicted)
  const selFile = sel && files.find((f) => f.path === sel.path)

  const { data: diff, loading: diffLoading } = useLoad(
    async () => (selFile ? api.diff(repo.id, selFile.path, sel!.staged, selFile.untracked) : ''),
    [repo.id, sel?.path, sel?.staged, version]
  )

  // Auto-select the first file so the diff pane isn't empty.
  useEffect(() => {
    if (!st) return
    if (!sel || !files.some((f) => f.path === sel.path)) {
      const f = unstaged[0] ?? staged[0]
      setSel(f ? { path: f.path, staged: !unstaged.includes(f) } : null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st])

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    await act(fn, ok)
    await changed()
  }

  const commit = async (push: boolean) => {
    const all = staged.length === 0 && !amend
    if (all && !confirm('Nothing is staged. Stage all changes and commit?')) return
    const ok = await act(() => api.commit(repo.id, msg, { amend, all }), amend ? 'Commit amended' : 'Committed')
    if (ok === undefined) return
    setMsg('')
    setAmend(false)
    if (push) await net('Push', () => api.push(repo.id))
    else await changed()
  }

  const discard = (list: FileChange[]) => {
    if (!list.length) return
    const names = list.length === 1 ? list[0].path : `${list.length} files`
    if (!confirm(`Discard changes to ${names}? This cannot be undone.`)) return
    run(() => api.discard(repo.id, list.map((f) => ({ path: f.path, untracked: f.untracked }))), 'Discarded')
  }

  const full = (p: string) => `${repo.path}/${p}`.replace(/\\/g, '/')
  const resolve = (files: string[], how: 'ours' | 'theirs' | 'resolved') =>
    run(() => api.resolveConflict(repo.id, files, how), how === 'resolved' ? 'Marked as resolved' : `Kept ${how === 'ours' ? 'our' : 'their'} version`)
  const ignore = (pattern: string) => run(() => api.ignorePath(repo.id, pattern), `Added ${pattern} to .gitignore`)

  const fileMenu = (f: FileChange, isStaged: boolean): MenuEntry[] => {
    const ext = f.path.match(/\.[^./]+$/)?.[0]
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : null
    return [
      { heading: f.path },
      ...(f.conflicted ? [
        { label: 'Use ours', hint: 'current branch', onClick: () => resolve([f.path], 'ours') },
        { label: 'Use theirs', hint: 'incoming', onClick: () => resolve([f.path], 'theirs') },
        { label: 'Mark as resolved', hint: 'after editing', onClick: () => resolve([f.path], 'resolved') },
        'sep' as const
      ] : []),
      !f.conflicted && (isStaged
        ? { label: 'Unstage', onClick: () => run(() => api.unstage(repo.id, [f.path])) }
        : { label: 'Stage', onClick: () => run(() => api.stage(repo.id, [f.path])) }),
      !isStaged && !f.conflicted && { label: 'Discard changes…', danger: true, onClick: () => discard([f]) },
      'sep',
      f.untracked && { label: 'Ignore this file', onClick: () => ignore(f.path) },
      f.untracked && ext && { label: `Ignore all ${ext} files`, onClick: () => ignore(`*${ext}`) },
      f.untracked && dir && { label: `Ignore folder ${dir}`, onClick: () => ignore(dir) },
      'sep',
      !gone(f, isStaged) && { label: 'Open file', onClick: () => api.openPath(full(f.path)) },
      !gone(f, isStaged) && { label: 'Show in folder', onClick: () => api.showInFolder(full(f.path)) },
      { label: 'Copy path', onClick: () => navigator.clipboard.writeText(f.path) },
      { label: 'Copy full path', onClick: () => navigator.clipboard.writeText(full(f.path)) }
    ]
  }

  /** Deleted files can't be opened or shown in Explorer. */
  const gone = (f: FileChange, isStaged: boolean) => (isStaged ? f.index : f.worktree) === 'D'
  const conflicted = files.filter((f) => f.conflicted)
  const trackedChanges = files.some((f) => !f.untracked)
  const anyUntracked = files.some((f) => f.untracked)
  const moreMenu = (e: React.MouseEvent) => openMenu(e, [
    conflicted.length > 0 && { label: `Use ours for all ${conflicted.length} conflicts`, onClick: () => resolve(conflicted.map((f) => f.path), 'ours') },
    conflicted.length > 0 && { label: `Use theirs for all ${conflicted.length} conflicts`, onClick: () => resolve(conflicted.map((f) => f.path), 'theirs') },
    'sep',
    files.length > 0 && { label: 'Stash all changes', onClick: () => run(() => api.stashSave(repo.id, ''), 'Changes stashed') },
    !!summaries[repo.id]?.lastCommit && { label: 'Undo last commit', hint: 'keeps changes', onClick: () => confirm('Undo the last commit? Its changes come back as staged.') && run(() => api.undoLastCommit(repo.id), 'Commit undone') },
    'sep',
    anyUntracked && { label: 'Remove untracked files…', danger: true, onClick: () => confirm('Delete every untracked file and folder (not ignored ones)? This cannot be undone.') && run(() => api.cleanUntracked(repo.id, false), 'Untracked files removed') },
    { label: 'Remove untracked + ignored files…', danger: true, title: 'Also deletes build output, node_modules, .env files…', onClick: () => confirm('Delete every untracked AND ignored file (build output, node_modules, .env…)? This cannot be undone.') && run(() => api.cleanUntracked(repo.id, true), 'Cleaned') },
    trackedChanges && { label: 'Discard ALL changes…', danger: true, onClick: () => confirm('Throw away every staged and unstaged change to tracked files? Untracked files stay. This cannot be undone.') && run(() => api.discardAll(repo.id), 'All changes discarded') }
  ])

  const row = (f: FileChange, isStaged: boolean) => {
    const code = f.conflicted ? 'U' : isStaged ? f.index : f.untracked ? '?' : f.worktree
    const active = sel?.path === f.path && sel.staged === isStaged
    return (
      <div key={(isStaged ? 's:' : 'u:') + f.path} className={`file ${active ? 'active' : ''}`} onClick={() => (setStashSel(null), setSel({ path: f.path, staged: isStaged }))} onContextMenu={(e) => openMenu(e, fileMenu(f, isStaged))}>
        <span className={`code c-${code}`} title={LABEL[code] ?? code}>{code}</span>
        <span className="path" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>{f.path}</span>
        <span className="file-actions">
          {f.conflicted
            ? <>
                <button className="icon small" title="Use ours (current branch)" onClick={(e) => (e.stopPropagation(), resolve([f.path], 'ours'))}>◧</button>
                <button className="icon small" title="Use theirs (incoming)" onClick={(e) => (e.stopPropagation(), resolve([f.path], 'theirs'))}>◨</button>
                <button className="icon small" title="Mark as resolved" onClick={(e) => (e.stopPropagation(), resolve([f.path], 'resolved'))}>✓</button>
              </>
            : isStaged
            ? <button className="icon small" title="Unstage" onClick={(e) => (e.stopPropagation(), run(() => api.unstage(repo.id, [f.path])))}>−</button>
            : <>
                <button className="icon small" title="Discard" onClick={(e) => (e.stopPropagation(), discard([f]))}>↺</button>
                <button className="icon small" title="Stage" onClick={(e) => (e.stopPropagation(), run(() => api.stage(repo.id, [f.path])))}>+</button>
              </>}
        </span>
      </div>
    )
  }

  return (
    <div className="split">
      {menu}
      <div className="split-left" style={{ width: pane.width }}>
        <div className="file-section">
          <div className="section-head">
            <span>Staged ({staged.length})</span>
            {staged.length > 0 && <button className="link" onClick={() => run(() => api.unstage(repo.id, staged.map((f) => f.path)))}>Unstage all</button>}
          </div>
          {staged.map((f) => row(f, true))}
        </div>
        <div className="file-section">
          <div className="section-head">
            <span>Changes ({unstaged.length})</span>
            <button className="link" onClick={moreMenu} title="More actions">⋯ More</button>
            {unstaged.length > 0 && <>
              <button className="link" onClick={() => discard(unstaged.filter((f) => !f.conflicted))}>Discard all</button>
              <button className="link" onClick={() => run(() => api.stageAll(repo.id))}>Stage all</button>
            </>}
          </div>
          {unstaged.map((f) => row(f, false))}
          {loading && <Spinner />}
          {!loading && files.length === 0 && <div className="empty small">Working tree clean ✓</div>}
        </div>
        <div className="file-section stash-section">
          <div className="section-head">
            <button className="link stash-toggle" onClick={() => setStashOpen(!stashOpen)} aria-expanded={stashOpen}>
              {stashOpen ? '▾' : '▸'} Stashed ({stashes?.length ?? 0})
            </button>
            {files.length > 0 && <button className="link" title="Set every change aside (including new files) and get a clean working tree" onClick={() => setDialog(
              <FormDialog title="Stash changes" submit="Stash" onClose={() => setDialog(null)}
                intro="Your changes are set aside and the working tree becomes clean. Bring them back any time from Stashed."
                fields={[{ key: 'msg', label: 'What are these changes?', optional: true, placeholder: 'e.g. half-done login form' }]}
                onSubmit={(v) => run(() => api.stashSave(repo.id, v.msg.trim()), 'Changes stashed').then(() => true)} />
            )}>Stash changes</button>}
          </div>
          {stashOpen && (stashes ?? []).map((x) => (
            <div key={x.ref} className={`file stash-item ${stashSel === x.ref ? 'active' : ''}`} onClick={() => (setSel(null), setStashSel(x.ref))} title={`${x.message}\n${fullDate(x.date)}`}>
              <span className="code c-S">S</span>
              <span className="path">{x.message.replace(/^(WIP on|On) [^:]+: /, '')}</span>
              <span className="stash-meta">{x.files.length} file{x.files.length === 1 ? '' : 's'} · {ago(x.date)}</span>
            </div>
          ))}
          {stashOpen && !stashes?.length && <div className="empty small">Nothing stashed. Use “Stash changes” to set work aside without committing.</div>}
        </div>
        <div className="commit-box">
          <textarea
            placeholder={amend ? 'New message (leave empty to keep the old one)' : 'Commit message'}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && commit(false)}
            rows={3}
          />
          <label className="check"><input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend last commit</label>
          <div className="row">
            <button className="primary grow" disabled={busy || (!msg.trim() && !amend) || files.length === 0 && !amend} onClick={() => commit(false)}>
              Commit {staged.length ? `${staged.length} file(s)` : 'all'}
            </button>
            {summaries[repo.id]?.remoteUrl && <button disabled={busy || (!msg.trim() && !amend)} onClick={() => commit(true)}>Commit & Push</button>}
          </div>
          <div className="hint">Ctrl+Enter to commit</div>
        </div>
      </div>
      <div {...pane.handle} />
      <div className="split-right">
        {selStash ? (
          <>
            <div className="diff-head stash-head">
              <div className="grow">
                <b>{selStash.message.replace(/^(WIP on|On) [^:]+: /, '')}</b>
                <div className="sub">{selStash.ref} · {selStash.files.length} file{selStash.files.length === 1 ? '' : 's'} · stashed {ago(selStash.date)}</div>
              </div>
              <button className="primary" disabled={busy} onClick={() => run(() => api.stashPop(repo.id, selStash.ref), 'Stash restored').then(() => setStashSel(null))} title="Put the changes back and remove the stash">Restore</button>
              <button disabled={busy} onClick={() => run(() => api.stashApply(repo.id, selStash.ref), 'Stash applied')} title="Put the changes back and keep the stash">Apply, keep stash</button>
              <button disabled={busy} onClick={() => setDialog(
                <FormDialog title={`Branch from ${selStash.ref}`} submit="Create branch" onClose={() => setDialog(null)}
                  intro="Creates a branch where the stash was made, restores the changes there and removes the stash."
                  fields={[{ key: 'name', label: 'Branch name' }]}
                  onSubmit={(v) => run(() => api.stashBranch(repo.id, selStash.ref, v.name.trim()), `Created ${v.name.trim()}`).then(() => (setStashSel(null), true))} />
              )}>New branch…</button>
              <button className="danger" disabled={busy} onClick={() => confirm(`Delete this stash? Its changes are lost.`) && run(() => api.stashDrop(repo.id, selStash.ref), 'Stash deleted').then(() => setStashSel(null))}>Delete</button>
            </div>
            {stashLoading ? <Spinner /> : <Diff text={stashDiff ?? ''} />}
          </>
        ) : selFile ? (
          <>
            <div className="diff-head">{selFile.path} <span className="muted">({sel!.staged ? 'staged' : 'working tree'})</span></div>
            {diffLoading ? <Spinner /> : <Diff text={diff ?? ''} />}
          </>
        ) : <div className="empty">Select a file to see its diff</div>}
      </div>
      {dialog}
    </div>
  )
}
