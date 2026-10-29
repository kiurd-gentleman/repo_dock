import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Repo, RepoState, RepoSummary } from '../../../shared/types'
import { api } from '../api'
import { AccountBadge, Spinner, Tabs, ago, methodLabel, useApp, useLoad } from './ui'
import { statesOf } from './Dashboard'
import { useMenu } from './menu'
import { FormDialog } from './GitDialogs'
import { RepoTools } from './RepoTools'
import { Changes } from './Changes'
import { History } from './History'
import { Branches, branchRows } from './Branches'
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
  const group = state.groups.find((g) => g.id === repo.groupId)
  const main = statesOf(s)[0] ?? 'loading'
  const hint = s ? nextStep(s, !!acct, changes) : null

  const forcePush = () => confirm(`Force push ${s?.branch ?? 'this branch'}? This replaces the remote branch with yours. It refuses if someone else pushed in the meantime (--force-with-lease).`) && net('Force push', () => api.push(repo.id, { force: true }))

  return (
    <div className="page repo">
      <header className="rh">
        <div className="rh-title">
          <h2>{repo.name}</h2>
          <div className="rh-where">
            <span title={s?.remoteUrl ?? 'No remote'}>{s?.owner ? `${s.owner}/${s.repoName}` : s?.remoteUrl ? 'Remote outside GitHub' : 'Local only, no remote'}</span>
            <a onClick={() => api.openPath(repo.path)} title="Open this folder">{repo.path}</a>
            {ghUrl && <a onClick={() => api.openExternal(ghUrl)}>GitHub ↗</a>}
          </div>
        </div>
      </header>

      <section className={`rh-status s-${main}`}>
        <div className="rh-facts">
          <Fact label="Branch">
            <BranchSwitcher repo={repo} current={s?.branch ?? null} version={version} changed={changed} manage={() => setTab('branches')} />
            {s?.upstream && <span className="muted">→ {s.upstream}</span>}
          </Fact>
          <Fact label="Working tree">
            {!s ? '…' : changes === 0 ? <span className="ok-text">✓ Clean</span> : (
              <span className="ov-wt">
                {s.conflicted > 0 && <span className="err-text"><b>{s.conflicted}</b> conflict{s.conflicted === 1 ? '' : 's'}</span>}
                {s.unstaged > 0 && <span><b>{s.unstaged}</b> changed</span>}
                {s.untracked > 0 && <span><b>{s.untracked}</b> new</span>}
                {s.staged > 0 && <span className="muted"><b>{s.staged}</b> staged</span>}
              </span>
            )}
          </Fact>
          <Fact label="Remote">
            {!s ? '…' : !s.remoteUrl ? <span className="muted">No remote</span> : !s.upstream ? <span className="muted">Not published</span> : !s.ahead && !s.behind ? <span className="muted">Up to date</span> : (
              <span className="ov-sync">
                {s.behind > 0 && <span className="pull-text"><b>{s.behind}</b> to pull</span>}
                {s.ahead > 0 && <span className="accent-text"><b>{s.ahead}</b> to push</span>}
              </span>
            )}
          </Fact>
          <Fact label="Signs in as">
            <button className="rh-pick" onClick={(e) => openMenu(e, [
              { heading: 'Account for fetch, pull and push' },
              { label: <>Auto-detect{acct && !repo.accountId ? <span className="muted"> ({acct.login})</span> : ''}</>, hint: repo.accountId ? undefined : '✓', onClick: () => setAccount('') },
              ...state.accounts.map((a) => ({ label: <><AccountBadge account={a} size={16} /> <span className="muted">{methodLabel(a)}</span></>, hint: repo.accountId === a.id ? '✓' : undefined, onClick: () => setAccount(a.id) }))
            ])}>
              {acct ? <AccountBadge account={acct} /> : <span className="err-text">No account</span>}
              <span className="caret-down">▾</span>
            </button>
          </Fact>
          <Fact label="Group">
            <button className="rh-pick" onClick={(e) => openMenu(e, [
              ...state.groups.map((g) => ({ label: <><span className="dot" style={{ background: g.color }} /> {g.name}</>, hint: g.id === repo.groupId ? '✓' : undefined, onClick: () => setGroup(g.id) })),
              { label: <><span className="dot hollow" /> Ungrouped</>, hint: repo.groupId ? undefined : '✓', onClick: () => setGroup('') }
            ])}>
              {group ? <><span className="dot" style={{ background: group.color }} /> {group.name}</> : <span className="muted">Ungrouped</span>}
              <span className="caret-down">▾</span>
            </button>
          </Fact>
        </div>
        <div className="rh-foot">
          {hint && <p className={`rh-hint ${hint.tone}`}>{hint.text}</p>}
          {s?.remoteUrl && <div className="rh-sync">
            <button disabled={busy} onClick={() => net('Fetch', () => api.fetch(repo.id))} title="Download what's new on the remote. Nothing local changes.">⇣ Fetch</button>
            {s.upstream && <div className="split-btn">
              <button disabled={busy} className={s?.behind ? 'primary' : ''} onClick={() => net('Pull', () => api.pull(repo.id))}>↓ Pull{s?.behind ? ` ${s.behind}` : ''}</button>
            <button disabled={busy} title="Pull options" onClick={(e) => openMenu(e, [
              { label: 'Pull (merge)', hint: 'default', onClick: () => net('Pull', () => api.pull(repo.id, 'merge')) },
              { label: 'Pull with rebase', hint: 'linear history', onClick: () => net('Pull --rebase', () => api.pull(repo.id, 'rebase')) },
              { label: 'Pull fast-forward only', hint: 'never merges', onClick: () => net('Pull --ff-only', () => api.pull(repo.id, 'ff-only')) },
              'sep',
              { label: 'Fetch all remotes', onClick: () => net('Fetch', () => api.fetch(repo.id)) }
            ])}>▾</button>
            </div>}
            {s.branch && <div className="split-btn">
              {!s.upstream
                ? <button disabled={busy} className="primary" onClick={() => net('Publish', () => api.push(repo.id))} title="Put this branch on the remote and track it">↑ Publish branch</button>
                : <button disabled={busy} className={s.ahead && !s.behind ? 'primary' : ''} onClick={() => net('Push', () => api.push(repo.id))}>↑ Push{s.ahead ? ` ${s.ahead}` : ''}</button>}
              <button disabled={busy} title="Push options" onClick={(e) => openMenu(e, [
                { label: 'Push all tags', onClick: () => net('Push tags', () => api.pushAllTags(repo.id)) },
                !!s.upstream && s.ahead > 0 && 'sep',
                !!s.upstream && s.ahead > 0 && { label: 'Force push…', hint: 'with lease', danger: true, onClick: forcePush }
              ])}>▾</button>
            </div>}
          </div>}
        </div>
      </section>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'changes', label: <>Changes {changes > 0 && <span className="count">{changes}</span>}</> },
          { id: 'history', label: 'History' },
          { id: 'branches', label: 'Branches' },
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

/** Branch name that opens a searchable list: switch, check out a remote branch, or create one. */
function BranchSwitcher({ repo, current, version, changed, manage }: { repo: Repo; current: string | null; version: number; changed: () => Promise<void>; manage: () => void }) {
  const { act } = useApp()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const { data: branches } = useLoad(async () => (open ? api.branches(repo.id) : null), [repo.id, version, open])

  useEffect(() => {
    if (!open) return setQ('')
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => (window.removeEventListener('mousedown', down), window.removeEventListener('keydown', key))
  }, [open])

  const rows = branches ? branchRows(branches).filter((r) => !q || r.key.toLowerCase().includes(q.toLowerCase())) : []
  const local = rows.filter((r) => r.local).sort((a, b) => Number(b.current) - Number(a.current) || b.local!.date - a.local!.date)
  const remoteOnly = rows.filter((r) => !r.local).sort((a, b) => b.remote!.date - a.remote!.date)
  const exact = branches && q.trim() && branchRows(branches).some((r) => r.key === q.trim())

  const go = async (fn: () => Promise<unknown>, ok: string) => {
    setOpen(false)
    await act(fn, ok)
    await changed()
  }

  return (
    <div className="bs" ref={ref}>
      <button className={`bs-btn ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Switch branch" aria-expanded={open}>
        ⎇ {current ?? 'No branch'} <span className="caret-down">▾</span>
      </button>
      {open && (
        <div className="bs-pop" role="dialog" aria-label="Switch branch">
          <input
            autoFocus
            type="search"
            placeholder="Find or create a branch…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const first = local.find((r) => !r.current) ?? remoteOnly[0]
              if (q.trim() && !exact) go(() => api.createBranch(repo.id, q.trim()), `Created ${q.trim()}`)
              else if (first?.local) go(() => api.checkout(repo.id, first.local!.name, false), `Switched to ${first.key}`)
              else if (first?.remote) go(() => api.checkout(repo.id, first.remote!.name, true), `Checked out ${first.key}`)
            }}
          />
          {q.trim() && !exact && (
            <button className="bs-create" onClick={() => go(() => api.createBranch(repo.id, q.trim()), `Created ${q.trim()}`)}>
              + Create <b>{q.trim()}</b> from {current ?? 'HEAD'}
            </button>
          )}
          <div className="bs-list">
            {!branches && <Spinner />}
            {local.length > 0 && <div className="bs-group">On this PC</div>}
            {local.map((r) => (
              <button key={r.key} className={`bs-item ${r.current ? 'cur' : ''}`} disabled={r.current} onClick={() => go(() => api.checkout(repo.id, r.local!.name, false), `Switched to ${r.key}`)}>
                <span className="bs-name">{r.current ? '✓ ' : ''}{r.key}</span>
                <span className="bs-meta">{r.local!.upstream ? '' : 'not published · '}{ago(r.local!.date)}</span>
              </button>
            ))}
            {remoteOnly.length > 0 && <div className="bs-group">Only on the remote: check out to work on it</div>}
            {remoteOnly.map((r) => (
              <button key={r.key} className="bs-item" onClick={() => go(() => api.checkout(repo.id, r.remote!.name, true), `Checked out ${r.key}`)}>
                <span className="bs-name">☁ {r.key}</span>
                <span className="bs-meta">{ago(r.remote!.date)}</span>
              </button>
            ))}
            {branches && !rows.length && <div className="bs-empty">No branch matches “{q}”.</div>}
          </div>
          <button className="bs-manage" onClick={() => (setOpen(false), manage())}>Manage branches, merge and compare →</button>
        </div>
      )}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rh-fact">
      <span className="rh-label">{label}</span>
      <div className="rh-value">{children}</div>
    </div>
  )
}

/** The single most useful thing to do next, in plain words. */
function nextStep(s: RepoSummary, hasAccount: boolean, changes: number): { text: string; tone: string } {
  const up = s.upstream ?? 'the remote'
  const n = (x: number, one: string, many = one + 's') => `${x} ${x === 1 ? one : many}`
  if (!s.exists) return { tone: 'bad', text: 'The folder no longer exists. It was moved or deleted; remove it here or add it again from its new place.' }
  if (s.error) return { tone: 'bad', text: s.error.split('\n')[0] }
  if (s.conflicted) return { tone: 'bad', text: `${n(s.conflicted, 'file has', 'files have')} conflicts. Resolve them in Changes, then continue.` }
  if (s.owner && !hasAccount) return { tone: 'bad', text: `No account matches “${s.owner}”. Pick one under Signs in as, or add it in Accounts.` }
  if (s.ahead && s.behind) return { tone: 'warn', text: `Your branch and ${up} have diverged: pull first (merge or rebase), then push.` }
  if (s.behind) return { tone: 'info', text: `${n(s.behind, 'new commit')} on ${up}. Pull to bring ${s.behind === 1 ? 'it' : 'them'} in.` }
  if (changes) return { tone: 'info', text: `${n(changes, 'uncommitted change')}. Review and commit in Changes.` }
  if (s.ahead) return { tone: 'info', text: `${n(s.ahead, 'commit')} not pushed yet. Push to share ${s.ahead === 1 ? 'it' : 'them'}.` }
  if (s.remoteUrl && !s.upstream && s.branch) return { tone: 'info', text: `${s.branch} is not on the remote yet. Push to publish it.` }
  return { tone: 'good', text: 'Everything is committed, pushed and up to date.' }
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
