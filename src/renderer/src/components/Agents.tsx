import { useEffect, useMemo, useState } from 'react'
import type { AgentClient, AgentInfo, AgentLogEntry, AgentPolicy } from '../../../shared/types'
import { api, onEvent } from '../api'
import { AGENT_TOOLS } from '../../../shared/agentTools'
import { Modal, ago, fullDate, useApp } from './ui'

const POLICIES: { id: AgentPolicy; title: string; desc: string }[] = [
  { id: 'ask-remote', title: 'Ask before push & pull requests', desc: 'AI tools can read, commit and switch branches freely. Anything that reaches GitHub waits for your OK. Recommended.' },
  { id: 'ask-writes', title: 'Ask before any change', desc: 'Reading is free; commits, branch switches, pulls and pushes all need your OK.' },
  { id: 'trust', title: 'Don’t ask', desc: 'AI tools act on their own. Force-push still always asks.' }
]

const TOOL_LABEL: Record<string, string> = {
  list_repos: 'List repos', repo_status: 'Status', diff: 'Diff', log: 'Log', branches: 'Branches', fetch: 'Fetch', commit: 'Commit',
  checkout: 'Switch branch', pull: 'Pull', push: 'Push', create_pull_request: 'Open PR', list_pull_requests: 'List PRs', ci_status: 'CI status',
  add_repo: 'Add repo', git: 'git command'
}

const CLIENT_INITIALS: Record<string, string> = { 'claude-code': 'CC', 'claude-desktop': 'C', cursor: 'Cu', vscode: 'VS', windsurf: 'W', codex: 'Cx', gemini: 'G' }

export function Agents() {
  const { state, summaries, accountById, act, toast, reload } = useApp()
  const [info, setInfo] = useState<AgentInfo | null>(null)
  const [log, setLog] = useState<AgentLogEntry[]>([])
  const [check, setCheck] = useState<{ ok: boolean; error?: string; ms: number } | 'running' | null>(null)
  const [showConfig, setShowConfig] = useState(false)
  const [repoQuery, setRepoQuery] = useState('')
  const [logFilter, setLogFilter] = useState<'all' | 'error' | 'denied'>('all')

  const refresh = () => api.agentInfo().then(setInfo)
  useEffect(() => {
    refresh()
    api.agentLog().then(setLog)
    return onEvent<AgentLogEntry>('agent:log', (e) =>
      setLog((l) => (l.some((x) => x.id === e.id) ? l.map((x) => (x.id === e.id ? e : x)) : [e, ...l]))
    )
  }, [])

  const runCheck = async () => {
    setCheck('running')
    setCheck(await api.agentSelfTest())
  }

  const setClient = async (c: AgentClient, on: boolean) => {
    await act(() => api.agentSetClient(c.id, on), on ? `${c.name} connected. Restart ${c.name} to load RepoDock.` : `${c.name} disconnected`)
    refresh()
  }

  const repos = useMemo(() => {
    const q = repoQuery.toLowerCase()
    return state.repos.filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name))
  }, [state.repos, repoQuery])
  const linked = state.repos.filter((r) => r.gitLinked).length

  const setLinked = async (ids: string[], on: boolean) => {
    const res = await act(() => api.agentSetGitLinked(ids, on))
    await reload()
    const failed = res?.filter((r) => r.error) ?? []
    if (failed.length) toast(`Could not update ${failed.length} repo(s):\n` + failed.map((f) => `• ${state.repos.find((r) => r.id === f.id)?.name}: ${f.error}`).join('\n'), 'err')
    else if (res) toast(on ? `Plain git now uses RepoDock accounts in ${ids.length} repo(s)` : `Turned off for ${ids.length} repo(s)`)
  }

  const shownLog = log.filter((e) => logFilter === 'all' || e.status === logFilter)
  const configJson = info ? JSON.stringify({ mcpServers: { repodock: info.mcpConfig } }, null, 2) : ''

  return (
    <div className="page agents">
      <div className="page-head">
        <div>
          <h2>AI agents</h2>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            RepoDock has a built-in <b>MCP server</b>. Connect it to Claude Code, Cursor, Copilot or any other AI tool, and the AI can commit, push, pull
            and open pull requests through RepoDock. It always uses the right GitHub account and never sees your keys or tokens.
          </p>
        </div>
        <div className="row" style={{ marginTop: 0 }}>
          <span className={`status-dot ${info?.running ? 'ok' : 'err'}`}>{info?.running ? 'MCP server ready' : 'MCP server stopped'}</span>
          <button onClick={runCheck} disabled={check === 'running'}>{check === 'running' ? 'Checking…' : 'Run check'}</button>
        </div>
      </div>
      {check && check !== 'running' && (
        <div className={`banner ${check.ok ? 'ok' : 'err'}`}>
          {check.ok ? `✓ Everything works: an AI tool can reach RepoDock (${check.ms} ms).` : `✕ The helper could not reach RepoDock: ${check.error}`}
        </div>
      )}

      {/* 1. MCP clients */}
      <section className="ag-section">
        <div className="ag-step"><span>1</span>Add the RepoDock MCP server to your AI tools</div>
        <p className="hint">Click <b>Connect</b>, then restart that AI tool. Now just ask it things like <i>“commit and push my changes”</i> or <i>“open a pull request”</i>.</p>
        <div className="ag-clients">
          {info?.clients.map((c) => (
            <div key={c.id} className={`ag-client ${c.connected && c.detected ? 'on' : ''} ${c.connected && !c.detected ? 'stray' : ''} ${!c.detected && !c.connected ? 'dim' : ''}`}>
              <div className="ag-client-logo">{CLIENT_INITIALS[c.id] ?? c.name[0]}</div>
              <div className="ag-client-info">
                <b>{c.name}</b>
                <span
                  className={c.error ? 'err-text' : c.connected && !c.detected ? 'warn-text' : c.connected ? 'ok-text' : 'muted'}
                  title={c.error ?? (c.connected && !c.detected ? `${c.name} isn't installed, but its config file has a RepoDock entry: ${c.configPath}. Click Remove to delete it.` : c.configPath)}
                >
                  {c.error ? 'Config can’t be edited' : c.connected && !c.detected ? '⚠ Not installed' : c.connected ? '● Connected' : c.detected ? 'Installed' : 'Not installed'}
                </span>
              </div>
              {c.connected ? (
                <button className="small" onClick={() => setClient(c, false)}>{c.detected ? 'Disconnect' : 'Remove'}</button>
              ) : (
                c.detected && !c.error && <button className="small primary" onClick={() => setClient(c, true)}>Connect</button>
              )}
            </div>
          ))}
          <div className="ag-client other">
            <div className="ag-client-logo">+</div>
            <div className="ag-client-info"><b>Other MCP tool</b><span className="muted">Copy the config</span></div>
            <button className="small" onClick={() => setShowConfig(true)}>Show</button>
          </div>
        </div>
        <div className="ag-tools">
          <span className="muted">What the AI can do:</span>
          {AGENT_TOOLS.map((t) => (
            <span key={t.name} className={`ag-tool ${t.risk}`} title={t.description}>{t.title}</span>
          ))}
        </div>
      </section>

      {/* 2. Permissions */}
      <section className="ag-section">
        <div className="ag-step"><span>2</span>Choose what needs your approval</div>
        <div className="ag-policies">
          {POLICIES.map((p) => (
            <button
              key={p.id}
              className={`ag-policy ${info?.policy === p.id ? 'sel' : ''}`}
              onClick={async () => (await api.agentSetPolicy(p.id), refresh())}
            >
              <span className="radio" />
              <span><b>{p.title}</b><span>{p.desc}</span></span>
            </button>
          ))}
        </div>
        {!!info?.rules.length && (
          <div className="ag-rules">
            <div className="ag-rules-title">Always allowed</div>
            {info.rules.map((r, i) => (
              <div key={i} className="ag-rule">
                <span><b>{r.client}</b> may <b>{TOOL_LABEL[r.tool] ?? r.tool}</b> in <b>{state.repos.find((x) => x.id === r.repoId)?.name ?? 'removed repo'}</b> without asking</span>
                <button className="small" onClick={async () => (await api.agentRemoveRule(i), refresh())}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Activity */}
      <section className="ag-section">
        <div className="ag-step plain">
          Activity
          <div className="grow" />
          <div className="seg">
            {(['all', 'error', 'denied'] as const).map((f) => (
              <button key={f} className={logFilter === f ? 'active' : ''} onClick={() => setLogFilter(f)}>{f === 'all' ? 'All' : f === 'error' ? 'Failed' : 'Denied'}</button>
            ))}
          </div>
          {log.length > 0 && <button className="small" onClick={async () => (await api.agentClearLog(), setLog([]))}>Clear</button>}
        </div>
        <div className="ag-log">
          {shownLog.map((e) => (
            <div key={e.id} className={`ag-log-row ${e.status}`}>
              <span className={`ag-status ${e.status}`}>{e.status === 'ok' ? '✓' : e.status === 'error' ? '✕' : e.status === 'denied' ? '⊘' : '…'}</span>
              <span className="ag-log-client">{e.client}</span>
              <span className="ag-log-what">
                <b>{TOOL_LABEL[e.tool] ?? e.tool}</b>
                {e.repoName && <span className="muted"> · {e.repoName}</span>}
                {e.summary && <span className="muted"> · {e.summary}</span>}
                {e.error && <div className="err-text ag-log-err">{e.error.split('\n')[0]}</div>}
              </span>
              <span className="muted ag-log-time" title={fullDate(e.time)}>{ago(e.time)}</span>
            </div>
          ))}
          {!shownLog.length && <div className="empty small">{log.length ? 'Nothing matches this filter' : 'No AI activity yet. Connect a tool above and ask it to check a repo’s status.'}</div>}
        </div>
      </section>

      {/* Advanced: plain git */}
      <details className="ag-section ag-advanced" open={linked > 0}>
        <summary className="ag-step plain">Advanced: AI tools that run <code>git</code> themselves <span className="count">{linked}/{state.repos.length}</span></summary>
        <p className="hint">
          Not needed when your AI tool uses the MCP server above. Some tools (and you, in a terminal or IDE) still run <code>git push</code> directly. Turn this on and those commands authenticate as the repo’s account too.
          RepoDock adds a single <code>include</code> line to the repo’s <code>.git/config</code>; turning it off removes it again.
          SSH accounts keep working even when RepoDock is closed; token accounts need RepoDock running.
        </p>
        <div className="row" style={{ marginBottom: 8 }}>
          <input className="grow" placeholder="Filter repos…" value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} />
          {linked < state.repos.length && <button onClick={() => setLinked(state.repos.filter((r) => !r.gitLinked).map((r) => r.id), true)}>Enable for all</button>}
          {linked > 0 && <button onClick={() => setLinked(state.repos.filter((r) => r.gitLinked).map((r) => r.id), false)}>Disable all</button>}
        </div>
        <div className="ag-repos">
          {repos.map((r) => {
            const a = accountById(summaries[r.id]?.effectiveAccountId ?? '')
            return (
              <label key={r.id} className={`ag-repo ${r.gitLinked ? 'on' : ''}`}>
                <span className="switch">
                  <input type="checkbox" checked={!!r.gitLinked} onChange={(e) => setLinked([r.id], e.target.checked)} />
                  <i />
                </span>
                <span className="ag-repo-name" title={r.path}>{r.name}</span>
                <span className="ag-repo-acc">
                  {a ? <>{a.label} <span className="muted">· {a.authMethod === 'token' ? 'token, needs RepoDock open' : 'SSH, works offline'}</span></> : <span className="warn-text">no account</span>}
                </span>
              </label>
            )
          })}
          {!repos.length && <div className="empty small">No repositories</div>}
        </div>
      </details>


      {showConfig && info && (
        <Modal title="Add RepoDock to another MCP tool" onClose={() => setShowConfig(false)} wide>
          <p className="hint">Paste this into the tool’s MCP settings (the key is usually <code>mcpServers</code>; VS Code uses <code>servers</code>).</p>
          <pre className="code-block">{configJson}</pre>
          <div className="row end">
            <button className="primary" onClick={() => (navigator.clipboard.writeText(configJson), toast('Copied'))}>Copy</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
