import fs from 'node:fs'
import path from 'node:path'
import type { AgentApproval, Repo } from '../../shared/types'
import { load, save } from '../store'
import * as git from '../git'
import { addRepoPath, detectAccount, handlers, repoContext } from '../handlers'

const MAX_DIFF = 60_000

const norm = (p: string) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '')

/** Finds a repo by id, name or any path inside it; falls back to the caller's working directory. */
export function resolveRepo(ref: string | undefined, cwd?: string): Repo {
  const { repos } = load()
  const byPath = (p: string) => {
    const target = norm(p)
    return repos
      .filter((r) => target === norm(r.path) || target.startsWith(norm(r.path) + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0]
  }
  if (ref) {
    const hit =
      repos.find((r) => r.id === ref) ??
      (/[\\/]/.test(ref) || /^[a-z]:/i.test(ref) ? byPath(path.isAbsolute(ref) ? ref : path.resolve(cwd ?? '.', ref)) : undefined)
    if (hit) return hit
    const named = repos.filter((r) => r.name.toLowerCase() === ref.toLowerCase())
    if (named.length === 1) return named[0]
    if (named.length > 1) throw new Error(`Several repositories are named "${ref}". Pass the folder path instead:\n${named.map((r) => '  ' + r.path).join('\n')}`)
    throw new Error(`RepoDock has no repository "${ref}". Call list_repos to see them, or add_repo to add one.`)
  }
  const hit = cwd ? byPath(cwd) : undefined
  if (hit) return hit
  throw new Error(
    cwd
      ? `The working directory (${cwd}) is not inside a repository RepoDock manages. Pass \`repo\`, or call add_repo with this path.`
      : 'Pass `repo` (a path, name or id). Call list_repos to see the repositories.'
  )
}

async function accountLine(r: Repo): Promise<string> {
  const ctx = await repoContext(r.id)
  const a = ctx.account
  if (!a) return ctx.remote ? `none (no RepoDock account for "${ctx.remote.owner}")` : 'none (no GitHub remote)'
  return `${a.label} (@${a.login || '?'}, ${a.authMethod === 'token' ? 'token' : 'SSH key'})`
}

const fileLine = (f: { path: string; origPath?: string; index: string; worktree: string; untracked: boolean; conflicted: boolean }) =>
  `${f.conflicted ? 'CONFLICT ' : f.untracked ? '??' : `${f.index}${f.worktree}`.replace(/\./g, ' ')} ${f.origPath ? `${f.origPath} -> ` : ''}${f.path}`

/** Plain-text results: easy for any model to read. */
export async function runTool(name: string, r: Repo | null, args: Record<string, any>, cwd?: string): Promise<string> {
  switch (name) {
    case 'list_repos': {
      const q = String(args.query ?? '').toLowerCase()
      const repos = load().repos.filter((x) => !q || x.name.toLowerCase().includes(q) || x.path.toLowerCase().includes(q))
      const sums = await handlers.summaries(repos.map((x) => x.id))
      const accounts = load().accounts
      if (!repos.length) return q ? `No repositories match "${q}".` : 'RepoDock has no repositories yet.'
      return repos
        .map((x) => {
          const s = sums.find((y) => y.id === x.id)
          const a = accounts.find((y) => y.id === s?.effectiveAccountId)
          const changes = s ? s.staged + s.unstaged + s.untracked : 0
          return [
            `${x.name}  —  ${x.path}`,
            `  branch: ${s?.branch ?? '?'}${s?.upstream ? ` → ${s.upstream}` : ''}${s?.ahead ? `  ↑${s.ahead}` : ''}${s?.behind ? `  ↓${s.behind}` : ''}`,
            `  changes: ${changes || 'clean'}${s?.conflicted ? `, ${s.conflicted} conflicted` : ''}`,
            `  github: ${s?.owner ? `${s.owner}/${s.repoName}` : 'no GitHub remote'}  ·  account: ${a ? `${a.label} (@${a.login})` : 'none'}`,
            s?.error ? `  error: ${s.error}` : ''
          ].filter(Boolean).join('\n')
        })
        .join('\n\n')
    }

    case 'repo_status': {
      const st = await git.status(r!.path)
      return [
        `Repository: ${r!.name} (${r!.path})`,
        `Branch: ${st.branch ?? '(detached)'}${st.upstream ? ` → ${st.upstream}` : ' (no upstream yet)'}`,
        `Ahead ${st.ahead}, behind ${st.behind}`,
        `Account for push/pull: ${await accountLine(r!)}`,
        '',
        st.files.length ? `Changed files (${st.files.length}):\n${st.files.map((f) => '  ' + fileLine(f)).join('\n')}` : 'Working tree clean.'
      ].join('\n')
    }

    case 'diff': {
      const extra = args.path ? ['--', String(args.path)] : []
      let out = await git.run(['diff', '--no-color', ...(args.staged ? ['--cached'] : []), ...extra], { cwd: r!.path })
      if (!args.staged && !args.path) {
        const untracked = (await git.status(r!.path)).files.filter((f) => f.untracked).map((f) => f.path)
        if (untracked.length) out += `\nUntracked files (not shown above):\n${untracked.map((f) => '  ' + f).join('\n')}\n`
      }
      if (!out.trim()) return args.staged ? 'No staged changes.' : 'No unstaged changes.'
      return out.length > MAX_DIFF ? out.slice(0, MAX_DIFF) + `\n… diff truncated (${out.length} chars). Pass \`path\` to see one file.` : out
    }

    case 'log': {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
      const ref = args.branch ? [safeRef(String(args.branch))] : []
      const out = await git.run(['log', `-n${limit}`, '--format=%h  %ad  %an  %s%d', '--date=short', ...ref, '--'], { cwd: r!.path })
      return out.trim() || 'No commits yet.'
    }

    case 'branches': {
      const list = await git.branches(r!.path)
      const local = list.filter((b) => !b.remote).map((b) => `${b.current ? '* ' : '  '}${b.name}${b.upstream ? ` → ${b.upstream}` : ''} ${b.track}`.trimEnd())
      const remote = list.filter((b) => b.remote).map((b) => `  ${b.name}`)
      return `Local:\n${local.join('\n') || '  (none)'}\n\nRemote:\n${remote.join('\n') || '  (none)'}`
    }

    case 'fetch':
      await handlers.fetch(r!.id)
      return `Fetched ${r!.name}.\n` + (await runTool('repo_status', r, {}))

    case 'commit': {
      const message = String(args.message ?? '').trim()
      if (!message) throw new Error('`message` is required')
      if (Array.isArray(args.files) && args.files.length) await handlers.stage(r!.id, args.files.map(String))
      await handlers.commit(r!.id, message, { all: !!args.all })
      const head = await git.run(['log', '-1', '--format=%h %s'], { cwd: r!.path })
      return `Committed ${head.trim()} on ${r!.name}.`
    }

    case 'checkout':
      if (args.create) await handlers.createBranch(r!.id, String(args.branch))
      else await handlers.checkout(r!.id, String(args.branch), false)
      return `Now on branch ${args.branch} in ${r!.name}.`

    case 'pull': {
      const out = await handlers.pull(r!.id)
      return `Pulled ${r!.name}.\n${out.trim()}`
    }

    case 'push': {
      await handlers.push(r!.id, { force: !!args.force })
      const st = await git.status(r!.path)
      return `Pushed ${st.branch} → ${st.upstream ?? 'origin'} as ${await accountLine(r!)}.`
    }

    case 'create_pull_request': {
      const st = await git.status(r!.path)
      const head = String(args.head ?? st.branch ?? '')
      if (!head) throw new Error('Could not tell the current branch; pass `head`.')
      const base = String(args.base ?? (await handlers.ghRepo(r!.id)).default_branch)
      const pr = await handlers.ghCreatePull(r!.id, { title: String(args.title), body: args.body ? String(args.body) : undefined, head, base, draft: !!args.draft })
      return `Opened pull request #${pr.number}: ${pr.html_url}`
    }

    case 'list_pull_requests': {
      const prs = (await handlers.ghPulls(r!.id, (args.state as 'open' | 'closed' | 'all') ?? 'open')) as any[]
      if (!prs.length) return 'No pull requests.'
      return prs.slice(0, 50).map((p) => `#${p.number} [${p.draft ? 'draft' : p.state}] ${p.title}  (${p.head.ref} → ${p.base.ref}, @${p.user?.login})\n  ${p.html_url}`).join('\n')
    }

    case 'ci_status': {
      let runs = (await handlers.ghRuns(r!.id)) as any[]
      if (args.branch) runs = runs.filter((x) => x.head_branch === args.branch)
      if (!runs.length) return 'No workflow runs found.'
      return runs.slice(0, 15).map((x) => `${x.conclusion ?? x.status}  ${x.name}  ·  ${x.head_branch}  ·  ${x.head_sha.slice(0, 7)}  ·  ${x.created_at}\n  ${x.html_url}`).join('\n')
    }

    case 'add_repo': {
      const p = path.resolve(cwd ?? '.', String(args.path ?? ''))
      if (!fs.existsSync(p)) throw new Error(`Folder not found: ${p}`)
      const added = await addRepoPath(p).catch(() => {
        throw new Error(`${p} is not inside a git repository.`)
      })
      if (!added) return `Already in RepoDock: ${resolveRepo(undefined, p).name}.`
      save()
      return `Added ${added.name} (${added.path}). Account: ${await accountLine(added)}.`
    }
  }
  throw new Error(`Unknown tool ${name}`)
}

function safeRef(name: string): string {
  if (!name || name.startsWith('-') || /[\s~^:?*[\\]/.test(name)) throw new Error(`Invalid ref name: ${name}`)
  return name
}

/** What the approval dialog shows. */
export async function describeAction(r: Repo, tool: string, args: Record<string, any>): Promise<Pick<AgentApproval, 'title' | 'risk' | 'accountLabel' | 'details' | 'list'>> {
  const ctx = await repoContext(r.id)
  const a = ctx.account ?? detectAccount(r, null)
  const accountLabel = a ? `${a.label} · @${a.login}` : null
  const st = await git.status(r.path).catch(() => null)
  const branch = st?.branch ?? '?'
  const subjects = async (range: string) =>
    (await git.run(['log', '--format=%h %s', '-n30', range], { cwd: r.path }).catch(() => '')).split('\n').filter(Boolean)

  switch (tool) {
    case 'push': {
      const commits = st?.upstream ? await subjects('@{u}..HEAD') : await subjects('HEAD')
      return {
        title: args.force ? 'Force-push (with lease)' : 'Push',
        risk: args.force ? 'high' : 'normal',
        accountLabel,
        details: [
          { label: 'Branch', value: `${branch} → ${st?.upstream ?? 'origin/' + branch + ' (new)'}` },
          ...(args.force ? [{ label: 'Warning', value: 'Rewrites history on the remote' }] : [])
        ],
        list: commits.length ? { label: `${st?.upstream ? commits.length : 'Recent'} commit(s)`, items: commits.slice(0, 12) } : undefined
      }
    }
    case 'pull':
      return { title: 'Pull', risk: 'normal', accountLabel, details: [{ label: 'Branch', value: `${branch} ← ${st?.upstream ?? '?'}` }, { label: 'Incoming', value: `${st?.behind ?? 0} commit(s) (as of last fetch)` }] }
    case 'commit': {
      const files = Array.isArray(args.files) && args.files.length ? args.files.map(String) : (st?.files ?? []).filter((f) => args.all || f.staged).map((f) => f.path)
      return {
        title: 'Commit',
        risk: 'normal',
        accountLabel,
        details: [{ label: 'Message', value: String(args.message ?? '') }, { label: 'Branch', value: branch }],
        list: { label: `${files.length} file(s)`, items: files.slice(0, 15).concat(files.length > 15 ? [`… and ${files.length - 15} more`] : []) }
      }
    }
    case 'checkout':
      return { title: args.create ? 'Create branch' : 'Switch branch', risk: 'normal', accountLabel, details: [{ label: 'From', value: branch }, { label: 'To', value: String(args.branch) }] }
    case 'create_pull_request':
      return {
        title: 'Open pull request',
        risk: 'normal',
        accountLabel,
        details: [
          { label: 'Title', value: String(args.title ?? '') },
          { label: 'Branches', value: `${args.head ?? branch} → ${args.base ?? 'default branch'}` },
          ...(args.draft ? [{ label: 'Draft', value: 'yes' }] : [])
        ],
        list: args.body ? { label: 'Description', items: String(args.body).split('\n').slice(0, 12) } : undefined
      }
    default:
      return { title: tool, risk: 'normal', accountLabel, details: [] }
  }
}
