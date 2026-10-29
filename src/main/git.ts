import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Account, Branch, Commit, CommitDetail, FileChange, Stash, StatusResult } from '../shared/types'
import { getToken, knownHostsFile } from './store'

export interface RunOptions {
  cwd?: string
  account?: Account | null
  /** Exit codes that are not treated as failure. */
  okCodes?: number[]
  /** Extra environment for this command (e.g. GIT_SEQUENCE_EDITOR for a scripted rebase). */
  env?: NodeJS.ProcessEnv
}

const fwd = (p: string): string => p.replace(/\\/g, '/')

let gitRoot: string | null | undefined
/** Folder of the Git for Windows install (contains usr/bin/ssh.exe), if found. */
function gitInstallRoot(): string | null {
  if (gitRoot !== undefined) return gitRoot
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
    gitRoot = path.resolve(exec, '..', '..', '..')
  } catch {
    gitRoot = null
  }
  return gitRoot
}

/** Prefer the ssh tools bundled with Git so key handling matches what git itself uses. */
export function sshTool(name: 'ssh' | 'ssh-keygen'): string {
  const root = gitInstallRoot()
  if (root && process.platform === 'win32') {
    const p = path.join(root, 'usr', 'bin', `${name}.exe`)
    if (fs.existsSync(p)) return p
  }
  return name
}

export function sshArgs(keyPath: string): string[] {
  return ['-i', fwd(keyPath), '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${fwd(knownHostsFile())}`]
}

/**
 * Builds the environment that makes git authenticate as `account` without touching
 * the repo's config or the user's global ssh/git config. Remote URLs are rewritten
 * on the fly so the same repo works whether its remote is https or ssh.
 */
export function authEnv(account: Account | null | undefined, embeddedPrefixes: string[] = []): NodeJS.ProcessEnv {
  // GIT_EDITOR=true: revert, cherry-pick, merge and rebase --continue keep git's default message instead of waiting for an editor.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true' }
  if (!account) return env
  const cfg: [string, string][] = [['credential.helper', '']]
  if (account.authMethod === 'token') {
    const token = getToken(account.id)
    if (!token) throw new Error(`Account "${account.label}" has no token`)
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    cfg.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`])
    cfg.push(['url.https://github.com/.insteadOf', 'git@github.com:'])
    cfg.push(['url.https://github.com/.insteadOf', 'ssh://git@github.com/'])
    for (const p of embeddedPrefixes) cfg.push(['url.https://github.com/.insteadOf', p])
  } else {
    if (!account.sshKeyPath) throw new Error(`Account "${account.label}" has no SSH key`)
    const quoted = sshArgs(account.sshKeyPath).map((a) => `'${a}'`).join(' ')
    env.GIT_SSH_COMMAND = `ssh ${quoted}`
    env.GIT_SSH_VARIANT = 'ssh'
    cfg.push(['url.git@github.com:.insteadOf', 'https://github.com/'])
    for (const p of embeddedPrefixes) cfg.push(['url.git@github.com:.insteadOf', p])
  }
  env.GIT_CONFIG_COUNT = String(cfg.length)
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return env
}

/** Hides credentials embedded in URLs, e.g. https://ghp_xxx@github.com → https://***@github.com. */
export function redact(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@'"]+@/gi, '$1***@')
}

/**
 * Remotes like https://<token>@github.com/... carry their own (often stale) credentials
 * and don't match the plain https://github.com/ rewrite, so collect their prefixes to
 * rewrite them too and let the selected account authenticate instead.
 */
export async function embeddedCredentialPrefixes(cwd: string): Promise<string[]> {
  const out = await run(['config', '--get-regexp', String.raw`^remote\..*\.(push)?url$`], { cwd, okCodes: [1] }).catch(() => '')
  const prefixes = new Set<string>()
  for (const m of out.matchAll(/https?:\/\/[^\s/@]+@github\.com\//gi)) prefixes.add(m[0])
  return [...prefixes]
}

export async function run(args: string[], opts: RunOptions = {}): Promise<string> {
  const embedded = opts.account && opts.cwd ? await embeddedCredentialPrefixes(opts.cwd) : []
  const env = { ...authEnv(opts.account, embedded), ...opts.env }
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd, env, windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8')
      if (code === 0 || opts.okCodes?.includes(code ?? -1)) resolve(stdout)
      else {
        const msg = Buffer.concat(err).toString('utf8').trim() || stdout.trim() || `git ${args[0]} failed (${code})`
        reject(new Error(redact(msg)))
      }
    })
  })
}

export function parseRemote(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  return m ? { owner: m[1], repo: m[2] } : null
}

export async function remoteUrl(cwd: string): Promise<string | null> {
  try {
    return redact((await run(['remote', 'get-url', 'origin'], { cwd })).trim()) || null
  } catch {
    const remotes = (await run(['remote'], { cwd }).catch(() => '')).split('\n').filter(Boolean)
    if (!remotes.length) return null
    return redact((await run(['remote', 'get-url', remotes[0]], { cwd }).catch(() => '')).trim()) || null
  }
}

export async function status(cwd: string): Promise<StatusResult> {
  const raw = await run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd })
  const parts = raw.split('\0')
  const res: StatusResult = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const h = line.slice(14)
      res.branch = h === '(detached)' ? null : h
    } else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      if (m) [res.ahead, res.behind] = [Number(m[1]), Number(m[2])]
    } else if (line[0] === '1' || line[0] === '2' || line[0] === 'u') {
      const fieldCount = line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10
      const fields = line.split(' ')
      const xy = fields[1]
      const p = fields.slice(fieldCount).join(' ')
      const change: FileChange = {
        path: p,
        index: xy[0],
        worktree: xy[1],
        staged: line[0] !== 'u' && xy[0] !== '.',
        unstaged: line[0] !== 'u' && xy[1] !== '.',
        untracked: false,
        conflicted: line[0] === 'u'
      }
      if (line[0] === '2') change.origPath = parts[++i]
      res.files.push(change)
    } else if (line[0] === '?') {
      res.files.push({ path: line.slice(2), index: '?', worktree: '?', staged: false, unstaged: true, untracked: true, conflicted: false })
    }
  }
  return res
}

const MAX_DIFF = 400_000

function cap(s: string): string {
  return s.length > MAX_DIFF ? s.slice(0, MAX_DIFF) + '\n… diff truncated …' : s
}

export async function fileDiff(cwd: string, file: string, staged: boolean, untracked: boolean): Promise<string> {
  if (untracked) {
    const full = path.join(cwd, file)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) return '(directory)'
    if (stat.size > MAX_DIFF) return `(new file, ${stat.size} bytes — too large to preview)`
    const buf = fs.readFileSync(full)
    if (buf.includes(0)) return '(new binary file)'
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n')
    return `new file mode\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n')
  }
  return cap(await run(['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', file], { cwd }))
}

const LOG_FMT = ['%H', '%h', '%an', '%ae', '%at', '%D', '%s', '%P'].join('%x1f') + '%x1e'

function parseCommit(rec: string): Commit {
  const [sha, shortSha, author, email, date, refs, subject, parents] = rec.split('\x1f')
  return { sha, shortSha, author, email, date: Number(date) * 1000, refs, subject, parents: parents ? parents.split(' ') : [] }
}

export async function log(cwd: string, opts: { skip?: number; limit?: number; all?: boolean; search?: string }): Promise<Commit[]> {
  // Topological order keeps a branch's commits together, which makes the graph readable.
  const args = ['log', '--topo-order', `--format=${LOG_FMT}`, `-n${opts.limit ?? 100}`, `--skip=${opts.skip ?? 0}`]
  if (opts.all) args.push('--all')
  if (opts.search) args.push('-i', `--grep=${opts.search}`)
  try {
    const raw = await run(args, { cwd })
    return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map(parseCommit)
  } catch (e) {
    // Fresh repo with no commits yet.
    if (/does not have any commits|bad default revision/i.test(String(e))) return []
    throw e
  }
}

export async function showCommit(cwd: string, sha: string): Promise<CommitDetail> {
  const head = await run(['show', '-s', `--format=${LOG_FMT}%B`, sha], { cwd })
  const [meta, body] = head.split('\x1e')
  // --first-parent keeps merge commits comparable to their main line instead of producing a combined diff.
  const [nameStatus, numstat] = await Promise.all([
    run(['show', '--format=', '--first-parent', '-m', '--name-status', '-z', sha], { cwd }),
    run(['show', '--format=', '--first-parent', '-m', '--numstat', '-z', sha], { cwd })
  ])
  const files = nameStatus.split('\0').filter(Boolean)
  const list: CommitDetail['files'] = []
  for (let i = 0; i < files.length; i++) {
    const st = files[i]
    if (st[0] === 'R' || st[0] === 'C') {
      list.push({ status: st[0], path: files[i + 2], oldPath: files[i + 1], additions: 0, deletions: 0, binary: false })
      i += 2
    } else list.push({ status: st[0], path: files[++i], additions: 0, deletions: 0, binary: false })
  }
  // numstat -z: "add\tdel\tpath\0", or for renames "add\tdel\t\0old\0new\0". Same order as name-status.
  const ns = numstat.split('\0')
  for (let i = 0, f = 0; i < ns.length && f < list.length; i++) {
    const m = ns[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/)
    if (!m) continue
    if (m[3] === '') i += 2
    list[f].binary = m[1] === '-'
    list[f].additions = m[1] === '-' ? 0 : Number(m[1])
    list[f].deletions = m[2] === '-' ? 0 : Number(m[2])
    f++
  }
  const patch = await run(['show', '--format=', '--first-parent', '-m', '--no-color', '--patch', sha], { cwd })
  return { ...parseCommit(meta), body: body.trim(), files: list, patch: cap(patch), truncated: patch.length > MAX_DIFF }
}

/** Commits on HEAD that the upstream doesn't have yet. Empty when there is no upstream. */
export async function unpushed(cwd: string): Promise<string[]> {
  const raw = await run(['rev-list', '@{u}..HEAD'], { cwd }).catch(() => '')
  return raw.split('\n').filter(Boolean)
}

export async function branches(cwd: string): Promise<Branch[]> {
  const fmt = ['%(refname)', '%(refname:short)', '%(upstream:short)', '%(objectname:short)', '%(HEAD)', '%(committerdate:unix)', '%(upstream:track)'].join('%1f')
  const raw = await run(['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes'], { cwd })
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, name, upstream, sha, head, date, track] = l.split('\x1f')
      return { name, remote: ref.startsWith('refs/remotes/'), upstream, sha, current: head === '*', date: Number(date) * 1000, track }
    })
    .filter((b) => !b.name.endsWith('/HEAD') && b.name !== 'origin')
}

export async function stashes(cwd: string): Promise<Stash[]> {
  const raw = await run(['stash', 'list', '--format=%gd%x1f%s'], { cwd })
  return raw.split('\n').filter(Boolean).map((l) => {
    const [ref, message] = l.split('\x1f')
    return { ref, message }
  })
}
