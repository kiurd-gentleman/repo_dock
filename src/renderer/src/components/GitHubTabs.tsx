import { useEffect, useState } from 'react'
import type { Repo } from '../../../shared/types'
import { api } from '../api'
import { Modal, Spinner, ago, fullDate, useApp, useLoad } from './ui'

type State = 'open' | 'closed' | 'all'

function StateFilter({ value, onChange }: { value: State; onChange: (s: State) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as State)}>
      <option value="open">Open</option>
      <option value="closed">Closed</option>
      <option value="all">All</option>
    </select>
  )
}

/** Conversation view shared by issues and pull requests. */
function Thread({ repo, item, onClose, onChanged }: { repo: Repo; item: any; onClose: () => void; onChanged: () => void }) {
  const { act } = useApp()
  const { data: comments, reload } = useLoad(() => api.ghComments(repo.id, item.number), [item.number])
  const [body, setBody] = useState('')
  const send = async () => {
    if (!body.trim()) return
    if ((await act(() => api.ghComment(repo.id, item.number, body), 'Comment posted')) !== undefined) {
      setBody('')
      reload()
    }
  }
  const toggle = async () => {
    await act(() => api.ghSetState(repo.id, item.number, item.state === 'open' ? 'closed' : 'open'), item.state === 'open' ? 'Closed' : 'Reopened')
    onChanged()
    onClose()
  }
  return (
    <Modal title={`#${item.number} ${item.title}`} onClose={onClose} wide>
      <div className="sub">{item.user?.login} opened {ago(item.created_at)} · <a onClick={() => api.openExternal(item.html_url)}>open on GitHub ↗</a></div>
      <pre className="body">{item.body || '(no description)'}</pre>
      {comments?.map((c: any) => (
        <div key={c.id} className="comment">
          <div className="sub"><b>{c.user.login}</b> · {ago(c.created_at)}</div>
          <pre className="body">{c.body}</pre>
        </div>
      ))}
      <textarea rows={4} placeholder="Leave a comment" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row end">
        <button className={item.state === 'open' ? 'danger' : ''} onClick={toggle}>{item.state === 'open' ? 'Close' : 'Reopen'}</button>
        <button className="primary" onClick={send} disabled={!body.trim()}>Comment</button>
      </div>
    </Modal>
  )
}

export function Pulls({ repo, branch }: { repo: Repo; branch: string | null }) {
  const { act } = useApp()
  const [state, setState] = useState<State>('open')
  const { data, loading, reload } = useLoad(() => api.ghPulls(repo.id, state), [repo.id, state])
  const { data: info } = useLoad(() => api.ghRepo(repo.id), [repo.id])
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<any>(null)
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>('merge')

  const merge = async (pr: any) => {
    if (!confirm(`${method} PR #${pr.number} "${pr.title}" into ${pr.base.ref}?`)) return
    await act(() => api.ghMergePull(repo.id, pr.number, method), `PR #${pr.number} merged`)
    reload()
  }

  return (
    <div>
      <div className="toolbar compact">
        <StateFilter value={state} onChange={setState} />
        <button onClick={reload}>↻</button>
        <span className="grow" />
        <label className="inline">Merge method
          <select value={method} onChange={(e) => setMethod(e.target.value as any)}>
            <option value="merge">Merge commit</option>
            <option value="squash">Squash</option>
            <option value="rebase">Rebase</option>
          </select>
        </label>
        <button className="primary" onClick={() => setCreating(true)}>+ New pull request</button>
      </div>
      {loading ? <Spinner /> : (
        <table className="table">
          <tbody>
            {data?.map((pr: any) => (
              <tr key={pr.id}>
                <td>
                  <a onClick={() => setOpen(pr)}><b>#{pr.number}</b> {pr.title}</a> {pr.draft && <span className="tag">draft</span>} {pr.merged_at && <span className="tag ok">merged</span>}
                  <div className="sub">{pr.head.label} → {pr.base.ref} · {pr.user.login} · {ago(pr.created_at)}</div>
                </td>
                <td className="actions">
                  <button onClick={() => api.openExternal(pr.html_url)}>↗</button>
                  {pr.state === 'open' && !pr.draft && <button className="primary" onClick={() => merge(pr)}>Merge</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && !data?.length && <div className="empty">No {state === 'all' ? '' : state} pull requests</div>}
      {creating && <NewPull repo={repo} head={branch ?? ''} base={info?.default_branch ?? 'main'} onClose={() => setCreating(false)} onDone={reload} />}
      {open && <Thread repo={repo} item={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  )
}

function NewPull({ repo, head, base, onClose, onDone }: { repo: Repo; head: string; base: string; onClose: () => void; onDone: () => void }) {
  const { act } = useApp()
  const [f, setF] = useState({ title: '', head, base, body: '', draft: false })
  useEffect(() => setF((x) => ({ ...x, base })), [base])
  const submit = async () => {
    const pr = await act(() => api.ghCreatePull(repo.id, f), 'Pull request created')
    if (pr) {
      onDone()
      onClose()
    }
  }
  return (
    <Modal title="New pull request" onClose={onClose}>
      <p className="hint">Push your branch first if it isn't on GitHub yet.</p>
      <div className="row">
        <label className="grow">From (head)<input value={f.head} onChange={(e) => setF({ ...f, head: e.target.value })} /></label>
        <label className="grow">Into (base)<input value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })} /></label>
      </div>
      <label>Title<input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label>Description<textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={f.draft} onChange={(e) => setF({ ...f, draft: e.target.checked })} /> Draft</label>
      <div className="row end">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!f.title.trim() || !f.head || !f.base} onClick={submit}>Create</button>
      </div>
    </Modal>
  )
}

export function Issues({ repo }: { repo: Repo }) {
  const { act } = useApp()
  const [state, setState] = useState<State>('open')
  const { data, loading, reload } = useLoad(() => api.ghIssues(repo.id, state), [repo.id, state])
  const [open, setOpen] = useState<any>(null)
  const [creating, setCreating] = useState(false)
  const [f, setF] = useState({ title: '', body: '' })

  const create = async () => {
    if ((await act(() => api.ghCreateIssue(repo.id, f), 'Issue created')) !== undefined) {
      setF({ title: '', body: '' })
      setCreating(false)
      reload()
    }
  }

  return (
    <div>
      <div className="toolbar compact">
        <StateFilter value={state} onChange={setState} />
        <button onClick={reload}>↻</button>
        <span className="grow" />
        <button className="primary" onClick={() => setCreating(true)}>+ New issue</button>
      </div>
      {loading ? <Spinner /> : (
        <table className="table">
          <tbody>
            {data?.map((i: any) => (
              <tr key={i.id}>
                <td>
                  <span className={i.state === 'open' ? 'ok-text' : 'muted'}>{i.state === 'open' ? '◉' : '✓'}</span>{' '}
                  <a onClick={() => setOpen(i)}><b>#{i.number}</b> {i.title}</a>{' '}
                  {i.labels.map((l: any) => <span key={l.id} className="tag" style={{ borderColor: `#${l.color}`, color: `#${l.color}` }}>{l.name}</span>)}
                  <div className="sub">{i.user.login} · {ago(i.created_at)} · 💬 {i.comments}</div>
                </td>
                <td className="actions"><button onClick={() => api.openExternal(i.html_url)}>↗</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && !data?.length && <div className="empty">No {state === 'all' ? '' : state} issues</div>}
      {creating && (
        <Modal title="New issue" onClose={() => setCreating(false)}>
          <label>Title<input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label>Description<textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
          <div className="row end">
            <button onClick={() => setCreating(false)}>Cancel</button>
            <button className="primary" disabled={!f.title.trim()} onClick={create}>Create</button>
          </div>
        </Modal>
      )}
      {open && <Thread repo={repo} item={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  )
}

const runIcon = (r: { status: string; conclusion: string | null }) =>
  r.status !== 'completed' ? <span className="warn-text" title={r.status}>◌</span>
    : r.conclusion === 'success' ? <span className="ok-text" title="success">✓</span>
    : r.conclusion === 'skipped' || r.conclusion === 'cancelled' ? <span className="muted" title={r.conclusion}>⊘</span>
    : <span className="err-text" title={r.conclusion ?? ''}>✕</span>

export function Actions({ repo, branch }: { repo: Repo; branch: string | null }) {
  const { act } = useApp()
  const { data: runs, loading, reload } = useLoad(() => api.ghRuns(repo.id), [repo.id])
  const { data: workflows } = useLoad(() => api.ghWorkflows(repo.id), [repo.id])
  const [sel, setSel] = useState<any>(null)
  const { data: jobs, loading: jl } = useLoad(async () => (sel ? api.ghJobs(repo.id, sel.id) : []), [sel?.id])
  const [log, setLog] = useState<{ name: string; text: string } | null>(null)
  const [wf, setWf] = useState('')
  const [ref, setRef] = useState(branch ?? '')

  // Poll while something is running.
  useEffect(() => {
    if (!runs?.some((r: any) => r.status !== 'completed')) return
    const t = setInterval(reload, 15000)
    return () => clearInterval(t)
  }, [runs, reload])

  const showLog = async (job: any) => {
    const text = await act(() => api.ghJobLog(repo.id, job.id))
    if (text !== undefined) setLog({ name: job.name, text })
  }

  const dispatch = async () => {
    await act(() => api.ghDispatch(repo.id, Number(wf), ref), 'Workflow dispatched (it may take a few seconds to appear)')
    setTimeout(reload, 4000)
  }

  const dispatchable = (workflows ?? []).filter((w: any) => w.state === 'active')

  return (
    <div className="split">
      <div className="split-left wide">
        <div className="toolbar compact">
          <button onClick={reload}>↻</button>
          <select value={wf} onChange={(e) => setWf(e.target.value)}>
            <option value="">Run workflow…</option>
            {dispatchable.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          {wf && <>
            <input style={{ width: 110 }} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="branch" />
            <button className="primary" onClick={dispatch} title="Needs a workflow_dispatch trigger in the workflow file">Run</button>
          </>}
        </div>
        {loading && <Spinner />}
        <div className="commit-list">
          {runs?.map((r: any) => (
            <div key={r.id} className={`commit ${sel?.id === r.id ? 'active' : ''}`} onClick={() => setSel(r)}>
              <div className="commit-subject">{runIcon(r)} {r.display_title}</div>
              <div className="sub">{r.name} #{r.run_number} · {r.event} · ⎇ {r.head_branch} · {r.actor?.login} · {ago(r.created_at)}</div>
            </div>
          ))}
          {!loading && !runs?.length && <div className="empty small">No workflow runs</div>}
        </div>
      </div>
      <div className="split-right">
        {sel ? (
          <div className="commit-detail">
            <h3>{runIcon(sel)} {sel.display_title}</h3>
            <div className="meta-grid">
              <span>Workflow</span><span>{sel.name} #{sel.run_number} (attempt {sel.run_attempt})</span>
              <span>Status</span><span>{sel.status}{sel.conclusion ? ` · ${sel.conclusion}` : ''}</span>
              <span>Branch</span><span>{sel.head_branch} @ <code>{sel.head_sha.slice(0, 7)}</code></span>
              <span>Started</span><span>{fullDate(sel.run_started_at ?? sel.created_at)}</span>
            </div>
            <div className="row">
              <button onClick={() => api.openExternal(sel.html_url)}>Open on GitHub ↗</button>
              {sel.status === 'completed'
                ? <>
                    <button onClick={() => act(() => api.ghRerun(repo.id, sel.id, false), 'Re-run requested').then(reload)}>Re-run all</button>
                    {sel.conclusion === 'failure' && <button onClick={() => act(() => api.ghRerun(repo.id, sel.id, true), 'Re-run of failed jobs requested').then(reload)}>Re-run failed</button>}
                  </>
                : <button className="danger" onClick={() => act(() => api.ghCancelRun(repo.id, sel.id), 'Cancel requested').then(reload)}>Cancel</button>}
            </div>
            {jl ? <Spinner /> : jobs?.map((j: any) => (
              <div key={j.id} className="card job">
                <div className="row">
                  <b className="grow">{runIcon(j)} {j.name}</b>
                  <button onClick={() => showLog(j)}>View log</button>
                </div>
                {j.steps?.map((s: any) => <div key={s.number} className="step">{runIcon(s)} {s.name}</div>)}
              </div>
            ))}
          </div>
        ) : <div className="empty">Select a run</div>}
      </div>
      {log && (
        <Modal title={`Log: ${log.name}`} onClose={() => setLog(null)} wide>
          <pre className="log">{log.text}</pre>
        </Modal>
      )}
    </div>
  )
}

export function RepoSettings({ repo, hasGitHub, onRemoved }: { repo: Repo; hasGitHub: boolean; onRemoved: () => void }) {
  const { act, reload, state, refreshSummaries } = useApp()
  const { data: info, reload: reloadInfo } = useLoad(async () => (hasGitHub ? api.ghRepo(repo.id) : null), [repo.id, hasGitHub])
  const [f, setF] = useState({ description: '', homepage: '', private: false, default_branch: '', archived: false })
  const [confirmName, setConfirmName] = useState('')
  const [pub, setPub] = useState({ accountId: state.accounts[0]?.id ?? '', name: repo.name, description: '', private: true, org: '' })

  useEffect(() => {
    if (info) setF({ description: info.description ?? '', homepage: info.homepage ?? '', private: info.private, default_branch: info.default_branch, archived: info.archived })
  }, [info])

  const remove = async () => {
    if (!confirm('Remove from RepoDock? Files on disk are not touched.')) return
    await act(() => api.removeRepos([repo.id]))
    await reload()
    onRemoved()
  }

  const publish = async () => {
    const r = await act(() => api.ghPublish(repo.id, pub.accountId, { name: pub.name, description: pub.description, private: pub.private, org: pub.org || undefined }), 'Published to GitHub')
    if (r) {
      await reload()
      await refreshSummaries([repo.id])
    }
  }

  const pubAccount = state.accounts.find((a) => a.id === pub.accountId)

  return (
    <div className="columns">
      {hasGitHub && info && (
        <section className="card">
          <h3>GitHub: {info.full_name}</h3>
          <div className="meta-grid">
            <span>Visibility</span><span>{info.visibility}</span>
            <span>Stars / forks</span><span>★ {info.stargazers_count} · ⑂ {info.forks_count} · 👁 {info.subscribers_count ?? info.watchers_count}</span>
            <span>Open issues</span><span>{info.open_issues_count}</span>
            <span>Size</span><span>{(info.size / 1024).toFixed(1)} MB</span>
            <span>Created</span><span>{fullDate(info.created_at)}</span>
            <span>Last push</span><span>{fullDate(info.pushed_at)}</span>
            <span>Your access</span><span>{Object.entries(info.permissions ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ')}</span>
          </div>
          <label>Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label>Website<input value={f.homepage} onChange={(e) => setF({ ...f, homepage: e.target.value })} /></label>
          <label>Default branch<input value={f.default_branch} onChange={(e) => setF({ ...f, default_branch: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={f.private} onChange={(e) => setF({ ...f, private: e.target.checked })} /> Private</label>
          <label className="check"><input type="checkbox" checked={f.archived} onChange={(e) => setF({ ...f, archived: e.target.checked })} /> Archived (read-only)</label>
          <div className="row end">
            <button className="primary" onClick={() => act(() => api.ghUpdateRepo(repo.id, f), 'Saved on GitHub').then(reloadInfo)}>Save to GitHub</button>
          </div>
        </section>
      )}
      {!hasGitHub && (
        <section className="card">
          <h3>Publish to GitHub</h3>
          <p className="hint">Creates a new GitHub repository, sets it as <code>origin</code> and pushes the current branch.</p>
          <label>Account
            <select value={pub.accountId} onChange={(e) => setPub({ ...pub, accountId: e.target.value })}>
              {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.login})</option>)}
            </select>
          </label>
          {pubAccount && pubAccount.orgs.length > 0 && (
            <label>Owner
              <select value={pub.org} onChange={(e) => setPub({ ...pub, org: e.target.value })}>
                <option value="">{pubAccount.login} (personal)</option>
                {pubAccount.orgs.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          )}
          <label>Name<input value={pub.name} onChange={(e) => setPub({ ...pub, name: e.target.value })} /></label>
          <label>Description<input value={pub.description} onChange={(e) => setPub({ ...pub, description: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={pub.private} onChange={(e) => setPub({ ...pub, private: e.target.checked })} /> Private</label>
          <div className="row end"><button className="primary" disabled={!pub.accountId || !pub.name} onClick={publish}>Publish</button></div>
        </section>
      )}
      <section className="card">
        <h3>Local</h3>
        <div className="meta-grid">
          <span>Path</span><span>{repo.path}</span>
          <span>Added</span><span>{fullDate(repo.addedAt)}</span>
        </div>
        <div className="row"><button onClick={remove}>Remove from RepoDock</button></div>
      </section>
      {hasGitHub && info && (
        <section className="card danger-zone">
          <h3>Danger zone</h3>
          <p>Permanently delete <b>{info.full_name}</b> on GitHub. The local folder is kept. Token needs the <code>delete_repo</code> scope.</p>
          <label>Type <code>{info.full_name}</code> to confirm<input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} /></label>
          <div className="row end">
            <button className="danger" disabled={confirmName !== info.full_name} onClick={() => act(() => api.ghDeleteRepo(repo.id, confirmName), 'Deleted on GitHub').then(() => setConfirmName(''))}>Delete on GitHub</button>
          </div>
        </section>
      )}
    </div>
  )
}
