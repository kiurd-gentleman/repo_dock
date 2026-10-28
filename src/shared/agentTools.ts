/**
 * Tools RepoDock offers to AI agents over MCP. Kept free of Node/Electron imports so both the
 * app and the standalone MCP helper can use it.
 *
 * risk: read   – never asks
 *       write  – changes the local repo; asks only under the strictest policy
 *       remote – talks to GitHub on the user's behalf; asks under the default policy
 */
export type ToolRisk = 'read' | 'write' | 'remote'

export interface AgentTool {
  name: string
  title: string
  description: string
  risk: ToolRisk
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

const repo = {
  type: 'string',
  description: 'Repository: its folder path, name, or RepoDock id. Omit to use the repository containing the current working directory.'
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'list_repos',
    title: 'List repositories',
    description: 'Lists repositories managed by RepoDock with branch, pending changes, ahead/behind counts and the GitHub account each one uses.',
    risk: 'read',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional filter on name or path' } } }
  },
  {
    name: 'repo_status',
    title: 'Repository status',
    description: 'Current branch, upstream, ahead/behind, the GitHub account used for push/pull, and the list of changed files.',
    risk: 'read',
    inputSchema: { type: 'object', properties: { repo } }
  },
  {
    name: 'diff',
    title: 'Show diff',
    description: 'Unified diff of uncommitted changes (working tree by default, or staged changes).',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        repo,
        staged: { type: 'boolean', description: 'Show staged changes instead of unstaged ones' },
        path: { type: 'string', description: 'Limit to one file (path relative to the repo root)' }
      }
    }
  },
  {
    name: 'log',
    title: 'Commit history',
    description: 'Recent commits on the current branch (or the given branch).',
    risk: 'read',
    inputSchema: { type: 'object', properties: { repo, limit: { type: 'number', description: 'Default 20, max 100' }, branch: { type: 'string' } } }
  },
  {
    name: 'branches',
    title: 'List branches',
    description: 'Local and remote branches with their upstream and ahead/behind state.',
    risk: 'read',
    inputSchema: { type: 'object', properties: { repo } }
  },
  {
    name: 'fetch',
    title: 'Fetch',
    description: 'Fetches from all remotes using the repository’s GitHub account. Does not change local files.',
    risk: 'read',
    inputSchema: { type: 'object', properties: { repo } }
  },
  {
    name: 'commit',
    title: 'Commit',
    description: 'Creates a commit. Stages the given files first, or everything when `all` is true; otherwise commits what is already staged.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        repo,
        message: { type: 'string', description: 'Commit message' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files to stage before committing' },
        all: { type: 'boolean', description: 'Stage all changes (including new files) before committing' }
      },
      required: ['message']
    }
  },
  {
    name: 'checkout',
    title: 'Switch branch',
    description: 'Switches to a branch, optionally creating it from the current HEAD.',
    risk: 'write',
    inputSchema: { type: 'object', properties: { repo, branch: { type: 'string' }, create: { type: 'boolean', description: 'Create the branch first' } }, required: ['branch'] }
  },
  {
    name: 'pull',
    title: 'Pull',
    description: 'Pulls the current branch from its upstream using the repository’s GitHub account.',
    risk: 'write',
    inputSchema: { type: 'object', properties: { repo } }
  },
  {
    name: 'push',
    title: 'Push',
    description: 'Pushes the current branch using the repository’s GitHub account (sets the upstream on first push). `force` uses --force-with-lease and always needs the user’s approval.',
    risk: 'remote',
    inputSchema: { type: 'object', properties: { repo, force: { type: 'boolean' } } }
  },
  {
    name: 'create_pull_request',
    title: 'Open pull request',
    description: 'Opens a GitHub pull request from the current branch (or `head`) into the default branch (or `base`). Push the branch first.',
    risk: 'remote',
    inputSchema: {
      type: 'object',
      properties: {
        repo,
        title: { type: 'string' },
        body: { type: 'string' },
        base: { type: 'string', description: 'Target branch; defaults to the repository’s default branch' },
        head: { type: 'string', description: 'Source branch; defaults to the current branch' },
        draft: { type: 'boolean' }
      },
      required: ['title']
    }
  },
  {
    name: 'list_pull_requests',
    title: 'List pull requests',
    description: 'Pull requests on GitHub for the repository.',
    risk: 'read',
    inputSchema: { type: 'object', properties: { repo, state: { type: 'string', enum: ['open', 'closed', 'all'] } } }
  },
  {
    name: 'ci_status',
    title: 'CI status',
    description: 'Latest GitHub Actions runs for the repository (optionally one branch).',
    risk: 'read',
    inputSchema: { type: 'object', properties: { repo, branch: { type: 'string' } } }
  },
  {
    name: 'add_repo',
    title: 'Add repository',
    description: 'Adds a local git repository to RepoDock so the other tools can use it.',
    risk: 'write',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Folder inside the repository' } }, required: ['path'] }
  }
]

export const SERVER_INSTRUCTIONS =
  'RepoDock manages the user’s git repositories and their GitHub accounts (each with its own SSH key or token). ' +
  'Prefer these tools over running `git push`, `git pull` or `gh` yourself: they authenticate as the correct account automatically ' +
  'and the user may need to approve remote actions in the RepoDock window. Omit `repo` to act on the repository containing your working directory.'
