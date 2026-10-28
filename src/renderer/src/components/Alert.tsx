import { useEffect, useRef, useState } from 'react'

export interface AlertItem {
  id: number
  message: string
}

/** Short title + plain-language hint for the git/GitHub failures people hit most. */
function explain(msg: string): { title: string; hint?: string } {
  if (/could not read (username|password)|authentication failed|invalid username or password/i.test(msg))
    return { title: 'Authentication failed', hint: 'GitHub did not accept the credentials. Check which account this repo uses (repo header → Account) and that its key or token is still valid (Accounts → Test SSH).' }
  if (/permission denied \(publickey\)/i.test(msg))
    return { title: 'SSH key rejected', hint: 'This account’s SSH key is not registered on GitHub, or it belongs to a different GitHub user. Use Accounts → Test SSH to check.' }
  if (/repository not found|404/i.test(msg))
    return { title: 'Repository not found', hint: 'The repo does not exist, or the selected account has no access to it.' }
  if (/401|token was rejected/i.test(msg)) return { title: 'Token rejected' }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(msg))
    return { title: 'Push rejected', hint: 'The remote has commits you don’t have yet. Pull first, then push again.' }
  if (/conflict/i.test(msg)) return { title: 'Merge conflict', hint: 'Resolve the conflicted files in the Changes tab, then commit.' }
  if (/not a git repository/i.test(msg)) return { title: 'Not a git repository', hint: 'That folder has no .git directory. Use “Import folder” to scan for repos inside it.' }
  if (/could not resolve host|network|timed out|ETIMEDOUT|ENOTFOUND/i.test(msg)) return { title: 'Network problem', hint: 'GitHub could not be reached. Check your internet connection.' }
  if (/^warning/i.test(msg)) return { title: 'Warning' }
  return { title: 'Something went wrong' }
}

export function AlertHost({ items, dismiss }: { items: AlertItem[]; dismiss: (id: number) => void }) {
  const current = items[0]
  const [copied, setCopied] = useState(false)
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setCopied(false)
    okRef.current?.focus()
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        dismiss(current.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, dismiss])

  if (!current) return null
  const { title, hint } = explain(current.message)
  const warn = title === 'Warning'

  return (
    <div className="alert-bg" onMouseDown={(e) => e.target === e.currentTarget && dismiss(current.id)}>
      <div className="alert" role="alertdialog" aria-labelledby="alert-title">
        <div className={`alert-icon ${warn ? 'warn' : 'err'}`}>
          {warn ? (
            <svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" /><path d="M26 14v16M26 37v1" /></svg>
          ) : (
            <svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" /><path d="M18 18l16 16M34 18L18 34" /></svg>
          )}
        </div>
        <h2 id="alert-title">{title}</h2>
        {hint && <p className="alert-hint">{hint}</p>}
        <pre className="alert-msg">{current.message}</pre>
        <div className="alert-actions">
          <button
            onClick={() => {
              navigator.clipboard.writeText(current.message)
              setCopied(true)
            }}
          >
            {copied ? 'Copied ✓' : 'Copy details'}
          </button>
          <button ref={okRef} className="primary" onClick={() => dismiss(current.id)}>
            OK{items.length > 1 ? ` (${items.length - 1} more)` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
