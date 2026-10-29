import { useState, type ReactNode } from 'react'
import type { Repo, RepoState } from '../../../shared/types'
import { api } from '../api'
import { AccountBadge, Tabs, methodLabel, useApp, useLoad } from './ui'
import { useMenu } from './menu'
import { FormDialog } from './GitDialogs'
import { RepoTools } from './RepoTools'
import { Changes } from './Changes'
import { History } from './History'
import { Branches } from './Branches'
import { Pulls, Issues, Actions, RepoSettings } from './GitHubTabs'

type Tab = 'changes' | 'history' | 'branches' | 'tools' | 'pulls' | 'issues' | 'actions' | 'settings'

export function RepoView({ repo, onRemoved }: { repo: Repo; onRemoved: () => void }) {
  const { state, summaries, act, reload, refreshSummaries, accountById, busy } = useApp()
  const [tab, setTab] = useState<Tab>('changes')
  const [version, setVersion] = useState(0)
  const [openMenu, menu] = useMenu()
  const [dialog, setDialog] = useState<ReactNode>(null)
  // Optional decoration: a failure here must never pop an error.
  const { data: rs } = useLoad(() => api.repoState(repo.id).catch(() => null), [repo.id, version])
  const s = summaries[repo.id]
  const acct = accountById(s?.effectiveAccountId)
  const changes = s ? s.staged + s.unstaged + s.untracked + s.conflicted : 0

  /** Call after anything that changes the repo, so every tab and the sidebar re-read it. */
  const changed = async () => {
    setVersion((v) => v + 1)
    await refreshSummaries([repo.id])
  }

  const net = async (label: string, fn: () => Promise<unknown>) => {
    const ok = await act(fn, `${label} done${acct ? ` as ${acct.login}` : ''}`)
    await changed()
    return ok
  }

  const setAccount = async (v: string) => {
    await act(() => api.setRepoAccount(repo.id, v || null))
    await reload()
    await refreshSummaries([repo.id])
  }

  const setGroup = async (v: string) => {
    await act(() => api.setRepoGroup([repo.id], v || null))
    await reload()
  }

  const ghUrl = s?.owner ? `https://github.com/${s.owner}/${s.repoName}` : null
  const hasGitHub = !!s?.owner

  return (
    <div className="page repo">
      <div className="repo-head">
        <div className="repo-title">
          <h2>{repo.name}</h2>
          <div className="sub">
            <a onClick={() => api.openPath(repo.path)} title="Open folder">{repo.path}</a>
            {s?.remoteUrl && <> · <span title="origin">{s.remoteUrl}</span></>}
          </div>
          {s?.error && <div className="err-text">{s.error}</div>}
        </div>
        <div className="repo-controls">
          <label className="inline">Account
            <select value={repo.accountId ?? ''} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Auto-detect{!repo.accountId && acct ? ` (${acct.login})` : !repo.accountId ? ' (none matched)' : ''}</option>
              {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.login} · {methodLabel(a)}</option>)}
            </select>
          </label>
          <label className="inline">Group
            <select value={repo.groupId ?? ''} onChange={(e) => setGroup(e.target.value)}>
              <option value="">Ungrouped</option>
              {state.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="toolbar">
        <span className="branch-chip" title="Current branch">⎇ {s?.branch ?? 'detached'}</span>
        {s?.upstream ? <span className="muted">→ {s.upstream}</span> : <span className="muted">no upstream</span>}
        <AccountBadge account={acct} />
        <span className="grow" />
        <button disabled={busy} onClick={() => net('Fetch', () => api.fetch(repo.id))}>⇣ Fetch</button>
        <div className="split-btn">
          <button disabled={busy} onClick={() => net('Pull', () => api.pull(repo.id))}>↓ Pull{s?.behind ? ` (${s.behind})` : ''}</button>
          <button disabled={busy} title="Pull options" onClick={(e) => openMenu(e, [
            { label: 'Pull (merge)', hint: 'default', onClick: () => net('Pull', () => api.pull(repo.id, 'merge')) },
            { label: 'Pull with rebase', hint: 'linear history', onClick: () => net('Pull --rebase', () => api.pull(repo.id, 'rebase')) },
            { label: 'Pull fast-forward only', hint: 'never merges', onClick: () => net('Pull --ff-only', () => api.pull(repo.id, 'ff-only')) },
            'sep',
            { label: 'Fetch all remotes', onClick: () => net('Fetch', () => api.fetch(repo.id)) }
          ])}>▾</button>
        </div>
        <button disabled={busy} className="primary" onClick={() => net('Push', () => api.push(repo.id))}>↑ Push{s?.ahead ? ` (${s.ahead})` : ''}</button>
        <button disabled={busy} title="git push --force-with-lease" onClick={() => confirm('Force push (with lease)? This rewrites the remote branch.') && net('Force push', () => api.push(repo.id, { force: true }))}>⇈</button>
        {ghUrl && <button onClick={() => api.openExternal(ghUrl)}>Open on GitHub ↗</button>}
        <button onClick={() => api.openPath(repo.path)}>Open folder</button>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'changes', label: <>Changes {changes > 0 && <span className="count">{changes}</span>}</> },
          { id: 'history', label: 'History' },
          { id: 'branches', label: 'Branches & stash' },
          { id: 'tools', label: 'Tags & remotes' },
          ...(hasGitHub ? [
            { id: 'pulls' as Tab, label: 'Pull requests' },
            { id: 'issues' as Tab, label: 'Issues' },
            { id: 'actions' as Tab, label: 'Actions' }
          ] : []),
          { id: 'settings', label: 'Settings' }
        ]}
      />
      {rs && <OperationBanner repo={repo} rs={rs} changed={changed} setDialog={setDialog} />}
      <div className="tab-body">
        {tab === 'changes' && <Changes repo={repo} version={version} changed={changed} net={net} />}
        {tab === 'history' && <History repo={repo} version={version} changed={changed} />}
        {tab === 'branches' && <Branches repo={repo} version={version} changed={changed} />}
        {tab === 'tools' && <RepoTools repo={repo} version={version} changed={changed} />}
        {tab === 'pulls' && <Pulls repo={repo} branch={s?.branch ?? null} />}
        {tab === 'issues' && <Issues repo={repo} />}
        {tab === 'actions' && <Actions repo={repo} branch={s?.branch ?? null} />}
        {tab === 'settings' && <RepoSettings repo={repo} hasGitHub={hasGitHub} onRemoved={onRemoved} />}
      </div>
      {menu}
      {dialog}
    </div>
  )
}

const OP_LABEL = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' }

/** Shown on every tab while a merge/rebase/cherry-pick/revert is stopped, or when HEAD is detached. */
function OperationBanner({ repo, rs, changed, setDialog }: { repo: Repo; rs: RepoState; changed: () => Promise<void>; setDialog: (n: ReactNode) => void }) {
  const { act, busy } = useApp()
  const op = (what: 'continue' | 'skip' | 'abort', ok: string) => act(() => api.operation(repo.id, what), ok).then(changed)

  if (rs.operation) {
    const label = OP_LABEL[rs.operation]
    return (
      <div className={`op-banner ${rs.conflicted ? 'conflict' : ''}`}>
        <span className="op-icon">{rs.conflicted ? '⚠' : '⏸'}</span>
        <div className="grow">
          <b>{label} in progress</b> · {rs.detail}
          <div className="sub">
            {rs.conflicted
              ? <>{rs.conflicted} file{rs.conflicted === 1 ? ' has' : 's have'} conflicts. Resolve them in <b>Changes</b> (right-click a file for “Use ours / Use theirs”), then continue.</>
              : <>No conflicts left. Continue to finish the {label.toLowerCase()}.</>}
          </div>
        </div>
        <button className="primary" disabled={busy || rs.conflicted > 0} onClick={() => op('continue', `${label} continued`)}>Continue</button>
        {rs.operation !== 'merge' && <button disabled={busy} onClick={() => op('skip', 'Skipped this commit')} title="Leave this commit out and go on">Skip</button>}
        <button className="danger" disabled={busy} onClick={() => confirm(`Abort the ${label.toLowerCase()} and go back to where you were?`) && op('abort', `${label} aborted`)}>Abort</button>
      </div>
    )
  }
  if (rs.detachedAt) {
    return (
      <div className="op-banner detached">
        <span className="op-icon">⎇</span>
        <div className="grow">
          <b>Not on a branch</b> · HEAD is at <code>{rs.detachedAt}</code>
          <div className="sub">New commits here won't belong to any branch. Create a branch to keep them, or switch back in Branches & stash.</div>
        </div>
        <button className="primary" onClick={() => setDialog(
          <FormDialog title="Create branch here" submit="Create & switch" onClose={() => setDialog(null)}
            fields={[{ key: 'name', label: 'Branch name', placeholder: 'my-branch' }]}
            onSubmit={(v) => act(() => api.createBranch(repo.id, v.name.trim()), `Created ${v.name.trim()}`).then(async (r) => (await changed(), r))} />
        )}>Create branch here</button>
      </div>
    )
  }
  return null
}
