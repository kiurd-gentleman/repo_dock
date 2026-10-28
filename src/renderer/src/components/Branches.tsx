import { useState } from 'react'
import type { Branch, Repo } from '../../../shared/types'
import { api } from '../api'
import { ago, useApp, useLoad } from './ui'

/** "[ahead 1, behind 2]" / "[gone]" → small pills. */
function Track({ track }: { track: string }) {
  if (!track) return null
  if (track.includes('gone')) return <span className="pill err" title="The upstream branch was deleted on the remote">upstream gone</span>
  const ahead = track.match(/ahead (\d+)/)?.[1]
  const behind = track.match(/behind (\d+)/)?.[1]
  return <>
    {ahead && <span className="pill ok" title={`${ahead} commit(s) not pushed`}>↑{ahead}</span>}
    {behind && <span className="pill warn" title={`${behind} commit(s) to pull`}>↓{behind}</span>}
  </>
}

export function Branches({ repo, version, changed }: { repo: Repo; version: number; changed: () => Promise<void> }) {
  const { act, busy } = useApp()
  const { data: branches } = useLoad(() => api.branches(repo.id), [repo.id, version])
  const { data: stashes } = useLoad(() => api.stashes(repo.id), [repo.id, version])
  const [newName, setNewName] = useState('')
  const [stashMsg, setStashMsg] = useState('')
  const [qLocal, setQLocal] = useState('')
  const [qRemote, setQRemote] = useState('')

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    await act(fn, ok)
    await changed()
  }

  const match = (b: Branch, q: string) => !q || b.name.toLowerCase().includes(q.toLowerCase())
  const allLocal = (branches ?? []).filter((b) => !b.remote)
  const allRemote = (branches ?? []).filter((b) => b.remote)
  const local = allLocal.filter((b) => match(b, qLocal)).sort((a, b) => Number(b.current) - Number(a.current) || b.date - a.date)
  const remote = allRemote.filter((b) => match(b, qRemote)).sort((a, b) => b.date - a.date)
  const current = allLocal.find((b) => b.current)

  const create = () => {
    const name = newName.trim()
    if (name) run(() => api.createBranch(repo.id, name), `Created and switched to ${name}`).then(() => setNewName(''))
  }

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

  return (
    <div className="br-layout">
      <section className="card br-card">
        <header className="br-head">
          <h3>Local branches <span className="count">{allLocal.length}</span></h3>
          <input className="br-filter" placeholder="Filter…" value={qLocal} onChange={(e) => setQLocal(e.target.value)} />
        </header>
        <form className="br-new" onSubmit={(e) => (e.preventDefault(), create())}>
          <input placeholder={`New branch from ${current?.name ?? 'HEAD'}`} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button type="submit" className="primary" disabled={!newName.trim() || busy}>Create & switch</button>
        </form>
        <div className="br-list">
          {local.map((b) => (
            <div key={b.name} className={`br-row${b.current ? ' current' : ''}`}>
              <div className="br-info">
                <div className="br-name" title={b.name}>
                  <span className="br-text">{b.name}</span>
                  {b.current && <span className="pill accent">current</span>}
                  <Track track={b.track} />
                </div>
                <div className="br-meta">
                  {b.upstream ? <span title="Upstream">→ {b.upstream}</span> : <span className="warn-text">not pushed</span>}
                  <code>{b.sha}</code>
                  <span>{ago(b.date)}</span>
                </div>
              </div>
              {!b.current && (
                <div className="br-actions">
                  <button disabled={busy} onClick={() => run(() => api.checkout(repo.id, b.name, false), `Switched to ${b.name}`)}>Switch</button>
                  <button disabled={busy} onClick={() => confirm(`Merge ${b.name} into ${current?.name ?? 'the current branch'}?`) && run(() => api.merge(repo.id, b.name), `Merged ${b.name}`)}>Merge in</button>
                  <button className="danger" disabled={busy} onClick={() => deleteLocal(b)}>Delete</button>
                </div>
              )}
            </div>
          ))}
          {!local.length && <div className="empty small">{qLocal ? 'No match' : 'No local branches'}</div>}
        </div>
        <footer className="br-foot">
          <button className="link" onClick={() => run(() => api.abortMerge(repo.id), 'Merge aborted')}>Abort an in-progress merge</button>
        </footer>
      </section>

      <section className="card br-card">
        <header className="br-head">
          <h3>Remote branches <span className="count">{allRemote.length}</span></h3>
          <input className="br-filter" placeholder="Filter…" value={qRemote} onChange={(e) => setQRemote(e.target.value)} />
        </header>
        <div className="br-list">
          {remote.map((b) => (
            <div key={b.name} className="br-row">
              <div className="br-info">
                <div className="br-name" title={b.name}><span className="br-text">{b.name}</span></div>
                <div className="br-meta"><code>{b.sha}</code><span>{ago(b.date)}</span></div>
              </div>
              <div className="br-actions">
                <button disabled={busy} onClick={() => run(() => api.checkout(repo.id, b.name, true), `Checked out ${b.name}`)}>Check out</button>
                <button className="danger" disabled={busy} onClick={() => confirm(`Delete ${b.name} on the remote?`) && run(() => api.deleteRemoteBranch(repo.id, b.name), 'Remote branch deleted')}>Delete</button>
              </div>
            </div>
          ))}
          {!remote.length && <div className="empty small">{qRemote ? 'No match' : 'No remote branches (try Fetch)'}</div>}
        </div>
      </section>

      <section className="card br-card br-stash">
        <header className="br-head">
          <h3>Stashes <span className="count">{stashes?.length ?? 0}</span></h3>
        </header>
        <form className="br-new" onSubmit={(e) => (e.preventDefault(), run(() => api.stashSave(repo.id, stashMsg), 'Stashed').then(() => setStashMsg('')))}>
          <input placeholder="Stash message (optional)" value={stashMsg} onChange={(e) => setStashMsg(e.target.value)} />
          <button type="submit" disabled={busy}>Stash changes</button>
        </form>
        <div className="br-list">
          {(stashes ?? []).map((s) => (
            <div key={s.ref} className="br-row">
              <div className="br-info">
                <div className="br-name" title={s.message}><span className="br-text">{s.message}</span></div>
                <div className="br-meta"><code>{s.ref}</code></div>
              </div>
              <div className="br-actions">
                <button disabled={busy} onClick={() => run(() => api.stashPop(repo.id, s.ref), 'Stash popped')}>Pop</button>
                <button disabled={busy} onClick={() => run(() => api.stashApply(repo.id, s.ref), 'Stash applied')}>Apply</button>
                <button className="danger" disabled={busy} onClick={() => confirm(`Drop ${s.ref}?`) && run(() => api.stashDrop(repo.id, s.ref), 'Dropped')}>Drop</button>
              </div>
            </div>
          ))}
          {!stashes?.length && <div className="empty small">No stashes</div>}
        </div>
      </section>
    </div>
  )
}
