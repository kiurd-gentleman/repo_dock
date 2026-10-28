import { useEffect, useState } from 'react'
import type { AgentApproval } from '../../../shared/types'
import { api } from '../api'

const TOOL_ICON: Record<string, string> = { push: '↑', pull: '↓', commit: '✓', checkout: '⎇', create_pull_request: '⇄' }

/** Asks the user to approve an AI tool's action. Queued; Enter = allow once, Esc = deny. */
export function ApprovalHost({ items }: { items: AgentApproval[] }) {
  const a = items[0]
  const [now, setNow] = useState(Date.now())
  const [more, setMore] = useState(false)

  useEffect(() => {
    if (!a) return
    setMore(false)
    const t = setInterval(() => setNow(Date.now()), 1000)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') (e.preventDefault(), api.agentAnswer(a.id, 'once'))
      if (e.key === 'Escape') (e.preventDefault(), api.agentAnswer(a.id, 'deny'))
    }
    window.addEventListener('keydown', onKey)
    return () => (clearInterval(t), window.removeEventListener('keydown', onKey))
  }, [a])

  if (!a) return null
  const left = Math.max(0, Math.round((a.timeoutAt - now) / 1000))
  const decide = (d: 'once' | 'session' | 'always' | 'deny') => api.agentAnswer(a.id, d)

  return (
    <div className="alert-bg">
      <div className={`approval ${a.risk === 'high' ? 'high' : ''}`} role="alertdialog" aria-labelledby="approval-title">
        <div className="approval-head">
          <div className="approval-icon">{TOOL_ICON[a.tool] ?? '⚙'}</div>
          <div>
            <div className="approval-who"><b>{a.client}</b> wants to</div>
            <h2 id="approval-title">{a.title} <span className="muted">in</span> {a.repoName}</h2>
          </div>
          {items.length > 1 && <span className="pill">{items.length - 1} more waiting</span>}
        </div>

        <dl className="approval-details">
          <dt>Account</dt>
          <dd>{a.accountLabel ?? <span className="warn-text">No account linked: this will probably fail</span>}</dd>
          {a.details.map((d) => (
            <div key={d.label} className="approval-row">
              <dt>{d.label}</dt>
              <dd className={d.label === 'Warning' ? 'err-text' : ''}>{d.value}</dd>
            </div>
          ))}
        </dl>

        {a.list && a.list.items.length > 0 && (
          <div className="approval-list">
            <div className="approval-list-label">{a.list.label}</div>
            <ul>{a.list.items.map((x, i) => <li key={i}><code>{x}</code></li>)}</ul>
          </div>
        )}

        <div className="approval-actions">
          <button className="danger" onClick={() => decide('deny')}>Deny <kbd>Esc</kbd></button>
          <div className="grow" />
          {a.risk !== 'high' && <div className="approval-more">
            <button onClick={() => setMore((m) => !m)} aria-expanded={more}>Allow more ▾</button>
            {more && (
              <div className="approval-menu">
                <button onClick={() => decide('session')}>
                  <b>Allow until RepoDock restarts</b>
                  <span>{a.title} in {a.repoName} by {a.client}</span>
                </button>
                <button onClick={() => decide('always')}>
                  <b>Always allow</b>
                  <span>{a.title} in {a.repoName} by {a.client}. Undo in AI agents → Permissions</span>
                </button>
              </div>
            )}
          </div>}
          <button className="primary" autoFocus onClick={() => decide('once')}>Allow <kbd>Enter</kbd></button>
        </div>
        <div className="approval-timer">Auto-denies in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</div>
      </div>
    </div>
  )
}
