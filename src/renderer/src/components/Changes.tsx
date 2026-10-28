import { useEffect, useState } from 'react'
import type { FileChange, Repo } from '../../../shared/types'
import { api } from '../api'
import { Diff, Spinner, useApp, useLoad } from './ui'

const LABEL: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict', '?': 'untracked' }

interface Props {
  repo: Repo
  version: number
  changed: () => Promise<void>
  net: (label: string, fn: () => Promise<unknown>) => Promise<unknown>
}

export function Changes({ repo, version, changed, net }: Props) {
  const { act, busy } = useApp()
  const { data: st, loading } = useLoad(() => api.status(repo.id), [repo.id, version])
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null)
  const [msg, setMsg] = useState('')
  const [amend, setAmend] = useState(false)

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

  const row = (f: FileChange, isStaged: boolean) => {
    const code = f.conflicted ? 'U' : isStaged ? f.index : f.untracked ? '?' : f.worktree
    const active = sel?.path === f.path && sel.staged === isStaged
    return (
      <div key={(isStaged ? 's:' : 'u:') + f.path} className={`file ${active ? 'active' : ''}`} onClick={() => setSel({ path: f.path, staged: isStaged })}>
        <span className={`code c-${code}`} title={LABEL[code] ?? code}>{code}</span>
        <span className="path" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>{f.path}</span>
        <span className="file-actions">
          {isStaged
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
      <div className="split-left">
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
            {unstaged.length > 0 && <>
              <button className="link" onClick={() => discard(unstaged.filter((f) => !f.conflicted))}>Discard all</button>
              <button className="link" onClick={() => run(() => api.stageAll(repo.id))}>Stage all</button>
            </>}
          </div>
          {unstaged.map((f) => row(f, false))}
          {loading && <Spinner />}
          {!loading && files.length === 0 && <div className="empty small">Working tree clean ✓</div>}
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
            <button disabled={busy || (!msg.trim() && !amend)} onClick={() => commit(true)}>Commit & Push</button>
          </div>
          <div className="hint">Ctrl+Enter to commit</div>
        </div>
      </div>
      <div className="split-right">
        {selFile ? (
          <>
            <div className="diff-head">{selFile.path} <span className="muted">({sel!.staged ? 'staged' : 'working tree'})</span></div>
            {diffLoading ? <Spinner /> : <Diff text={diff ?? ''} />}
          </>
        ) : <div className="empty">Select a file to see its diff</div>}
      </div>
    </div>
  )
}
