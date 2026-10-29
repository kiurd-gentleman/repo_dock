import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Commit, CommitDetail, RebaseAction, Repo } from '../../../shared/types'
import { api } from '../api'
import { Avatar, Diff, Spinner, ago, fullDate, leaveForRight, splitPatch, useApp, usePaneWidth, useLoad } from './ui'
import { useMenu, type MenuEntry, type MenuItem } from './menu'
import { FormDialog, RebaseDialog, ResetDialog } from './GitDialogs'
import { RefChips } from './BranchGraph'

const PAGE = 150
const ROW_H = 52
/** Tag names and the HEAD branch decorating a commit (from %D). */
const refInfo = (refs: string) => {
  const parts = refs ? refs.split(', ') : []
  return {
    tags: parts.filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5)),
    isHead: parts.some((r) => r === 'HEAD' || r.startsWith('HEAD -> '))
  }
}

export function History({ repo, version, changed }: { repo: Repo; version: number; changed: () => Promise<void> }) {
  const { toast, act, summaries } = useApp()
  const [openMenu, menu] = useMenu()
  const [dialog, setDialog] = useState<ReactNode>(null)
  const close = () => setDialog(null)
  const pane = usePaneWidth('history', 520, 280, leaveForRight(380))
  // Off: only this branch's own line, where a merged branch is one merge commit. On: every commit reachable from HEAD.
  const [withMerged, setWithMerged] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [commits, setCommits] = useState<Commit[]>([])
  const [more, setMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  // Optional decoration: never surface an error for it.
  const { data: unpushedList } = useLoad(() => api.unpushed(repo.id).catch(() => [] as string[]), [repo.id, version])
  const unpushed = useMemo(() => new Set(unpushedList ?? []), [unpushedList])

  const loadPage = async (skip: number) => {
    setLoading(true)
    try {
      const page = await api.log(repo.id, { skip, limit: PAGE, firstParent: !withMerged, search: query || undefined })
      setCommits((c) => (skip ? [...c, ...page] : page))
      setMore(page.length === PAGE)
      if (!skip && page[0]) setSel((s) => (s && page.some((c) => c.sha === s) ? s : page[0].sha))
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.id, withMerged, query, version])

  const s = summaries[repo.id]
  const branch = s?.branch ?? null
  const ghUrl = s?.owner ? `https://github.com/${s.owner}/${s.repoName}` : null
  const headSha = commits.find((c) => refInfo(c.refs).isHead)?.sha

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    const r = await act(fn, ok)
    await changed()
    return r
  }
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`))
  const rewrite = (from: string, focus: string, preset?: RebaseAction) =>
    setDialog(<RebaseDialog repo={repo} from={from} focus={focus} preset={preset} unpushed={unpushed} onClose={close} done={changed} />)

  /**
   * Only actions that work on this commit. History lists the current branch, so there's no
   * cherry-pick (every commit is already here); rewriting is offered only when no merge commit
   * sits between the commit and HEAD, because an interactive rebase across merges is refused.
   */
  const commitMenu = (c: Commit): MenuEntry[] => {
    const { tags } = refInfo(c.refs)
    const isHead = c.sha === headSha
    const idx = commits.findIndex((x) => x.sha === c.sha)
    const parent = idx >= 0 ? commits[idx + 1] : undefined
    const noMergeUpTo = (i: number) => !query && i >= 0 && commits.slice(0, i + 1).every((x) => x.parents.length <= 1)
    const canRewrite = noMergeUpTo(idx)
    const canSquash = canRewrite && !!parent && parent.sha === c.parents[0] && noMergeUpTo(idx + 1)
    const pushed = !unpushed.has(c.sha)
    const pushedNote = pushed ? 'Already pushed: you will need to force push' : undefined
    return [
      { heading: `${c.shortSha} · ${c.subject.slice(0, 40)}${c.subject.length > 40 ? '…' : ''}` },
      !isHead && { label: 'Checkout commit', hint: 'detached', onClick: () => confirm(`Check out ${c.shortSha}? You'll leave ${branch ?? 'the current branch'} and be on no branch until you switch back or create one.`) && run(() => api.checkoutCommit(repo.id, c.sha), `Checked out ${c.shortSha}`) },
      !isHead && { label: 'Reset to commit…', onClick: () => setDialog(<ResetDialog repo={repo} commit={c} branch={branch} onClose={close} done={changed} />) },
      isHead && c.parents.length > 0 && { label: 'Undo commit', hint: 'keeps changes', title: pushedNote, onClick: () => confirm(`Undo “${c.subject}”? Its changes go back to staged.${pushedNote ? '\n\n' + pushedNote + '.' : ''}`) && run(() => api.undoLastCommit(repo.id), 'Commit undone') },
      'sep',
      isHead ? { label: 'Edit message…', title: pushedNote, onClick: () => editHeadMessage(c) }
        : canRewrite && { label: 'Edit message…', title: pushedNote, onClick: () => rewrite(c.sha, c.sha, 'reword') },
      canRewrite && !isHead && { label: 'Reorder commits…', title: pushedNote, onClick: () => rewrite(c.sha, c.sha) },
      canSquash && { label: 'Squash into previous commit…', title: pushedNote, onClick: () => rewrite(parent!.sha, c.sha, 'squash') },
      canRewrite && !isHead && { label: 'Drop commit…', danger: true, title: pushedNote, onClick: () => rewrite(c.sha, c.sha, 'drop') },
      { label: 'Revert changes in commit', title: 'Adds a new commit that undoes this one', onClick: () => run(() => api.revertCommit(repo.id, c.sha), `Reverted ${c.shortSha}`) },
      'sep',
      { label: 'Create branch from commit…', onClick: () => setDialog(
        <FormDialog title="Create branch" intro={<>New branch at <code>{c.shortSha}</code></>} submit="Create branch" onClose={close}
          fields={[{ key: 'name', label: 'Branch name', placeholder: 'feature/my-change' }, { key: 'checkout', label: 'Switch to it now', checkbox: true, initial: '1' }]}
          onSubmit={(v) => run(() => api.createBranchAt(repo.id, v.name.trim(), c.sha, v.checkout === '1'), `Created ${v.name.trim()}`)} />) },
      { label: 'Create tag…', onClick: () => setDialog(
        <FormDialog title="Create tag" intro={<>Tag <code>{c.shortSha}</code> “{c.subject}”</>} submit="Create tag" onClose={close}
          fields={[
            { key: 'name', label: 'Tag name', placeholder: 'v1.0.0' },
            { key: 'message', label: 'Message', optional: true, multiline: true, hint: 'With a message it becomes an annotated tag (recommended for releases).' },
            ...(s?.remoteUrl ? [{ key: 'push', label: 'Push the tag to origin', checkbox: true }] : [])
          ]}
          onSubmit={async (v) => {
            const name = v.name.trim()
            const ok = await run(() => api.createTag(repo.id, name, c.sha, v.message), `Tagged ${name}`)
            if (ok !== undefined && v.push === '1') await run(() => api.pushTag(repo.id, name), `Pushed tag ${name}`)
            return ok
          }} />) },
      ...tags.map((tag): MenuItem => ({ label: `Delete tag ${tag}`, danger: true, onClick: () => confirm(`Delete local tag ${tag}? (The remote copy, if any, stays. Remove it from the Tags & remotes tab.)`) && run(() => api.deleteTag(repo.id, tag), `Deleted tag ${tag}`) })),
      'sep',
      { label: 'Copy SHA', onClick: () => copy(c.sha, 'Commit id') },
      { label: 'Copy short SHA', onClick: () => copy(c.shortSha, 'Short id') },
      ...tags.map((tag): MenuItem => ({ label: `Copy tag ${tag}`, onClick: () => copy(tag, 'Tag') })),
      { label: 'Copy message', onClick: () => copy(c.subject, 'Message') },
      ghUrl && pushed && { label: 'View on GitHub', onClick: () => api.openExternal(`${ghUrl}/commit/${c.sha}`) }
    ]
  }

  const editHeadMessage = (c: Commit) => setDialog(
    <FormDialog title="Edit commit message" submit="Save message" onClose={close}
      fields={[{ key: 'message', label: 'Message', initial: c.subject, multiline: true }]}
      onSubmit={(v) => run(() => api.amendMessage(repo.id, v.message), 'Message updated')} />
  )

  // A graph only makes sense for an unfiltered, connected history.

  // Arrow keys move through the list.
  const listRef = useRef<HTMLDivElement>(null)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = commits.findIndex((c) => c.sha === sel)
    const next = commits[Math.max(0, Math.min(commits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      setSel(next.sha)
      listRef.current?.querySelector(`[data-sha="${next.sha}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }

  return (
    <div className="split">
      <div className="split-left wide history-left" style={{ width: pane.width }}>
        {unpushed.size > 0 && !query && (
          <div className="hist-note"><span className="push-badge" aria-hidden>↑</span>{unpushed.size} commit{unpushed.size === 1 ? ' is' : 's are'} not pushed yet</div>
        )}
        <div className="toolbar compact">
          <input className="grow" placeholder="Search commit messages… (Enter)" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setQuery(search)} />
          {query && <button className="link" onClick={() => (setSearch(''), setQuery(''))}>Clear</button>}
          <label className="check" title="Also list the commits that came in through merges"><input type="checkbox" checked={withMerged} onChange={(e) => setWithMerged(e.target.checked)} /> Include merged commits</label>
        </div>
        <div className="commit-list graph-list" ref={listRef} tabIndex={0} onKeyDown={onKey}>
          {commits.map((c, i) => (
            <div key={c.sha} data-sha={c.sha} className={`commit-row ${sel === c.sha ? 'active' : ''} ${unpushed.has(c.sha) ? 'is-unpushed' : ''}`} style={{ height: ROW_H }} onClick={() => setSel(c.sha)} onContextMenu={(e) => (setSel(c.sha), openMenu(e, commitMenu(c)))}>
              <Avatar name={c.author} email={c.email} />
              <div className="commit-main">
                <div className="commit-subject">
                  <RefChips refs={c.refs} />
                  {c.parents.length > 1 && <span className="merge-tag" title="Merge commit: brings another branch in">merge</span>}
                  <span>{c.subject}</span>
                </div>
                <div className="sub">
                  <code>{c.shortSha}</code> · {c.author} · <span title={fullDate(c.date)}>{ago(c.date)}</span>
                </div>
                {unpushed.has(c.sha) && <span className="push-badge in-row" title="Not pushed yet" aria-label="Not pushed yet">↑</span>}
              </div>
            </div>
          ))}
          {loading && <Spinner />}
          {!loading && more && commits.length > 0 && <button className="link load-more" onClick={() => loadPage(commits.length)}>Load {PAGE} more…</button>}
          {!loading && !commits.length && <div className="empty small">{query ? 'No commits match' : 'No commits yet'}</div>}
        </div>
      </div>
      <div {...pane.handle} />
      <div className="split-right">
        <CommitPanel repo={repo} sha={sel} onSelect={setSel} unpushed={sel ? unpushed.has(sel) : false}
          onMenu={(e) => { const c = commits.find((x) => x.sha === sel); if (c) openMenu(e, commitMenu(c)) }} />
      </div>
      {menu}
      {dialog}
    </div>
  )
}

function CommitPanel({ repo, sha, onSelect, unpushed, onMenu }: { repo: Repo; sha: string | null; onSelect: (s: string) => void; unpushed: boolean; onMenu: (e: React.MouseEvent) => void }) {
  const { toast } = useApp()
  const { data: d, loading } = useLoad(async () => (sha ? api.showCommit(repo.id, sha) : null), [repo.id, sha])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setCollapsed({})
    scrollRef.current?.scrollTo({ top: 0 })
  }, [sha])

  if (!sha) return <div className="empty">Select a commit</div>
  if (loading || !d) return <Spinner />

  const patches = splitPatch(d.patch)
  const adds = d.files.reduce((n, f) => n + (f.additions || 0), 0)
  const dels = d.files.reduce((n, f) => n + (f.deletions || 0), 0)
  const body = d.body.split('\n').slice(1).join('\n').trim()
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`))
  const jump = (path: string) => document.getElementById(fileId(path))?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="commit-panel" ref={scrollRef}>
      <div className="commit-card">
        <div className="commit-title">
          <h3>{d.subject}</h3>
          <button className="commit-more" onClick={onMenu} title="Commit actions (or right-click a commit)">⋯ Actions</button>
          <div className="chips"><RefChips refs={d.refs} />{unpushed && <span className="unpushed">Not pushed yet</span>}</div>
        </div>
        {body && <pre className="body">{body}</pre>}
        <div className="commit-meta">
          <Avatar name={d.author} email={d.email} size={34} />
          <div className="grow">
            <div><b>{d.author}</b> <span className="muted">&lt;{d.email}&gt;</span></div>
            <div className="sub">committed {ago(d.date)} · {fullDate(d.date)}</div>
          </div>
          <div className="sha-box">
            <button className="sha" onClick={() => copy(d.sha, 'Commit id')} title="Copy full commit id"><code>{d.sha.slice(0, 10)}</code> ⧉</button>
            {d.parents.length > 0 && (
              <div className="sub">
                {d.parents.length > 1 ? 'parents ' : 'parent '}
                {d.parents.map((p) => <a key={p} onClick={() => onSelect(p)}><code>{p.slice(0, 7)}</code> </a>)}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="stat-line">
        <b>{d.files.length}</b> file{d.files.length === 1 ? '' : 's'} changed
        <span className="add-text">+{adds}</span>
        <span className="del-text">−{dels}</span>
        <StatBar add={adds} del={dels} />
        {d.parents.length > 1 && <span className="muted">· compared with first parent</span>}
        <span className="grow" />
        <button className="link" onClick={() => setCollapsed(Object.fromEntries(d.files.map((f) => [f.path, true])))}>Collapse all</button>
        <button className="link" onClick={() => setCollapsed({})}>Expand all</button>
      </div>

      <div className="file-table">
        {d.files.map((f) => <FileRow key={f.path} f={f} onClick={() => jump(f.path)} />)}
      </div>

      {d.files.map((f) => {
        const p = patches.get(f.path) ?? ''
        const isCollapsed = collapsed[f.path]
        return (
          <div key={f.path} id={fileId(f.path)} className="file-diff">
            <div className="file-diff-head" onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))}>
              <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
              <StatusBadge s={f.status} />
              <PathLabel path={f.path} oldPath={f.oldPath} />
              <span className="grow" />
              {!f.binary && <><span className="add-text">+{f.additions}</span><span className="del-text">−{f.deletions}</span></>}
              <button className="icon small" title="Copy path" onClick={(e) => (e.stopPropagation(), copy(f.path, 'Path'))}>⧉</button>
            </div>
            {!isCollapsed && (f.binary ? <div className="diff-notes">Binary file</div> : <Diff text={p} />)}
          </div>
        )
      })}
      {d.truncated && <div className="empty small">Diff is very large and was truncated.</div>}
    </div>
  )
}

const fileId = (p: string) => 'f-' + p.replace(/[^a-z0-9]/gi, '_')

const STATUS: Record<string, [string, string]> = { A: ['added', 'A'], M: ['modified', 'M'], D: ['deleted', 'D'], R: ['renamed', 'R'], C: ['copied', 'C'], T: ['type', 'T'] }

function StatusBadge({ s }: { s: string }) {
  const [title, letter] = STATUS[s] ?? [s, s]
  return <span className={`status-badge s-${letter}`} title={title}>{letter}</span>
}

function PathLabel({ path, oldPath }: { path: string; oldPath?: string }) {
  const i = path.lastIndexOf('/')
  return (
    <span className="path-label" title={oldPath ? `${oldPath} → ${path}` : path}>
      {oldPath && <span className="muted">{oldPath} → </span>}
      <span className="muted">{i >= 0 ? path.slice(0, i + 1) : ''}</span>
      <b>{path.slice(i + 1)}</b>
    </span>
  )
}

function FileRow({ f, onClick }: { f: CommitDetail['files'][number]; onClick: () => void }) {
  return (
    <div className="file-row" onClick={onClick}>
      <StatusBadge s={f.status} />
      <PathLabel path={f.path} oldPath={f.oldPath} />
      <span className="grow" />
      {f.binary ? <span className="muted">binary</span> : <>
        <span className="add-text">+{f.additions}</span>
        <span className="del-text">−{f.deletions}</span>
        <StatBar add={f.additions} del={f.deletions} />
      </>}
    </div>
  )
}

/** GitHub-style five-block bar showing the add/delete ratio. */
function StatBar({ add, del }: { add: number; del: number }) {
  const total = add + del
  const g = total ? Math.round((add / total) * 5) : 0
  const r = total ? 5 - g : 0
  return (
    <span className="stat-bar">
      {Array.from({ length: 5 }, (_, i) => <i key={i} className={i < g ? 'g' : i < g + r ? 'r' : ''} />)}
    </span>
  )
}
