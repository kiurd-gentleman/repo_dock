import { useState, type ReactNode } from 'react'
import type { Branch, Repo, Stash } from '../../../shared/types'
import { api } from '../api'
import { Diff, Modal, Spinner, ago, useApp, useLoad } from './ui'
import { useMenu, type MenuEntry } from './menu'
import { FormDialog } from './GitDialogs'

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
  const { act, busy, summaries } = useApp()
  const [openMenu, menu] = useMenu()
  const [dialog, setDialog] = useState<ReactNode>(null)
  const close = () => setDialog(null)
  const s = summaries[repo.id]
  const ghUrl = s?.owner ? `https://github.com/${s.owner}/${s.repoName}` : null
  const { data: branches } = useLoad(() => api.branches(repo.id), [repo.id, version])
  const { data: stashes } = useLoad(() => api.stashes(repo.id), [repo.id, version])
  const [newName, setNewName] = useState('')
  const [stashMsg, setStashMsg] = useState('')
  const [qLocal, setQLocal] = useState('')
  const [qRemote, setQRemote] = useState('')

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    const r = await act(fn, ok)
    await changed()
    return r
  }

  const match = (b: Branch, q: string) => !q || b.name.toLowerCase().includes(q.toLowerCase())
  const allLocal = (branches ?? []).filter((b) => !b.remote)
  const allRemote = (branches ?? []).filter((b) => b.remote)
  const local = allLocal.filter((b) => match(b, qLocal)).sort((a, b) => Number(b.current) - Number(a.current) || b.date - a.date)
  const remote = allRemote.filter((b) => match(b, qRemote)).sort((a, b) => b.date - a.date)
  const current = allLocal.find((b) => b.current)

  const into = current?.name ?? 'the current branch'
  const mergeItems = (name: string): MenuEntry[] => [
    { heading: `Merge ${name} into ${into}` },
    { label: 'Merge', hint: 'default', onClick: () => run(() => api.merge(repo.id, name, 'merge'), `Merged ${name}`) },
    { label: 'Merge (always create a merge commit)', hint: '--no-ff', onClick: () => run(() => api.merge(repo.id, name, 'no-ff'), `Merged ${name}`) },
    { label: 'Squash and merge', hint: 'one commit', title: 'Stages all of its changes as one; you then commit them in Changes', onClick: () => run(() => api.merge(repo.id, name, 'squash'), `Squashed ${name}: review and commit in Changes`) },
    { label: 'Fast-forward only', hint: '--ff-only', onClick: () => run(() => api.merge(repo.id, name, 'ff-only'), `Fast-forwarded to ${name}`) },
    'sep',
    { label: `Rebase ${into} onto ${name}`, title: 'Replays your commits on top of it (linear history)', onClick: () => confirm(`Rebase ${into} onto ${name}? Your commits are rewritten on top of it.`) && run(() => api.rebaseOnto(repo.id, name), `Rebased onto ${name}`) }
  ]
  const branchFrom = (from: string) => setDialog(
    <FormDialog title={`New branch from ${from}`} submit="Create & switch" onClose={close} fields={[{ key: 'name', label: 'Branch name', placeholder: 'feature/…' }]}
      onSubmit={(v) => run(() => api.createBranch(repo.id, v.name.trim(), from), `Created ${v.name.trim()}`)} />
  )

  const localMenu = (b: Branch): MenuEntry[] => [
    !b.current && { label: 'Switch to this branch', onClick: () => run(() => api.checkout(repo.id, b.name, false), `Switched to ${b.name}`) },
    ...(!b.current ? mergeItems(b.name) : []),
    'sep',
    { label: b.upstream ? 'Push' : 'Publish branch', hint: b.upstream ? undefined : 'push -u', onClick: () => run(() => api.pushBranch(repo.id, b.name), `Pushed ${b.name}`) },
    { label: 'Set upstream…', onClick: () => setDialog(
      <FormDialog title={`Upstream of ${b.name}`} submit="Set upstream" onClose={close}
        intro="Where pull and push go for this branch."
        fields={[{ key: 'up', label: 'Remote branch', initial: b.upstream || allRemote.find((r) => r.name.endsWith('/' + b.name))?.name, options: allRemote.map((r) => ({ value: r.name, label: r.name })) }]}
        onSubmit={(v) => run(() => api.setUpstream(repo.id, b.name, v.up), `Tracking ${v.up}`)} />) },
    b.upstream && { label: 'Stop tracking upstream', onClick: () => run(() => api.setUpstream(repo.id, b.name, null), 'Upstream removed') },
    'sep',
    { label: 'Rename…', onClick: () => setDialog(
      <FormDialog title={`Rename ${b.name}`} submit="Rename" onClose={close} fields={[{ key: 'name', label: 'New name', initial: b.name }]}
        intro={b.upstream ? 'Only the local branch is renamed. The remote branch keeps its name until you publish the new one.' : undefined}
        onSubmit={(v) => run(() => api.renameBranch(repo.id, b.name, v.name.trim()), `Renamed to ${v.name.trim()}`)} />) },
    { label: 'Create branch from here…', onClick: () => branchFrom(b.name) },
    { label: 'Copy name', onClick: () => navigator.clipboard.writeText(b.name) },
    ghUrl && b.upstream && { label: 'View on GitHub', onClick: () => api.openExternal(`${ghUrl}/tree/${b.upstream.split('/').slice(1).join('/')}`) },
    ghUrl && b.upstream && { label: 'Compare on GitHub', onClick: () => api.openExternal(`${ghUrl}/compare/${b.upstream.split('/').slice(1).join('/')}`) },
    !b.current && 'sep',
    !b.current && { label: 'Delete…', danger: true, onClick: () => deleteLocal(b) }
  ]

  const remoteMenu = (b: Branch): MenuEntry[] => {
    const short = b.name.split('/').slice(1).join('/')
    return [
      { label: 'Check out', hint: `as ${short}`, onClick: () => run(() => api.checkout(repo.id, b.name, true), `Checked out ${b.name}`) },
      { label: 'Check out as…', onClick: () => setDialog(
        <FormDialog title={`Check out ${b.name}`} submit="Create & switch" onClose={close} fields={[{ key: 'name', label: 'Local branch name', initial: short }]}
          onSubmit={(v) => run(() => api.createBranch(repo.id, v.name.trim(), b.name), `Created ${v.name.trim()}`)} />) },
      ...mergeItems(b.name),
      'sep',
      { label: 'Copy name', onClick: () => navigator.clipboard.writeText(b.name) },
      ghUrl && { label: 'View on GitHub', onClick: () => api.openExternal(`${ghUrl}/tree/${short}`) },
      'sep',
      { label: 'Delete on remote…', danger: true, onClick: () => confirm(`Delete ${b.name} on the remote?`) && run(() => api.deleteRemoteBranch(repo.id, b.name), 'Remote branch deleted') }
    ]
  }

  const showStash = (st: Stash) => setDialog(<StashView repo={repo} stash={st} onClose={close} />)
  const stashMenu = (st: Stash): MenuEntry[] => [
    { label: 'View changes', onClick: () => showStash(st) },
    { label: 'Pop', hint: 'apply + drop', onClick: () => run(() => api.stashPop(repo.id, st.ref), 'Stash popped') },
    { label: 'Apply', hint: 'keep stash', onClick: () => run(() => api.stashApply(repo.id, st.ref), 'Stash applied') },
    { label: 'Create branch from stash…', onClick: () => setDialog(
      <FormDialog title={`Branch from ${st.ref}`} submit="Create branch" onClose={close} intro="Creates a branch where the stash was made, applies it there and drops it." fields={[{ key: 'name', label: 'Branch name' }]}
        onSubmit={(v) => run(() => api.stashBranch(repo.id, st.ref, v.name.trim()), `Created ${v.name.trim()}`)} />) },
    'sep',
    { label: 'Drop…', danger: true, onClick: () => confirm(`Drop ${st.ref}?`) && run(() => api.stashDrop(repo.id, st.ref), 'Dropped') }
  ]

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
            <div key={b.name} className={`br-row${b.current ? ' current' : ''}`} onContextMenu={(e) => openMenu(e, localMenu(b))}>
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
              <div className={`br-actions${b.current ? ' always' : ''}`}>
                {!b.current && <button disabled={busy} onClick={() => run(() => api.checkout(repo.id, b.name, false), `Switched to ${b.name}`)}>Switch</button>}
                {!b.current && <button disabled={busy} onClick={(e) => openMenu(e, mergeItems(b.name))}>Merge ▾</button>}
                <button disabled={busy} onClick={(e) => openMenu(e, localMenu(b))} title="All actions">⋯</button>
              </div>
            </div>
          ))}
          {!local.length && <div className="empty small">{qLocal ? 'No match' : 'No local branches'}</div>}
        </div>
      </section>

      <section className="card br-card">
        <header className="br-head">
          <h3>Remote branches <span className="count">{allRemote.length}</span></h3>
          <input className="br-filter" placeholder="Filter…" value={qRemote} onChange={(e) => setQRemote(e.target.value)} />
        </header>
        <div className="br-list">
          {remote.map((b) => (
            <div key={b.name} className="br-row" onContextMenu={(e) => openMenu(e, remoteMenu(b))}>
              <div className="br-info">
                <div className="br-name" title={b.name}><span className="br-text">{b.name}</span></div>
                <div className="br-meta"><code>{b.sha}</code><span>{ago(b.date)}</span></div>
              </div>
              <div className="br-actions">
                <button disabled={busy} onClick={() => run(() => api.checkout(repo.id, b.name, true), `Checked out ${b.name}`)}>Check out</button>
                <button disabled={busy} onClick={(e) => openMenu(e, remoteMenu(b))} title="All actions">⋯</button>
              </div>
            </div>
          ))}
          {!remote.length && <div className="empty small">{qRemote ? 'No match' : 'No remote branches (try Fetch)'}</div>}
        </div>
      </section>

      <section className="card br-card br-stash">
        <header className="br-head">
          <h3>Stashes <span className="count">{stashes?.length ?? 0}</span></h3>
          {!!stashes?.length && <button className="link danger-link" onClick={() => confirm(`Delete all ${stashes.length} stashes? This cannot be undone.`) && run(() => api.stashClear(repo.id), 'All stashes cleared')}>Clear all</button>}
        </header>
        <form className="br-new" onSubmit={(e) => (e.preventDefault(), run(() => api.stashSave(repo.id, stashMsg), 'Stashed').then(() => setStashMsg('')))}>
          <input placeholder="Stash message (optional)" value={stashMsg} onChange={(e) => setStashMsg(e.target.value)} />
          <button type="submit" disabled={busy}>Stash changes</button>
        </form>
        <div className="br-list">
          {(stashes ?? []).map((s) => (
            <div key={s.ref} className="br-row" onContextMenu={(e) => openMenu(e, stashMenu(s))}>
              <div className="br-info">
                <div className="br-name" title={s.message}><span className="br-text">{s.message}</span></div>
                <div className="br-meta"><code>{s.ref}</code></div>
              </div>
              <div className="br-actions">
                <button disabled={busy} onClick={() => run(() => api.stashPop(repo.id, s.ref), 'Stash popped')}>Pop</button>
                <button disabled={busy} onClick={() => run(() => api.stashApply(repo.id, s.ref), 'Stash applied')}>Apply</button>
                <button onClick={() => showStash(s)}>View</button>
                <button disabled={busy} onClick={(e) => openMenu(e, stashMenu(s))} title="All actions">⋯</button>
              </div>
            </div>
          ))}
          {!stashes?.length && <div className="empty small">No stashes</div>}
        </div>
      </section>
      {menu}
      {dialog}
    </div>
  )
}

function StashView({ repo, stash, onClose }: { repo: Repo; stash: Stash; onClose: () => void }) {
  const { data, loading } = useLoad(() => api.stashShow(repo.id, stash.ref), [repo.id, stash.ref])
  return (
    <Modal title={`${stash.ref} · ${stash.message}`} onClose={onClose} wide>
      <div className="stash-diff">{loading ? <Spinner /> : <Diff text={data ?? ''} />}</div>
    </Modal>
  )
}
