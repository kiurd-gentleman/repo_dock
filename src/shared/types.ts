export type AuthMethod = 'ssh-auto' | 'ssh-manual' | 'token'

export interface Account {
  id: string
  label: string
  login: string
  name?: string
  avatarUrl?: string
  authMethod: AuthMethod
  hasToken: boolean
  tokenScopes?: string
  /** Public key in OpenSSH format (ssh-* accounts only). */
  sshPublicKey?: string
  sshFingerprint?: string
  /** Absolute path to the private key; lives in the app's data folder. */
  sshKeyPath?: string
  /** Id of the key on GitHub when the app uploaded it. */
  githubKeyId?: number
  orgs: string[]
  createdAt: number
}

export interface Group {
  id: string
  name: string
  color: string
}

export interface Repo {
  id: string
  path: string
  name: string
  groupId: string | null
  /** Manual account override; null means auto-detect from the remote owner. */
  accountId: string | null
  addedAt: number
}

export interface RepoSummary {
  id: string
  exists: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  remoteUrl: string | null
  owner: string | null
  repoName: string | null
  /** Account that will be used for network operations. */
  effectiveAccountId: string | null
  lastCommit: { sha: string; subject: string; date: number; author: string } | null
  error?: string
}

export interface FileChange {
  path: string
  origPath?: string
  index: string
  worktree: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface StatusResult {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: FileChange[]
}

export interface Commit {
  sha: string
  shortSha: string
  author: string
  email: string
  date: number
  refs: string
  subject: string
  parents: string[]
}

export interface CommitDetail extends Commit {
  body: string
  files: { status: string; path: string; oldPath?: string; additions: number; deletions: number; binary: boolean }[]
  patch: string
  truncated: boolean
}

export interface Branch {
  name: string
  remote: boolean
  upstream: string
  sha: string
  current: boolean
  date: number
  track: string
}

export interface Stash {
  ref: string
  message: string
}

export interface AppState {
  accounts: Account[]
  groups: Group[]
  repos: Repo[]
}
