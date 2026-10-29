import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account, AgentInfo, AgentPolicy, AppInfo, AppState, AuthMethod, Group, RebaseStep, Repo, RepoSummary, ThemeSetting } from '../shared/types'
import * as updater from './updater'
import * as gitops from './gitops'
import { backupData, backupsDir, dataDir, getToken, listBackups, load, newId, save, setToken } from './store'
import * as git from './git'
import * as ssh from './ssh'
import { GitHub } from './github'
import { findRepos } from './scan'
import * as gitlink from './agent/gitlink'
import * as agentClients from './agent/clients'
import * as bridge from './agent/bridge'
import { helperExe, helperScript, installHelper, mcpEntry } from './agent/paths'

// ---------- helpers ----------

function account(id: string): Account {
  const a = load().accounts.find((x) => x.id === id)
  if (!a) throw new Error('Account not found')
  return a
}

function repo(id: string): Repo {
  const r = load().repos.find((x) => x.id === id)
  if (!r) throw new Error('Repository not found')
  return r
}

/** Manual override wins; otherwise match the remote owner against account logins, then their orgs. */
export function detectAccount(r: Repo, owner: string | null): Account | null {
  const { accounts } = load()
  if (r.accountId) return accounts.find((a) => a.id === r.accountId) ?? null
  if (!owner) return null
  const o = owner.toLowerCase()
  return (
    accounts.find((a) => a.login.toLowerCase() === o) ??
    accounts.find((a) => a.orgs.some((g) => g.toLowerCase() === o)) ??
    null
  )
}

export async function repoContext(id: string) {
  const r = repo(id)
  const url = await git.remoteUrl(r.path)
  const remote = git.parseRemote(url)
  return { repo: r, url, remote, account: detectAccount(r, remote?.owner ?? null) }
}

async function ghContext(id: string) {
  const ctx = await repoContext(id)
  if (!ctx.remote) throw new Error('This repository has no GitHub remote')
  if (!ctx.account) throw new Error(`No account linked to "${ctx.remote.owner}". Pick one in the repo header.`)
  const gh = GitHub.forAccount(ctx.account.id, `Account "${ctx.account.label}"`)
  return { ...ctx, gh, base: `/repos/${ctx.remote.owner}/${ctx.remote.repo}` }
}

const gitOn = async (id: string, args: string[]) => {
  const ctx = await repoContext(id)
  return git.run(args, { cwd: ctx.repo.path, account: ctx.account })
}

function safeUrl(url: string): string {
  if (!url.trim() || url.trim().startsWith('-')) throw new Error('Invalid remote URL')
  return url.trim()
}

function safeSha(sha: string): string {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error('Invalid commit id')
  return sha
}

function safeRef(name: string): string {
  if (!name || name.startsWith('-') || /[\s~^:?*[\\]/.test(name)) throw new Error(`Invalid ref name: ${name}`)
  return name
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx])
      }
    })
  )
  return out
}

export async function addRepoPath(p: string, extra: Partial<Repo> = {}): Promise<Repo | null> {
  const top = path.normalize((await git.run(['rev-parse', '--show-toplevel'], { cwd: p })).trim())
  const d = load()
  if (d.repos.some((r) => r.path.toLowerCase() === top.toLowerCase())) return null
  const r: Repo = { id: newId(), path: top, name: path.basename(top), groupId: null, accountId: null, addedAt: Date.now(), ...extra }
  d.repos.push(r)
  return r
}

async function pickFolder(title: string): Promise<string | null> {
  const res = await dialog.showOpenDialog({ title, properties: ['openDirectory'] })
  return res.canceled ? null : res.filePaths[0]
}

async function refreshProfile(a: Account): Promise<void> {
  const token = getToken(a.id)
  if (!token) return
  const gh = new GitHub(token)
  const me = await gh.whoami()
  a.login = me.login
  a.name = me.name
  a.avatarUrl = me.avatarUrl
  a.tokenScopes = me.scopes
  a.orgs = await gh
    .paginate<{ login: string }>('/user/orgs?per_page=100')
    .then((o) => o.map((x) => x.login))
    .catch(() => a.orgs)
}

async function uploadKey(a: Account): Promise<void> {
  const gh = GitHub.forAccount(a.id)
  try {
    const key = await gh.post('/user/keys', { title: `RepoDock @ ${os.hostname()}`, key: a.sshPublicKey })
    a.githubKeyId = key.id
  } catch (e) {
    if (/already in use/i.test((e as Error).message)) {
      // An imported key may already be on this account — that's fine, just link to it.
      const body = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(' ')
      const existing = await gh.paginate<{ id: number; key: string }>('/user/keys?per_page=100').catch(() => [])
      const match = existing.find((k) => body(k.key) === body(a.sshPublicKey!))
      if (match) {
        a.githubKeyId = match.id
        return
      }
      throw new Error('This SSH key is already registered on a different GitHub account. GitHub allows a key on only one account, so generate a new key for this one.')
    }
    throw new Error(`Could not upload the SSH key to GitHub. Classic tokens need the "admin:public_key" scope; fine-grained tokens need "Git SSH keys: write". ${(e as Error).message}`)
  }
}

/** Window background while the page loads, so there is no flash of the wrong colour. */
export const themeBackground = (): string => (nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f8fa')

/** Drives prefers-color-scheme in the UI plus the native frame, menus and scrollbars. */
export function applyTheme(theme: ThemeSetting = load().theme): void {
  nativeTheme.themeSource = theme
  for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(themeBackground())
}

// ---------- handlers (every function here is callable from the renderer) ----------

export const handlers = {
  updateStatus: () => updater.updateStatus(),
  checkForUpdates: () => updater.checkForUpdates(),
  installUpdate: () => updater.installUpdate(),

  async appInfo(): Promise<AppInfo> {
    const gitVersion = await git.run(['--version']).then((s) => s.trim()).catch(() => null)
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      git: gitVersion,
      dataDir: dataDir(),
      backupsDir: backupsDir(),
      backups: listBackups().map((file) => {
        const st = fs.statSync(file)
        return { file, date: st.mtimeMs, size: st.size }
      })
    }
  },
  backupNow() {
    if (!backupData()) throw new Error('Nothing to back up yet, or the data file could not be read.')
  },

  getTheme: (): ThemeSetting => load().theme,
  setTheme(theme: ThemeSetting) {
    load().theme = theme
    save()
    applyTheme(theme)
  },

  state(): AppState {
    const { accounts, groups, repos } = load()
    return { accounts, groups, repos }
  },

  async summaries(ids?: string[]): Promise<RepoSummary[]> {
    const repos = load().repos.filter((r) => !ids || ids.includes(r.id))
    return mapLimit(repos, 6, async (r): Promise<RepoSummary> => {
      const base: RepoSummary = {
        id: r.id, exists: fs.existsSync(r.path), branch: null, upstream: null, ahead: 0, behind: 0,
        staged: 0, unstaged: 0, untracked: 0, conflicted: 0, remoteUrl: null, owner: null, repoName: null,
        effectiveAccountId: null, lastCommit: null
      }
      if (!base.exists) return { ...base, error: 'Folder not found' }
      try {
        const [st, url, last] = await Promise.all([git.status(r.path), git.remoteUrl(r.path), git.log(r.path, { limit: 1 })])
        const remote = git.parseRemote(url)
        return {
          ...base,
          branch: st.branch, upstream: st.upstream, ahead: st.ahead, behind: st.behind,
          staged: st.files.filter((f) => f.staged).length,
          unstaged: st.files.filter((f) => f.unstaged && !f.untracked).length,
          untracked: st.files.filter((f) => f.untracked).length,
          conflicted: st.files.filter((f) => f.conflicted).length,
          remoteUrl: url, owner: remote?.owner ?? null, repoName: remote?.repo ?? null,
          effectiveAccountId: detectAccount(r, remote?.owner ?? null)?.id ?? null,
          lastCommit: last[0] ? { sha: last[0].shortSha, subject: last[0].subject, date: last[0].date, author: last[0].author } : null
        }
      } catch (e) {
        return { ...base, error: (e as Error).message }
      }
    })
  },

  // ----- accounts -----

  async addAccount(input: { label: string; authMethod: AuthMethod; token?: string; login?: string; keySource: 'generate' | 'import'; importPath?: string }): Promise<Account> {
    const token = input.token?.trim() || null
    if ((input.authMethod === 'token' || input.authMethod === 'ssh-auto') && !token) throw new Error('A token is required for this sign-in method')
    const a: Account = { id: newId(), label: input.label.trim() || 'GitHub', login: input.login?.trim() ?? '', authMethod: input.authMethod, hasToken: !!token, orgs: [], createdAt: Date.now() }
    try {
      if (token) {
        setToken(a.id, token)
        await refreshProfile(a)
      }
      if (input.authMethod !== 'token') {
        const key = input.keySource === 'import' && input.importPath
          ? await ssh.importKey(a.id, input.importPath)
          : await ssh.generateKey(a.id, `repodock-${a.login || a.label}@${os.hostname()}`)
        a.sshKeyPath = key.keyPath
        a.sshPublicKey = key.publicKey
        a.sshFingerprint = key.fingerprint
        if (input.authMethod === 'ssh-auto') await uploadKey(a)
      }
    } catch (e) {
      setToken(a.id, null)
      ssh.deleteKeys(a.id)
      throw e
    }
    load().accounts.push(a)
    save()
    gitlink.refreshLinks()
    return a
  },

  async updateAccount(id: string, patch: { label?: string; token?: string | null }): Promise<Account> {
    const a = account(id)
    if (patch.label !== undefined) a.label = patch.label
    if (patch.token !== undefined) {
      setToken(id, patch.token?.trim() || null)
      a.hasToken = !!patch.token?.trim()
    }
    await refreshProfile(a)
    save()
    gitlink.refreshLinks()
    return a
  },

  async refreshAccount(id: string): Promise<Account> {
    const a = account(id)
    await refreshProfile(a)
    save()
    return a
  },

  /** Uploads the account's public key using its token (turns a manual-SSH account into ssh-auto). */
  async uploadSshKey(id: string): Promise<Account> {
    const a = account(id)
    if (!a.sshPublicKey) throw new Error('Account has no SSH key')
    await uploadKey(a)
    a.authMethod = 'ssh-auto'
    save()
    return a
  },

  async testSsh(id: string) {
    const a = account(id)
    if (!a.sshKeyPath) throw new Error('Account has no SSH key')
    const res = await ssh.testGitHub(a.sshKeyPath)
    if (res.ok && res.login && !a.login) {
      a.login = res.login
      save()
    }
    return res
  },

  async removeAccount(id: string, removeKeyFromGitHub: boolean): Promise<void> {
    const d = load()
    const a = account(id)
    if (removeKeyFromGitHub && a.githubKeyId && a.hasToken) {
      await GitHub.forAccount(id).delete(`/user/keys/${a.githubKeyId}`).catch((e) => {
        if (!/404/.test(e.message)) throw e
      })
    }
    ssh.deleteKeys(id)
    setToken(id, null)
    d.accounts = d.accounts.filter((x) => x.id !== id)
    d.repos.forEach((r) => r.accountId === id && (r.accountId = null))
    save()
    await gitlink.refreshLinks()
  },

  async pickKeyFile(): Promise<string | null> {
    const res = await dialog.showOpenDialog({ title: 'Choose a private SSH key', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] })
    return res.canceled ? null : res.filePaths[0]
  },

  // ----- repos & groups -----

  async addRepo(): Promise<Repo | null> {
    const dir = await pickFolder('Add a repository')
    if (!dir) return null
    const r = await addRepoPath(dir)
    save()
    if (!r) throw new Error('That repository is already added')
    return r
  },

  async importFolder(groupId: string | null = null): Promise<{ found: number; added: number } | null> {
    const dir = await pickFolder('Import all repositories inside a folder')
    if (!dir) return null
    const paths = await findRepos(dir)
    let added = 0
    for (const p of paths) if (await addRepoPath(p, { groupId }).catch(() => null)) added++
    save()
    return { found: paths.length, added }
  },

  async removeRepos(ids: string[]): Promise<void> {
    const d = load()
    // Leave no RepoDock include behind in repos we stop managing.
    await Promise.all(d.repos.filter((r) => ids.includes(r.id) && r.gitLinked).map((r) => gitlink.unlink(r).catch(() => {})))
    d.repos = d.repos.filter((r) => !ids.includes(r.id))
    save()
  },

  setRepoGroup(ids: string[], groupId: string | null): void {
    load().repos.forEach((r) => ids.includes(r.id) && (r.groupId = groupId))
    save()
  },

  setRepoAccount(id: string, accountId: string | null): void {
    repo(id).accountId = accountId
    save()
    gitlink.refreshLinks([id])
  },

  createGroup(name: string, color: string): Group {
    const g = { id: newId(), name, color }
    load().groups.push(g)
    save()
    return g
  },

  updateGroup(id: string, patch: Partial<Omit<Group, 'id'>>): void {
    Object.assign(load().groups.find((g) => g.id === id) ?? {}, patch)
    save()
  },

  deleteGroup(id: string): void {
    const d = load()
    d.groups = d.groups.filter((g) => g.id !== id)
    d.repos.forEach((r) => r.groupId === id && (r.groupId = null))
    save()
  },

  // ----- local git -----

  status: async (id: string) => git.status(repo(id).path),
  diff: async (id: string, file: string, staged: boolean, untracked: boolean) => git.fileDiff(repo(id).path, file, staged, untracked),
  log: async (id: string, opts: { skip?: number; limit?: number; all?: boolean; search?: string }) => git.log(repo(id).path, opts),
  showCommit: async (id: string, sha: string) => {
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error('Invalid commit id')
    return git.showCommit(repo(id).path, sha)
  },
  unpushed: async (id: string) => git.unpushed(repo(id).path),
  branches: async (id: string) => git.branches(repo(id).path),
  stashes: async (id: string) => git.stashes(repo(id).path),

  stage: (id: string, files: string[]) => gitOn(id, ['add', '-A', '--', ...files]),
  stageAll: (id: string) => gitOn(id, ['add', '-A']),
  async unstage(id: string, files: string[]) {
    try {
      return await gitOn(id, ['restore', '--staged', '--', ...files])
    } catch {
      return gitOn(id, ['rm', '--cached', '-r', '-q', '--', ...files]) // repo without commits yet
    }
  },
  async discard(id: string, files: { path: string; untracked: boolean }[]) {
    const tracked = files.filter((f) => !f.untracked).map((f) => f.path)
    const untracked = files.filter((f) => f.untracked).map((f) => f.path)
    if (tracked.length) await gitOn(id, ['restore', '--worktree', '--', ...tracked])
    if (untracked.length) await gitOn(id, ['clean', '-f', '-q', '--', ...untracked])
  },
  async commit(id: string, message: string, opts: { amend?: boolean; all?: boolean }) {
    if (!message.trim() && !opts.amend) throw new Error('Commit message is empty')
    if (opts.all) await gitOn(id, ['add', '-A'])
    return gitOn(id, ['commit', ...(opts.amend ? ['--amend'] : []), ...(message.trim() ? ['-m', message] : ['--no-edit'])])
  },

  checkout: async (id: string, branch: string, remote: boolean) => {
    if (remote) {
      const local = branch.split('/').slice(1).join('/')
      return gitOn(id, ['switch', '-c', safeRef(local), '--track', safeRef(branch)])
    }
    return gitOn(id, ['switch', safeRef(branch)])
  },
  createBranch: (id: string, name: string, from?: string) => gitOn(id, ['switch', '-c', safeRef(name), ...(from ? [safeRef(from)] : [])]),
  deleteBranch: (id: string, name: string, force: boolean) => gitOn(id, ['branch', force ? '-D' : '-d', safeRef(name)]),
  deleteRemoteBranch: async (id: string, name: string) => {
    const [remote, ...rest] = name.split('/')
    return gitOn(id, ['push', safeRef(remote), '--delete', safeRef(rest.join('/'))])
  },
  merge: (id: string, name: string, mode: 'merge' | 'no-ff' | 'squash' | 'ff-only' = 'merge') =>
    gitOn(id, ['merge', '--no-edit', ...(mode === 'merge' ? [] : [`--${mode}`]), safeRef(name)]),
  abortMerge: (id: string) => gitOn(id, ['merge', '--abort']),

  stashSave: (id: string, message: string) => gitOn(id, ['stash', 'push', '-u', ...(message ? ['-m', message] : [])]),
  stashPop: (id: string, ref: string) => gitOn(id, ['stash', 'pop', safeRef(ref)]),
  stashApply: (id: string, ref: string) => gitOn(id, ['stash', 'apply', safeRef(ref)]),
  stashDrop: (id: string, ref: string) => gitOn(id, ['stash', 'drop', safeRef(ref)]),

  // ----- everything else git can do -----

  repoState: async (id: string) => gitops.repoState(repo(id).path),
  /** Continue / skip / abort whatever merge, rebase, cherry-pick or revert stopped half-way. */
  async operation(id: string, what: 'continue' | 'skip' | 'abort') {
    const { operation } = await gitops.repoState(repo(id).path)
    if (!operation) throw new Error('Nothing is in progress')
    if (operation === 'merge') return gitOn(id, what === 'continue' ? ['commit', '--no-edit'] : what === 'abort' ? ['merge', '--abort'] : ['reset', '--merge'])
    return gitOn(id, [operation, `--${what}`])
  },
  async resolveConflict(id: string, files: string[], how: 'ours' | 'theirs' | 'resolved') {
    if (how !== 'resolved') await gitOn(id, ['checkout', `--${how}`, '--', ...files])
    return gitOn(id, ['add', '--', ...files])
  },
  ignorePath(id: string, pattern: string) {
    const file = path.join(repo(id).path, '.gitignore')
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (cur.split(/\r?\n/).includes(pattern)) return
    fs.writeFileSync(file, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + pattern + '\n')
  },
  cleanUntracked: (id: string, ignoredToo: boolean) => gitOn(id, ['clean', '-fd', ...(ignoredToo ? ['-x'] : [])]),
  discardAll: (id: string) => gitOn(id, ['reset', '--hard', '-q']),

  // commits
  checkoutCommit: (id: string, sha: string) => gitOn(id, ['switch', '--detach', safeSha(sha)]),
  resetTo: (id: string, sha: string, mode: 'soft' | 'mixed' | 'hard') => gitOn(id, ['reset', `--${mode}`, safeSha(sha)]),
  amendMessage(id: string, message: string) {
    if (!message.trim()) throw new Error('Commit message is empty')
    return gitOn(id, ['commit', '--amend', '--only', '--allow-empty', '-m', message])
  },
  undoLastCommit: (id: string) => gitOn(id, ['reset', '--soft', 'HEAD~1']),
  async revertCommit(id: string, sha: string) {
    const parents = (await gitOn(id, ['rev-list', '--parents', '-n1', safeSha(sha)])).trim().split(' ').length - 1
    return gitOn(id, ['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), sha])
  },
  async cherryPick(id: string, sha: string) {
    const parents = (await gitOn(id, ['rev-list', '--parents', '-n1', safeSha(sha)])).trim().split(' ').length - 1
    return gitOn(id, ['cherry-pick', ...(parents > 1 ? ['-m', '1'] : []), sha])
  },
  createBranchAt: (id: string, name: string, sha: string, checkout: boolean) =>
    gitOn(id, checkout ? ['switch', '-c', safeRef(name), safeSha(sha)] : ['branch', safeRef(name), safeSha(sha)]),
  rebasePlan: async (id: string, sha: string) => gitops.rebasePlan(repo(id).path, safeSha(sha)),
  async rebaseRun(id: string, from: string, steps: RebaseStep[]) {
    const ctx = await repoContext(id)
    return gitops.rebaseRun(ctx.repo.path, ctx.account, from, steps)
  },

  // tags
  tags: async (id: string) => gitops.tags(repo(id).path),
  createTag: (id: string, name: string, sha: string, message: string) =>
    gitOn(id, ['tag', ...(message.trim() ? ['-a', '-m', message] : []), safeRef(name), sha === 'HEAD' ? sha : safeSha(sha)]),
  deleteTag: (id: string, name: string) => gitOn(id, ['tag', '-d', safeRef(name)]),
  pushTag: (id: string, name: string, remote = 'origin') => gitOn(id, ['push', safeRef(remote), `refs/tags/${safeRef(name)}`]),
  pushAllTags: (id: string, remote = 'origin') => gitOn(id, ['push', safeRef(remote), '--tags']),
  deleteRemoteTag: (id: string, name: string, remote = 'origin') => gitOn(id, ['push', safeRef(remote), '--delete', `refs/tags/${safeRef(name)}`]),

  // branches
  renameBranch: (id: string, from: string, to: string) => gitOn(id, ['branch', '-m', safeRef(from), safeRef(to)]),
  setUpstream: (id: string, branch: string, upstream: string | null) =>
    gitOn(id, upstream ? ['branch', `--set-upstream-to=${safeRef(upstream)}`, safeRef(branch)] : ['branch', '--unset-upstream', safeRef(branch)]),
  rebaseOnto: (id: string, name: string) => gitOn(id, ['rebase', '--autostash', safeRef(name)]),
  pushBranch: (id: string, name: string, remote = 'origin') => gitOn(id, ['push', '-u', safeRef(remote), `${safeRef(name)}:${name}`]),

  // stash
  stashBranch: (id: string, ref: string, name: string) => gitOn(id, ['stash', 'branch', safeRef(name), safeRef(ref)]),
  stashClear: (id: string) => gitOn(id, ['stash', 'clear']),
  stashShow: (id: string, ref: string) => gitOn(id, ['stash', 'show', '-p', '--include-untracked', '--no-color', safeRef(ref)]),

  // remotes
  remotes: async (id: string) => gitops.remotes(repo(id).path),
  addRemote: (id: string, name: string, url: string) => gitOn(id, ['remote', 'add', safeRef(name), safeUrl(url)]),
  removeRemote: (id: string, name: string) => gitOn(id, ['remote', 'remove', safeRef(name)]),
  renameRemote: (id: string, from: string, to: string) => gitOn(id, ['remote', 'rename', safeRef(from), safeRef(to)]),
  setRemoteUrl: (id: string, name: string, url: string) => gitOn(id, ['remote', 'set-url', safeRef(name), safeUrl(url)]),
  fetchRemote: (id: string, name: string) => gitOn(id, ['fetch', '--prune', '--tags', safeRef(name)]),

  // identity + maintenance
  identity: async (id: string) => gitops.identity(repo(id).path),
  async setIdentity(id: string, name: string, email: string) {
    for (const [key, value] of [['user.name', name], ['user.email', email]]) {
      if (value.trim()) await gitOn(id, ['config', '--local', key, value.trim()])
      else await git.run(['config', '--local', '--unset', key], { cwd: repo(id).path, okCodes: [5] })
    }
  },
  async maintenance(id: string, task: 'gc' | 'prune' | 'fsck' | 'size') {
    const args = { gc: ['gc', '--prune=now'], prune: ['remote', 'prune', 'origin'], fsck: ['fsck', '--no-progress'], size: ['count-objects', '-vH'] }[task]
    return (await gitOn(id, args)).trim() || 'Done, nothing to report.'
  },

  fetch: (id: string) => gitOn(id, ['fetch', '--all', '--prune']),
  pull: (id: string, mode: 'merge' | 'rebase' | 'ff-only' = 'merge') =>
    gitOn(id, ['pull', '--no-edit', mode === 'rebase' ? '--rebase' : mode === 'ff-only' ? '--ff-only' : '--no-rebase']),
  async push(id: string, opts: { force?: boolean } = {}) {
    const st = await git.status(repo(id).path)
    const args = ['push', ...(opts.force ? ['--force-with-lease'] : [])]
    if (!st.upstream) args.push('-u', 'origin', 'HEAD')
    return gitOn(id, args)
  },
  fetchAll: () => handlers.bulk(load().repos.map((r) => r.id), 'fetch'),
  /** Runs one network operation over many repos; one failure does not stop the rest. */
  async bulk(ids: string[], op: 'fetch' | 'pull' | 'push'): Promise<{ id: string; error?: string }[]> {
    return mapLimit(ids, 4, async (id) => {
      try {
        await (op === 'fetch' ? handlers.fetch(id) : op === 'pull' ? handlers.pull(id) : handlers.push(id))
        return { id }
      } catch (e) {
        return { id, error: (e as Error).message }
      }
    })
  },
  setReposAccount(ids: string[], accountId: string | null): void {
    load().repos.forEach((r) => ids.includes(r.id) && (r.accountId = accountId))
    save()
    gitlink.refreshLinks(ids)
  },

  async clone(accountId: string, cloneUrl: string, groupId: string | null): Promise<Repo> {
    const parent = await pickFolder('Clone into which folder?')
    if (!parent) throw new Error('Cancelled')
    const remote = git.parseRemote(cloneUrl)
    const target = path.join(parent, remote?.repo ?? path.basename(cloneUrl, '.git'))
    await git.run(['clone', '--', cloneUrl, target], { account: account(accountId) })
    const r = await addRepoPath(target, { groupId, accountId })
    save()
    if (!r) throw new Error('Cloned, but the repository was already in the list')
    return r
  },

  // ----- GitHub API -----

  async ghRepo(id: string) {
    const { gh, base } = await ghContext(id)
    return gh.get(base)
  },
  async ghUpdateRepo(id: string, patch: { description?: string; homepage?: string; private?: boolean; default_branch?: string; has_issues?: boolean; archived?: boolean }) {
    const { gh, base } = await ghContext(id)
    return gh.patch(base, patch)
  },
  async ghDeleteRepo(id: string, confirmName: string) {
    const { gh, base, remote } = await ghContext(id)
    if (confirmName !== `${remote!.owner}/${remote!.repo}`) throw new Error('Confirmation name does not match')
    await gh.delete(base)
  },
  async ghAccountRepos(accountId: string) {
    return GitHub.forAccount(accountId).paginate('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', 1000)
  },
  async ghCreateRepo(accountId: string, input: { name: string; description?: string; private: boolean; org?: string; auto_init?: boolean }) {
    const { org, ...body } = input
    return GitHub.forAccount(accountId).post(org ? `/orgs/${org}/repos` : '/user/repos', body)
  },
  /** Creates a GitHub repo for a local-only repository, sets it as origin and pushes. */
  async ghPublish(id: string, accountId: string, input: { name: string; description?: string; private: boolean; org?: string }) {
    const r = repo(id)
    const created = await handlers.ghCreateRepo(accountId, input)
    const hasOrigin = (await git.run(['remote'], { cwd: r.path })).split('\n').includes('origin')
    await git.run(['remote', hasOrigin ? 'set-url' : 'add', 'origin', created.ssh_url], { cwd: r.path })
    r.accountId = accountId
    save()
    await handlers.push(id)
    return created
  },

  async ghPulls(id: string, state: 'open' | 'closed' | 'all') {
    const { gh, base } = await ghContext(id)
    return gh.paginate(`${base}/pulls?state=${state}&per_page=50`, 100)
  },
  async ghCreatePull(id: string, input: { title: string; head: string; base: string; body?: string; draft?: boolean }) {
    const { gh, base } = await ghContext(id)
    return gh.post(`${base}/pulls`, input)
  },
  async ghMergePull(id: string, num: number, method: 'merge' | 'squash' | 'rebase') {
    const { gh, base } = await ghContext(id)
    return gh.put(`${base}/pulls/${num}/merge`, { merge_method: method })
  },

  async ghIssues(id: string, state: 'open' | 'closed' | 'all') {
    const { gh, base } = await ghContext(id)
    const items = await gh.paginate(`${base}/issues?state=${state}&per_page=50`, 100)
    return items.filter((i: any) => !i.pull_request)
  },
  async ghCreateIssue(id: string, input: { title: string; body?: string; labels?: string[] }) {
    const { gh, base } = await ghContext(id)
    return gh.post(`${base}/issues`, input)
  },
  /** Works for both issues and pull requests (they share numbering on GitHub). */
  async ghSetState(id: string, num: number, state: 'open' | 'closed') {
    const { gh, base } = await ghContext(id)
    return gh.patch(`${base}/issues/${num}`, { state })
  },
  async ghComments(id: string, num: number) {
    const { gh, base } = await ghContext(id)
    return gh.paginate(`${base}/issues/${num}/comments?per_page=100`, 300)
  },
  async ghComment(id: string, num: number, body: string) {
    const { gh, base } = await ghContext(id)
    return gh.post(`${base}/issues/${num}/comments`, { body })
  },

  async ghRuns(id: string) {
    const { gh, base } = await ghContext(id)
    return (await gh.get(`${base}/actions/runs?per_page=40`)).workflow_runs
  },
  async ghJobs(id: string, runId: number) {
    const { gh, base } = await ghContext(id)
    return (await gh.get(`${base}/actions/runs/${runId}/jobs`)).jobs
  },
  async ghJobLog(id: string, jobId: number): Promise<string> {
    const { account: a, base } = await ghContext(id)
    // GitHub answers with a redirect to a short-lived plain-text log URL; fetch follows it.
    const res = await fetch(`https://api.github.com${base}/actions/jobs/${jobId}/logs`, {
      headers: { Authorization: `Bearer ${getToken(a!.id)}`, 'User-Agent': 'RepoDock' }
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}: could not load log`)
    const text = await res.text()
    return text.length > 600_000 ? '… (showing last 600 KB)\n' + text.slice(-600_000) : text
  },
  async ghRerun(id: string, runId: number, failedOnly: boolean) {
    const { gh, base } = await ghContext(id)
    return gh.post(`${base}/actions/runs/${runId}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`)
  },
  async ghCancelRun(id: string, runId: number) {
    const { gh, base } = await ghContext(id)
    return gh.post(`${base}/actions/runs/${runId}/cancel`)
  },
  async ghWorkflows(id: string) {
    const { gh, base } = await ghContext(id)
    return (await gh.get(`${base}/actions/workflows?per_page=100`)).workflows
  },
  async ghDispatch(id: string, workflowId: number, ref: string) {
    const { gh, base } = await ghContext(id)
    return gh.post(`${base}/actions/workflows/${workflowId}/dispatches`, { ref })
  },

  // ----- AI agents -----

  agentInfo(): AgentInfo {
    const { policy, rules } = load().agent
    return { running: bridge.bridgeRunning(), policy, rules, clients: agentClients.listClients(), mcpConfig: mcpEntry() }
  },
  agentLog: () => load().agent.log,
  agentClearLog: () => bridge.clearLog(),
  agentApprovals: () => bridge.pendingApprovals(),
  agentAnswer: (id: string, decision: 'once' | 'session' | 'always' | 'deny') => bridge.answer(id, decision),
  agentSetPolicy(policy: AgentPolicy) {
    load().agent.policy = policy
    save()
  },
  agentRemoveRule(index: number) {
    load().agent.rules.splice(index, 1)
    save()
  },
  agentSetClient: (id: string, on: boolean) => agentClients.setClient(id, on),
  agentSetGitLinked: (ids: string[], on: boolean) => gitlink.setLinked(ids, on),
  /** Runs the real helper the way an AI tool would, to prove the whole path works. */
  agentSelfTest(): Promise<{ ok: boolean; error?: string; ms: number }> {
    const started = Date.now()
    try {
      installHelper()
    } catch (e) {
      return Promise.resolve({ ok: false, error: (e as Error).message, ms: 0 })
    }
    if (!bridge.bridgeRunning()) bridge.startBridge()
    return new Promise((resolve) => {
      const child = execFile(
        helperExe(), [helperScript(), 'selftest'],
        { env: { ...process.env, ...mcpEntry().env }, windowsHide: true, timeout: 15_000 },
        (err, stdout) => {
          try {
            const r = JSON.parse(String(stdout).trim().split(/\r?\n/).pop() ?? '')
            resolve({ ok: !!r.ok, error: r.error, ms: Date.now() - started })
          } catch {
            const firstError = err ? String(err.message).split(/\r?\n/).find((l) => /Error:/.test(l)) : undefined
            resolve({ ok: false, error: firstError ?? err?.message ?? 'The helper did not answer', ms: Date.now() - started })
          }
        }
      )
      child.stdin?.end()
    })
  },

  // ----- shell -----

  openPath: (p: string) => shell.openPath(p),
  showInFolder: (p: string) => shell.showItemInFolder(p),
  openExternal: (url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error('Only https links can be opened')
    return shell.openExternal(url)
  }
}

export type Handlers = typeof handlers
