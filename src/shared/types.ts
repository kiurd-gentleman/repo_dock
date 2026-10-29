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
  /** Plain `git` commands (terminal, IDEs, AI tools) authenticate through RepoDock. */
  gitLinked?: boolean
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

/** A multi-step git operation that stopped half-way (usually on a conflict). */
export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface RepoState {
  operation: RepoOperation | null
  /** Short description such as "rebasing feature onto main (3/7)". */
  detail: string
  conflicted: number
  /** Commit HEAD points at when it isn't on a branch. */
  detachedAt: string | null
}

export interface Tag {
  name: string
  sha: string
  date: number
  /** Annotation message; empty for lightweight tags. */
  message: string
  annotated: boolean
}

export interface Remote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

export interface RebaseStep {
  sha: string
  action: RebaseAction
  /** New message for reword, or for the combined commit when squashing. */
  message?: string
}

export interface RepoIdentity {
  name: string
  email: string
  /** Values git falls back to when the repo sets none. */
  globalName: string
  globalEmail: string
}

export interface Stash {
  ref: string
  message: string
}

/** App colour theme; 'system' follows the OS light/dark setting. */
export type ThemeSetting = 'system' | 'light' | 'dark'

export interface UpdateStatus {
  state: 'idle' | 'unsupported' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'
  /** Running version. */
  current: string
  /** Newer version on GitHub Releases, once found. */
  version?: string
  percent?: number
  checkedAt?: number
  message?: string
  /** False in development and on macOS (unsigned): there “update” means opening the download page. */
  autoInstall: boolean
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  packaged: boolean
  /** "git version 2.47.0.windows.1", or null when git isn't found. */
  git: string | null
  dataDir: string
  backupsDir: string
  backups: { file: string; date: number; size: number }[]
}

export interface AppState {
  accounts: Account[]
  groups: Group[]
  repos: Repo[]
}

// ---------- AI agents ----------

/** When AI tools must ask before acting. Force-push and similar always ask. */
export type AgentPolicy = 'ask-remote' | 'ask-writes' | 'trust'

export interface AgentRule {
  client: string
  repoId: string
  tool: string
}

export interface AgentLogEntry {
  id: string
  time: number
  client: string
  repoId: string | null
  repoName: string | null
  tool: string
  summary: string
  status: 'ok' | 'error' | 'denied' | 'pending'
  error?: string
  ms?: number
}

export interface AgentApproval {
  id: string
  client: string
  repoId: string
  repoName: string
  tool: string
  title: string
  risk: 'normal' | 'high'
  accountLabel: string | null
  details: { label: string; value: string }[]
  list?: { label: string; items: string[] }
  createdAt: number
  timeoutAt: number
}

export interface AgentClient {
  id: string
  name: string
  detected: boolean
  connected: boolean
  configPath: string
  error?: string
}

export interface AgentInfo {
  running: boolean
  policy: AgentPolicy
  rules: AgentRule[]
  clients: AgentClient[]
  /** MCP server entry, for tools RepoDock can't configure automatically. */
  mcpConfig: { command: string; args: string[]; env: Record<string, string> }
}
