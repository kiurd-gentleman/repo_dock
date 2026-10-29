import { useEffect, useState, type ReactNode } from 'react'
import type { Commit, RebaseAction, Repo } from '../../../shared/types'
import { api } from '../api'
import { Modal, Spinner, useApp } from './ui'

export interface Field {
  key: string
  label: string
  initial?: string
  placeholder?: string
  multiline?: boolean
  optional?: boolean
  options?: { value: string; label: string }[]
  checkbox?: boolean
  hint?: string
}

/** Small form in a modal. `onSubmit` returns undefined on failure (as `act` does), which keeps the dialog open. */
export function FormDialog({ title, intro, fields, submit, danger, onSubmit, onClose }: {
  title: string
  intro?: ReactNode
  fields: Field[]
  submit: string
  danger?: boolean
  onSubmit: (v: Record<string, string>) => Promise<unknown>
  onClose: () => void
}) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.initial ?? (f.options?.[0]?.value ?? '')])))
  const [busy, setBusy] = useState(false)
  const missing = fields.some((f) => !f.optional && !f.checkbox && !v[f.key]?.trim())
  const go = async () => {
    if (missing || busy) return
    setBusy(true)
    const r = await onSubmit(v)
    setBusy(false)
    if (r !== undefined) onClose()
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), go())}>
        {intro && <div className="dlg-intro">{intro}</div>}
        {fields.map((f, i) =>
          f.checkbox ? (
            <label key={f.key} className="check dlg-check">
              <input type="checkbox" checked={v[f.key] === '1'} onChange={(e) => setV({ ...v, [f.key]: e.target.checked ? '1' : '' })} /> {f.label}
            </label>
          ) : (
            <label key={f.key}>
              {f.label}{f.optional && <span className="muted"> (optional)</span>}
              {f.options ? (
                <select value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>
                  {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.multiline ? (
                <textarea rows={4} autoFocus={i === 0} placeholder={f.placeholder} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
              ) : (
                <input autoFocus={i === 0} placeholder={f.placeholder} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
              )}
              {f.hint && <span className="hint">{f.hint}</span>}
            </label>
          )
        )}
        <div className="row end">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className={danger ? 'danger solid' : 'primary'} disabled={missing || busy}>{busy ? 'Working…' : submit}</button>
        </div>
      </form>
    </Modal>
  )
}

const RESET_MODES = [
  { id: 'soft', title: 'Soft', text: 'Keep all changes, staged. Only the commits are undone.' },
  { id: 'mixed', title: 'Mixed', text: 'Keep all changes, unstaged. The default.' },
  { id: 'hard', title: 'Hard', text: 'Throw away every change after this commit, including uncommitted work. Cannot be undone.' }
] as const

export function ResetDialog({ repo, commit, branch, onClose, done }: { repo: Repo; commit: Commit; branch: string | null; onClose: () => void; done: () => Promise<void> }) {
  const { act } = useApp()
  const [mode, setMode] = useState<'soft' | 'mixed' | 'hard'>('mixed')
  const go = async () => {
    const r = await act(() => api.resetTo(repo.id, commit.sha, mode), `Reset ${branch ?? 'HEAD'} to ${commit.shortSha}`)
    await done()
    if (r !== undefined) onClose()
  }
  return (
    <Modal title="Reset to commit" onClose={onClose}>
      <div className="dlg-intro">
        Move <b>{branch ?? 'HEAD'}</b> back to <code>{commit.shortSha}</code> “{commit.subject}”. Commits after it leave the branch.
      </div>
      <div className="choice-list">
        {RESET_MODES.map((m) => (
          <label key={m.id} className={`choice ${mode === m.id ? 'sel' : ''} ${m.id === 'hard' ? 'danger' : ''}`}>
            <input type="radio" name="reset" checked={mode === m.id} onChange={() => setMode(m.id)} />
            <span><b>{m.title}</b><span className="sub">{m.text}</span></span>
          </label>
        ))}
      </div>
      <div className="row end">
        <button onClick={onClose}>Cancel</button>
        <button className={mode === 'hard' ? 'danger solid' : 'primary'} onClick={go}>Reset ({mode})</button>
      </div>
    </Modal>
  )
}

const ACTIONS: { id: RebaseAction; label: string; title: string }[] = [
  { id: 'pick', label: 'Keep', title: 'Keep the commit as it is' },
  { id: 'reword', label: 'Edit message', title: 'Keep the changes, change the message' },
  { id: 'squash', label: 'Squash', title: 'Combine into the commit below it and merge both messages' },
  { id: 'fixup', label: 'Fixup', title: 'Combine into the commit below it, keeping only that message' },
  { id: 'drop', label: 'Drop', title: 'Remove the commit and its changes' }
]

interface Row {
  c: Commit
  action: RebaseAction
  message: string
}

/**
 * Rewrite history from a commit up to HEAD: reorder (drag or arrows), edit messages, squash, fixup, drop.
 * Shown newest first like the history list; git gets it oldest first.
 */
export function RebaseDialog({ repo, from, focus, preset, unpushed, onClose, done }: {
  repo: Repo
  from: string
  /** Commit the user right-clicked; its row is highlighted. */
  focus?: string
  preset?: RebaseAction
  unpushed: Set<string>
  onClose: () => void
  done: () => Promise<void>
}) {
  const { act } = useApp()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<number | null>(null)
  const [orig, setOrig] = useState('')

  useEffect(() => {
    api.rebasePlan(repo.id, from).then(
      (list) => (setOrig(list.map((c) => c.sha).reverse().join()), setRows(list.reverse().map((c) => ({ c, action: c.sha === focus && preset ? preset : 'pick', message: c.sha === focus && preset === 'reword' ? c.subject : '' })))),
      (e) => setError((e as Error).message)
    )
  }, [repo.id, from, focus, preset])

  const move = (i: number, to: number) => {
    if (!rows || to < 0 || to >= rows.length) return
    const next = [...rows]
    const [r] = next.splice(i, 1)
    next.splice(to, 0, r)
    setRows(next)
  }
  const set = (i: number, p: Partial<Row>) => setRows(rows!.map((r, k) => (k === i ? { ...r, ...p } : r)))

  const oldestFirst = rows ? [...rows].reverse() : []
  const bottomSquashes = oldestFirst[0] && (oldestFirst[0].action === 'squash' || oldestFirst[0].action === 'fixup')
  const pushed = rows?.filter((r) => !unpushed.has(r.c.sha)).length ?? 0
  const reordered = !!rows && rows.map((r) => r.c.sha).join() !== orig
  const changedAnything = reordered || !!rows?.some((r) => r.action !== 'pick')

  const run = async () => {
    if (!rows) return
    setBusy(true)
    const steps = oldestFirst.map((r) => ({ sha: r.c.sha, action: r.action, message: r.message.trim() || undefined }))
    const r = await act(() => api.rebaseRun(repo.id, from, steps), 'History rewritten')
    setBusy(false)
    await done()
    if (r !== undefined) onClose()
  }

  return (
    <Modal title="Rewrite history" onClose={onClose} wide>
      {error ? <div className="err-text">{error}</div> : !rows ? <Spinner /> : <>
        <div className="dlg-intro">
          Newest at the top. Drag or use the arrows to reorder. <b>Squash</b> and <b>Fixup</b> fold a commit into the one below it.
          Uncommitted changes are stashed and restored automatically.
        </div>
        {pushed > 0 && (
          <div className="warn-box">
            {pushed} of these commit{pushed === 1 ? ' is' : 's are'} already pushed. Rewriting them means you'll need to <b>force push</b>, which affects anyone else using this branch.
          </div>
        )}
        <div className="rb-list">
          {rows.map((r, i) => (
            <div
              key={r.c.sha}
              className={`rb-row a-${r.action} ${r.c.sha === focus ? 'focus' : ''} ${drag === i ? 'dragging' : ''}`}
              draggable
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => (e.preventDefault(), drag !== null && drag !== i && (move(drag, i), setDrag(i)))}
              onDragEnd={() => setDrag(null)}
            >
              <span className="rb-grip" title="Drag to reorder">⋮⋮</span>
              <div className="rb-arrows">
                <button className="icon small" style={i === 0 ? { visibility: 'hidden' } : undefined} onClick={() => move(i, i - 1)} title="Move up (newer)">▲</button>
                <button className="icon small" style={i === rows.length - 1 ? { visibility: 'hidden' } : undefined} onClick={() => move(i, i + 1)} title="Move down (older)">▼</button>
              </div>
              <div className="rb-main">
                <div className="rb-subject"><code>{r.c.shortSha}</code> {r.c.subject}{!unpushed.has(r.c.sha) && <span className="pill" title="Already on the remote">pushed</span>}</div>
                {(r.action === 'reword' || ((r.action === 'squash' || r.action === 'fixup') && (i === 0 || (rows[i - 1].action !== 'squash' && rows[i - 1].action !== 'fixup')))) && (
                  <textarea
                    rows={2}
                    placeholder={r.action === 'reword' ? 'New commit message' : 'Message for the combined commit (empty = keep git’s default)'}
                    value={r.message}
                    onChange={(e) => set(i, { message: e.target.value })}
                  />
                )}
              </div>
              <select value={r.action} onChange={(e) => set(i, { action: e.target.value as RebaseAction, message: e.target.value === 'reword' && !r.message ? r.c.subject : r.message })}>
                {/* The bottom (oldest) commit has nothing below it to squash into. */}
                {ACTIONS.filter((a) => i < rows.length - 1 || (a.id !== 'squash' && a.id !== 'fixup')).map((a) => <option key={a.id} value={a.id} title={a.title}>{a.label}</option>)}
              </select>
            </div>
          ))}
        </div>
        {bottomSquashes && <div className="err-text">The bottom (oldest) commit can't be squashed: there's nothing below it to combine with.</div>}
        <div className="row end">
          <span className="muted grow">{rows.length} commit{rows.length === 1 ? '' : 's'}{reordered ? ' · reordered' : ''}</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || bottomSquashes || !changedAnything} onClick={run}>{busy ? 'Rewriting…' : 'Rewrite history'}</button>
        </div>
      </>}
    </Modal>
  )
}
