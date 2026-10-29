import { useEffect, useState, type ReactNode } from 'react'
import type { Remote, Repo, Tag } from '../../../shared/types'
import { api } from '../api'
import { ago, useApp, useLoad } from './ui'
import { useMenu } from './menu'
import { FormDialog } from './GitDialogs'

/** Tags, remotes, per-repo commit identity and maintenance. */
export function RepoTools({ repo, version, changed }: { repo: Repo; version: number; changed: () => Promise<void> }) {
  const { act, busy, summaries } = useApp()
  const { data: tags } = useLoad(() => api.tags(repo.id), [repo.id, version])
  const { data: remotes } = useLoad(() => api.remotes(repo.id), [repo.id, version])
  const [openMenu, menu] = useMenu()
  const [dialog, setDialog] = useState<ReactNode>(null)
  const [q, setQ] = useState('')
  const close = () => setDialog(null)
  const s = summaries[repo.id]
  const ghUrl = s?.owner ? `https://github.com/${s.owner}/${s.repoName}` : null
  const origin = remotes?.find((r) => r.name === 'origin')?.name ?? remotes?.[0]?.name ?? 'origin'

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    const r = await act(fn, ok)
    await changed()
    return r
  }

  const newTag = () => setDialog(
    <FormDialog title="Create tag on HEAD" submit="Create tag" onClose={close}
      intro="To tag an older commit, right-click it in History."
      fields={[{ key: 'name', label: 'Tag name', placeholder: 'v1.0.0' }, { key: 'message', label: 'Message', optional: true, multiline: true, hint: 'With a message it becomes an annotated tag.' }, { key: 'push', label: `Push to ${origin}`, checkbox: true }]}
      onSubmit={async (v) => {
        const name = v.name.trim()
        const ok = await run(() => api.createTag(repo.id, name, 'HEAD', v.message), `Tagged ${name}`)
        if (ok !== undefined && v.push === '1') await run(() => api.pushTag(repo.id, name, origin), `Pushed ${name}`)
        return ok
      }} />
  )

  const tagMenu = (t: Tag, e: React.MouseEvent) => openMenu(e, [
    { label: `Push ${t.name} to ${origin}`, onClick: () => run(() => api.pushTag(repo.id, t.name, origin), `Pushed ${t.name}`) },
    { label: 'Check out tag', hint: 'detached', onClick: () => run(() => api.checkoutCommit(repo.id, t.sha), `Checked out ${t.name}`) },
    { label: 'Create branch from tag…', onClick: () => setDialog(
      <FormDialog title={`Branch from ${t.name}`} submit="Create & switch" onClose={close} fields={[{ key: 'name', label: 'Branch name', placeholder: `from-${t.name}` }]}
        onSubmit={(v) => run(() => api.createBranchAt(repo.id, v.name.trim(), t.sha, true), `Created ${v.name.trim()}`)} />) },
    'sep',
    { label: 'Copy tag name', onClick: () => navigator.clipboard.writeText(t.name) },
    { label: 'Copy commit SHA', onClick: () => navigator.clipboard.writeText(t.sha) },
    ghUrl && { label: 'View release / tag on GitHub', onClick: () => api.openExternal(`${ghUrl}/releases/tag/${encodeURIComponent(t.name)}`) },
    'sep',
    { label: 'Delete local tag', danger: true, onClick: () => confirm(`Delete local tag ${t.name}?`) && run(() => api.deleteTag(repo.id, t.name), `Deleted ${t.name}`) },
    { label: `Delete tag on ${origin}`, danger: true, onClick: () => confirm(`Delete ${t.name} on ${origin}? Others won't see it any more.`) && run(() => api.deleteRemoteTag(repo.id, t.name, origin), `Deleted ${t.name} on ${origin}`) }
  ])

  const remoteDialog = (r?: Remote) => setDialog(
    <FormDialog title={r ? `Edit remote ${r.name}` : 'Add remote'} submit={r ? 'Save' : 'Add remote'} onClose={close}
      fields={[
        { key: 'name', label: 'Name', initial: r?.name ?? (remotes?.length ? 'upstream' : 'origin') },
        { key: 'url', label: 'URL', initial: r?.fetchUrl ?? '', placeholder: 'git@github.com:owner/repo.git', hint: 'SSH or HTTPS both work: RepoDock authenticates with the repo’s account either way.' }
      ]}
      onSubmit={async (v) => {
        const name = v.name.trim()
        if (!r) return run(() => api.addRemote(repo.id, name, v.url), `Added ${name}`)
        if (name !== r.name && (await run(() => api.renameRemote(repo.id, r.name, name), `Renamed to ${name}`)) === undefined) return undefined
        return v.url.trim() !== r.fetchUrl ? run(() => api.setRemoteUrl(repo.id, name, v.url), 'URL updated') : true
      }} />
  )

  const shownTags = (tags ?? []).filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="br-layout">
      <section className="card br-card">
        <header className="br-head">
          <h3>Tags <span className="count">{tags?.length ?? 0}</span></h3>
          <input className="br-filter" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        </header>
        <div className="br-new">
          <button className="primary" disabled={busy} onClick={newTag}>+ New tag on HEAD</button>
          <button disabled={busy || !tags?.length || !remotes?.length} onClick={() => run(() => api.pushAllTags(repo.id, origin), 'All tags pushed')}>↑ Push all tags</button>
          <button disabled={busy || !remotes?.length} onClick={() => run(() => api.fetchRemote(repo.id, origin), 'Fetched tags')}>⇣ Fetch tags</button>
        </div>
        <div className="br-list">
          {shownTags.map((t) => (
            <div key={t.name} className="br-row" onContextMenu={(e) => tagMenu(t, e)}>
              <div className="br-info">
                <div className="br-name" title={t.name}>
                  <span className="br-text">🏷 {t.name}</span>
                  {t.annotated && <span className="pill" title="Annotated tag">annotated</span>}
                </div>
                <div className="br-meta"><code>{t.sha.slice(0, 7)}</code><span>{ago(t.date)}</span>{t.message && <span className="ellipsis" title={t.message}>{t.message}</span>}</div>
              </div>
              <div className="br-actions">
                <button disabled={busy} onClick={() => run(() => api.pushTag(repo.id, t.name, origin), `Pushed ${t.name}`)}>Push</button>
                <button onClick={(e) => tagMenu(t, e)} title="More">⋯</button>
              </div>
            </div>
          ))}
          {!shownTags.length && <div className="empty small">{q ? 'No match' : 'No tags yet. Create one here, or right-click a commit in History.'}</div>}
        </div>
      </section>

      <section className="card br-card">
        <header className="br-head">
          <h3>Remotes <span className="count">{remotes?.length ?? 0}</span></h3>
          <button className="primary small" onClick={() => remoteDialog()}>+ Add remote</button>
        </header>
        <div className="br-list">
          {(remotes ?? []).map((r) => (
            <div key={r.name} className="br-row">
              <div className="br-info">
                <div className="br-name"><span className="br-text">☁ {r.name}</span></div>
                <div className="br-meta"><span className="ellipsis" title={r.fetchUrl}>{r.fetchUrl}</span>{r.pushUrl !== r.fetchUrl && <span title="Push URL">push: {r.pushUrl}</span>}</div>
              </div>
              <div className="br-actions">
                <button disabled={busy} onClick={() => run(() => api.fetchRemote(repo.id, r.name), `Fetched ${r.name}`)}>Fetch</button>
                <button onClick={() => remoteDialog(r)}>Edit</button>
                <button className="danger" onClick={() => confirm(`Remove remote ${r.name}? Its remote-tracking branches go away too. Nothing on the server is deleted.`) && run(() => api.removeRemote(repo.id, r.name), `Removed ${r.name}`)}>Remove</button>
              </div>
            </div>
          ))}
          {!remotes?.length && <div className="empty small">No remotes. Add one, or publish the repo from Settings.</div>}
        </div>
      </section>

      <Identity repo={repo} />
      <Maintenance repo={repo} />
      {menu}
      {dialog}
    </div>
  )
}

function Identity({ repo }: { repo: Repo }) {
  const { act } = useApp()
  const { data, reload } = useLoad(() => api.identity(repo.id), [repo.id])
  const [v, setV] = useState({ name: '', email: '' })
  useEffect(() => data && setV({ name: data.name, email: data.email }), [data])
  const dirty = !!data && (v.name !== data.name || v.email !== data.email)
  return (
    <section className="card br-card">
      <header className="br-head"><h3>Commit identity for this repo</h3></header>
      <div className="tool-body">
        <p className="hint">Who your commits in this repo are signed as. Leave empty to use your global git setting{data?.globalName ? <> (<b>{data.globalName}</b> &lt;{data.globalEmail}&gt;)</> : ''}. Saved in this repo's <code>.git/config</code> only.</p>
        <label>Name<input value={v.name} placeholder={data?.globalName || 'Your Name'} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
        <label>Email<input value={v.email} placeholder={data?.globalEmail || 'you@example.com'} onChange={(e) => setV({ ...v, email: e.target.value })} /></label>
        <div className="row end">
          <button className="primary" disabled={!dirty} onClick={() => act(() => api.setIdentity(repo.id, v.name, v.email), 'Identity saved').then(reload)}>Save</button>
        </div>
      </div>
    </section>
  )
}

const TASKS = [
  { id: 'size', label: 'Repository size', text: 'How much space the history takes.' },
  { id: 'gc', label: 'Clean up & compress', text: 'git gc: packs objects and removes unreachable ones.' },
  { id: 'prune', label: 'Prune deleted remote branches', text: 'Forgets origin branches that no longer exist.' },
  { id: 'fsck', label: 'Check integrity', text: 'git fsck: looks for corrupt or missing objects.' }
] as const

function Maintenance({ repo }: { repo: Repo }) {
  const { act } = useApp()
  const [out, setOut] = useState<{ task: string; text: string } | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const go = async (task: (typeof TASKS)[number]) => {
    setRunning(task.id)
    const text = await act(() => api.maintenance(repo.id, task.id))
    setRunning(null)
    if (text !== undefined) setOut({ task: task.label, text })
  }
  return (
    <section className="card br-card">
      <header className="br-head"><h3>Maintenance</h3></header>
      <div className="tool-body">
        {TASKS.map((t) => (
          <div key={t.id} className="tool-row">
            <div className="grow"><b>{t.label}</b><div className="sub">{t.text}</div></div>
            <button disabled={!!running} onClick={() => go(t)}>{running === t.id ? 'Running…' : 'Run'}</button>
          </div>
        ))}
        {out && <><div className="sub" style={{ marginTop: 8 }}>{out.task}</div><pre className="tool-out">{out.text}</pre></>}
      </div>
    </section>
  )
}
