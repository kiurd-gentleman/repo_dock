import { useState } from 'react'
import type { Repo } from '../../../shared/types'
import { api } from '../api'
import { AccountBadge, Tabs, methodLabel, useApp } from './ui'
import { Changes } from './Changes'
import { History } from './History'
import { Branches } from './Branches'
import { Pulls, Issues, Actions, RepoSettings } from './GitHubTabs'

type Tab = 'changes' | 'history' | 'branches' | 'pulls' | 'issues' | 'actions' | 'settings'

export function RepoView({ repo, onRemoved }: { repo: Repo; onRemoved: () => void }) {
  const { state, summaries, act, reload, refreshSummaries, accountById, busy } = useApp()
  const [tab, setTab] = useState<Tab>('changes')
  const [version, setVersion] = useState(0)
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
        <button disabled={busy} onClick={() => net('Pull', () => api.pull(repo.id))}>↓ Pull{s?.behind ? ` (${s.behind})` : ''}</button>
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
          ...(hasGitHub ? [
            { id: 'pulls' as Tab, label: 'Pull requests' },
            { id: 'issues' as Tab, label: 'Issues' },
            { id: 'actions' as Tab, label: 'Actions' }
          ] : []),
          { id: 'settings', label: 'Settings' }
        ]}
      />
      <div className="tab-body">
        {tab === 'changes' && <Changes repo={repo} version={version} changed={changed} net={net} />}
        {tab === 'history' && <History repo={repo} version={version} />}
        {tab === 'branches' && <Branches repo={repo} version={version} changed={changed} />}
        {tab === 'pulls' && <Pulls repo={repo} branch={s?.branch ?? null} />}
        {tab === 'issues' && <Issues repo={repo} />}
        {tab === 'actions' && <Actions repo={repo} branch={s?.branch ?? null} />}
        {tab === 'settings' && <RepoSettings repo={repo} hasGitHub={hasGitHub} onRemoved={onRemoved} />}
      </div>
    </div>
  )
}
