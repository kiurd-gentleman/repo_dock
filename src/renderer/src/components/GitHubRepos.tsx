import { useMemo, useState } from 'react'
import { api } from '../api'
import { Modal, Spinner, ago, useApp, useLoad } from './ui'

/** Browse an account's repositories on GitHub, clone them, or create new ones. */
export function GitHubRepos() {
  const { state, summaries, act, reload, refreshSummaries } = useApp()
  const withToken = state.accounts.filter((a) => a.hasToken)
  const [accountId, setAccountId] = useState(withToken[0]?.id ?? '')
  const [q, setQ] = useState('')
  const [groupId, setGroupId] = useState('')
  const [creating, setCreating] = useState(false)
  const { data, loading, reload: reloadList } = useLoad(async () => (accountId ? api.ghAccountRepos(accountId) : []), [accountId])
  const account = state.accounts.find((a) => a.id === accountId)

  const local = useMemo(() => new Set(Object.values(summaries).filter((s) => s.owner).map((s) => `${s.owner}/${s.repoName}`.toLowerCase())), [summaries])
  const rows = (data ?? []).filter((r: any) => !q || r.full_name.toLowerCase().includes(q.toLowerCase()) || (r.description ?? '').toLowerCase().includes(q.toLowerCase()))

  const clone = async (r: any) => {
    const url = account?.authMethod === 'token' ? r.clone_url : r.ssh_url
    const added = await act(() => api.clone(accountId, url, groupId || null), `Cloned ${r.full_name}`)
    if (added) {
      await reload()
      await refreshSummaries([added.id])
    }
  }

  if (!withToken.length) return <div className="page"><h2>GitHub repos</h2><div className="empty">Add an account with a token to browse its GitHub repositories.</div></div>

  return (
    <div className="page">
      <div className="page-head">
        <h2>GitHub repos</h2>
        <button className="primary" onClick={() => setCreating(true)}>+ New repository</button>
      </div>
      <div className="toolbar">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {withToken.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.login})</option>)}
        </select>
        <input className="grow" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="inline">Clone into group
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Ungrouped</option>
            {state.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <button onClick={reloadList}>↻</button>
      </div>
      {loading ? <Spinner /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Repository</th><th>Visibility</th><th>Language</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <a onClick={() => api.openExternal(r.html_url)}><b>{r.full_name}</b></a> {r.fork && <span className="tag">fork</span>} {r.archived && <span className="tag">archived</span>}
                    {r.description && <div className="sub">{r.description}</div>}
                  </td>
                  <td>{r.private ? '🔒 private' : 'public'}</td>
                  <td>{r.language ?? '—'}</td>
                  <td>{ago(r.pushed_at ?? r.updated_at)}</td>
                  <td className="actions">{local.has(r.full_name.toLowerCase()) ? <span className="ok-text">✓ local</span> : <button onClick={() => clone(r)}>Clone</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sub">{rows.length} of {data?.length ?? 0} repositories</div>
        </div>
      )}
      {creating && account && <CreateRepo accountId={accountId} orgs={account.orgs} login={account.login} onClose={() => setCreating(false)} onDone={reloadList} />}
    </div>
  )
}

function CreateRepo({ accountId, orgs, login, onClose, onDone }: { accountId: string; orgs: string[]; login: string; onClose: () => void; onDone: () => void }) {
  const { act } = useApp()
  const [f, setF] = useState({ name: '', description: '', private: true, org: '', auto_init: true })
  const submit = async () => {
    const r = await act(() => api.ghCreateRepo(accountId, { ...f, org: f.org || undefined }), 'Repository created')
    if (r) {
      onDone()
      onClose()
    }
  }
  return (
    <Modal title="New GitHub repository" onClose={onClose}>
      <label>Owner
        <select value={f.org} onChange={(e) => setF({ ...f, org: e.target.value })}>
          <option value="">{login} (personal)</option>
          {orgs.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
      <label>Name<input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={f.private} onChange={(e) => setF({ ...f, private: e.target.checked })} /> Private</label>
      <label className="check"><input type="checkbox" checked={f.auto_init} onChange={(e) => setF({ ...f, auto_init: e.target.checked })} /> Initialize with a README</label>
      <div className="row end">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!f.name.trim()} onClick={submit}>Create</button>
      </div>
    </Modal>
  )
}
