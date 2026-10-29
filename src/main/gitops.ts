import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account, Commit, RebaseStep, Remote, RepoIdentity, RepoState, Tag } from '../shared/types'
import { log, run } from './git'

// Read-side helpers and the scripted interactive rebase. Simple one-command actions live in handlers.ts.

const fwd = (p: string): string => p.replace(/\\/g, '/')

async function gitDir(cwd: string): Promise<string> {
  return path.resolve(cwd, (await run(['rev-parse', '--git-dir'], { cwd })).trim())
}

const read = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

export async function repoState(cwd: string): Promise<RepoState> {
  const dir = await gitDir(cwd)
  const has = (f: string) => fs.existsSync(path.join(dir, f))
  const [unmerged, head] = await Promise.all([
    run(['diff', '--name-only', '--diff-filter=U'], { cwd }).catch(() => ''),
    run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd, okCodes: [1] }).catch(() => '')
  ])
  const st: RepoState = { operation: null, detail: '', conflicted: unmerged.split('\n').filter(Boolean).length, detachedAt: null }
  if (!head.trim()) st.detachedAt = (await run(['rev-parse', '--short', 'HEAD'], { cwd }).catch(() => '')).trim() || null

  const rebaseDir = ['rebase-merge', 'rebase-apply'].map((d) => path.join(dir, d)).find((d) => fs.existsSync(d))
  if (rebaseDir) {
    const branch = read(path.join(rebaseDir, 'head-name')).replace('refs/heads/', '')
    const onto = read(path.join(rebaseDir, 'onto')).slice(0, 7)
    const n = read(path.join(rebaseDir, 'msgnum')) || read(path.join(rebaseDir, 'next'))
    const total = read(path.join(rebaseDir, 'end')) || read(path.join(rebaseDir, 'last'))
    st.operation = 'rebase'
    st.detail = `Rebasing ${branch || 'HEAD'}${onto ? ` onto ${onto}` : ''}${n && total ? ` (${n}/${total})` : ''}`
  } else if (has('MERGE_HEAD')) {
    st.operation = 'merge'
    st.detail = read(path.join(dir, 'MERGE_MSG')).split('\n')[0] || 'Merge in progress'
  } else if (has('CHERRY_PICK_HEAD')) {
    st.operation = 'cherry-pick'
    st.detail = `Cherry-picking ${read(path.join(dir, 'CHERRY_PICK_HEAD')).slice(0, 7)}`
  } else if (has('REVERT_HEAD')) {
    st.operation = 'revert'
    st.detail = `Reverting ${read(path.join(dir, 'REVERT_HEAD')).slice(0, 7)}`
  }
  return st
}

export async function tags(cwd: string): Promise<Tag[]> {
  const fmt = ['%(refname:short)', '%(objecttype)', '%(*objectname)', '%(objectname)', '%(creatordate:unix)', '%(contents:subject)'].join('%1f')
  const raw = await run(['for-each-ref', '--sort=-creatordate', `--format=${fmt}`, 'refs/tags'], { cwd })
  return raw.split('\n').filter(Boolean).map((l) => {
    const [name, type, peeled, sha, date, message] = l.split('\x1f')
    const annotated = type === 'tag'
    return { name, sha: (annotated ? peeled : sha).slice(0, 40), date: Number(date) * 1000, message: annotated ? message : '', annotated }
  })
}

export async function remotes(cwd: string): Promise<Remote[]> {
  const raw = await run(['remote', '-v'], { cwd })
  const map = new Map<string, Remote>()
  for (const l of raw.split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (!m) continue
    const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' }
    if (m[3] === 'fetch') r.fetchUrl = m[2]
    else r.pushUrl = m[2]
    map.set(m[1], r)
  }
  return [...map.values()]
}

export async function identity(cwd: string): Promise<RepoIdentity> {
  const get = (args: string[]) => run(['config', ...args], { cwd, okCodes: [1] }).then((s) => s.trim()).catch(() => '')
  const [name, email, globalName, globalEmail] = await Promise.all([
    get(['--local', 'user.name']), get(['--local', 'user.email']), get(['--global', 'user.name']), get(['--global', 'user.email'])
  ])
  return { name, email, globalName, globalEmail }
}

/** Commits from `sha` up to HEAD, oldest first: the list an interactive rebase from that commit works on. */
export async function rebasePlan(cwd: string, sha: string): Promise<Commit[]> {
  await run(['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd }).catch(() => {
    throw new Error('That commit is not part of the current branch, so it cannot be rebased here.')
  })
  const count = Number((await run(['rev-list', '--count', `${sha}^..HEAD`], { cwd }).catch(() => run(['rev-list', '--count', 'HEAD'], { cwd }))).trim())
  if (count > 300) throw new Error(`That would rewrite ${count} commits. Pick a more recent commit.`)
  const commits = (await log(cwd, { limit: count })).reverse()
  if (commits.some((c) => c.parents.length > 1)) throw new Error('This range contains merge commits. Rewriting history across merges is not supported here.')
  return commits
}

/**
 * Runs `git rebase -i` with a prepared todo list instead of an editor. Rewording uses an `exec` step
 * that amends the message from a file, so no editor ever opens.
 */
/** `from` is the oldest commit of the plan (as returned by rebasePlan); steps may be in any order. */
export async function rebaseRun(cwd: string, account: Account | null, from: string, steps: RebaseStep[]): Promise<void> {
  if (!steps.length) throw new Error('Nothing to rebase')
  if (steps[0].action === 'squash' || steps[0].action === 'fixup') throw new Error('The first commit cannot be squashed: there is nothing before it to combine with.')
  if (steps.every((s) => s.action === 'drop')) throw new Error('Dropping every commit is not allowed here. Use Reset instead.')
  for (const s of [...steps, { sha: from }]) if (!/^[0-9a-f]{7,40}$/i.test(s.sha)) throw new Error('Invalid commit id')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repodock-rebase-'))
  try {
    const lines: string[] = []
    steps.forEach((s, i) => {
      const msgFile = (text: string) => {
        const f = path.join(tmp, `msg-${i}.txt`)
        fs.writeFileSync(f, text.trim() + '\n')
        return `exec git commit --amend --only --allow-empty -F '${fwd(f)}'`
      }
      if (s.action === 'reword') {
        lines.push(`pick ${s.sha}`)
        if (s.message?.trim()) lines.push(msgFile(s.message))
      } else lines.push(`${s.action} ${s.sha}`)
      // A squash group may carry its final message on its last member.
      const next = steps[i + 1]
      const endsGroup = s.action === 'squash' || s.action === 'fixup' ? !next || (next.action !== 'squash' && next.action !== 'fixup') : false
      if (endsGroup && s.message?.trim()) lines.push(msgFile(s.message))
    })
    const todo = path.join(tmp, 'todo')
    fs.writeFileSync(todo, lines.join('\n') + '\n')

    const first = from
    const isRoot = !(await run(['rev-parse', '--verify', '-q', `${first}^`], { cwd, okCodes: [1] })).trim()
    await run(['rebase', '-i', '--autostash', '--keep-empty', ...(isRoot ? ['--root'] : [`${first}^`])], {
      cwd,
      account,
      env: { GIT_SEQUENCE_EDITOR: `cp '${fwd(todo)}'`, GIT_EDITOR: 'true' }
    })
  } catch (e) {
    // Stopped on a conflict: later reword steps still need their message files, so keep them.
    if ((await repoState(cwd).catch(() => null))?.operation !== 'rebase') fs.rmSync(tmp, { recursive: true, force: true })
    throw e
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}
