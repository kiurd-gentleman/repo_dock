import fs from 'node:fs'
import path from 'node:path'
import type { Account, Repo } from '../../shared/types'
import { agentDir, load, save } from '../store'
import * as git from '../git'
import { detectAccount } from '../handlers'
import { gitHelperCommand } from './paths'

/**
 * "Linking" a repo lets any plain `git` command (terminal, IDE, AI tool) authenticate as the
 * repo's account. The repo's .git/config gets exactly one line, `include.path = <file>`, and all
 * settings live in that RepoDock-owned file, so unlinking is a clean one-line removal.
 */
const includeFile = (repoId: string): string => path.join(agentDir(), 'git', `${repoId}.gitconfig`)
const fwd = (p: string): string => p.replace(/\\/g, '/')

/** Quotes a value for a git config file. */
const cv = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function sshCommand(a: Account): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s)
  return [quote(fwd(git.sshTool('ssh'))), ...git.sshArgs(a.sshKeyPath!).map(quote)].join(' ')
}

async function render(r: Repo): Promise<{ text: string; account: Account | null }> {
  const remote = git.parseRemote(await git.remoteUrl(r.path))
  const a = detectAccount(r, remote?.owner ?? null)
  const embedded = await git.embeddedCredentialPrefixes(r.path)
  const lines = ['# Managed by RepoDock — authenticates plain git commands as the repo’s account.', '# Remove with RepoDock → AI agents → Git commands.', '']
  if (!a) lines.push('# No account linked to this repository yet.')
  else if (a.authMethod === 'token') {
    lines.push('[url "https://github.com/"]', `\tinsteadOf = git@github.com:`, `\tinsteadOf = ssh://git@github.com/`)
    for (const p of embedded) lines.push(`\tinsteadOf = ${cv(p)}`)
    // An empty helper resets helpers from the global config (e.g. Git Credential Manager).
    lines.push('[credential "https://github.com"]', '\thelper =', `\thelper = ${cv(gitHelperCommand(`credential ${r.id}`))}`)
  } else if (a.sshKeyPath) {
    lines.push('[core]', `\tsshCommand = ${cv(sshCommand(a))}`)
    lines.push('[url "git@github.com:"]', '\tinsteadOf = https://github.com/')
    for (const p of embedded) lines.push(`\tinsteadOf = ${cv(p)}`)
  }
  return { text: lines.join('\n') + '\n', account: a }
}

async function hasInclude(r: Repo, file: string): Promise<boolean> {
  const out = await git.run(['config', '--local', '--get-all', 'include.path'], { cwd: r.path, okCodes: [1] })
  return out.split('\n').some((l) => path.normalize(l.trim()).toLowerCase() === path.normalize(file).toLowerCase())
}

export async function link(r: Repo): Promise<void> {
  const file = includeFile(r.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, (await render(r)).text)
  if (!(await hasInclude(r, file))) await git.run(['config', '--local', '--add', 'include.path', fwd(file)], { cwd: r.path })
  r.gitLinked = true
}

export async function unlink(r: Repo): Promise<void> {
  const file = includeFile(r.id)
  if (fs.existsSync(r.path)) {
    const escaped = fwd(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await git.run(['config', '--local', '--unset-all', 'include.path', `^${escaped}$`], { cwd: r.path, okCodes: [5] }).catch(() => {})
  }
  fs.rmSync(file, { force: true })
  r.gitLinked = false
}

/** Rewrites every linked repo's file, e.g. after an account, key or app-location change. */
export async function refreshLinks(ids?: string[]): Promise<void> {
  const repos = load().repos.filter((r) => r.gitLinked && (!ids || ids.includes(r.id)) && fs.existsSync(r.path))
  await Promise.all(repos.map((r) => link(r).catch(() => {})))
}

export async function setLinked(ids: string[], on: boolean): Promise<{ id: string; error?: string }[]> {
  const repos = load().repos.filter((r) => ids.includes(r.id))
  const res = await Promise.all(
    repos.map(async (r) => {
      try {
        await (on ? link(r) : unlink(r))
        return { id: r.id }
      } catch (e) {
        return { id: r.id, error: (e as Error).message }
      }
    })
  )
  save()
  return res
}
