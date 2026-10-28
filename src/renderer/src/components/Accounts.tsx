import { useState } from 'react'
import type { Account, AuthMethod } from '../../../shared/types'
import { api } from '../api'
import { AccountBadge, Modal, ago, methodLabel, useApp } from './ui'

const TOKEN_URL = 'https://github.com/settings/tokens/new?description=RepoDock&scopes=repo,workflow,admin:public_key,read:org,delete_repo'

const METHODS: { id: AuthMethod; title: string; desc: string }[] = [
  { id: 'ssh-auto', title: 'SSH — automatic', desc: 'RepoDock creates a key for this account and uploads only the public half to GitHub using your token. The private key stays on this PC. Git uses SSH, and the token is used for PRs, issues and Actions.' },
  { id: 'ssh-manual', title: 'SSH — manual', desc: 'RepoDock creates (or imports) a key; you paste the public key into GitHub yourself. A token is optional and only needed for PRs, issues and Actions.' },
  { id: 'token', title: 'HTTPS + token', desc: 'No SSH key at all. Git and the API both use the token, which is stored encrypted on this PC. Nothing is added to your GitHub SSH settings.' }
]

export function Accounts() {
  const { state, summaries } = useApp()
  const [adding, setAdding] = useState(false)
  const [justAdded, setJustAdded] = useState<Account | null>(null)
  const usage = (id: string) => Object.values(summaries).filter((s) => s.effectiveAccountId === id).length

  return (
    <div className="page">
      <div className="page-head">
        <h2>Accounts</h2>
        <button className="primary" onClick={() => setAdding(true)}>+ Add account</button>
      </div>
      <p className="hint">
        Each account gets its own key/token. When you push, pull or clone, RepoDock picks the account linked to the repo (auto-detected from the
        remote owner, or set by hand in the repo header) and passes its key only to that git command — your global <code>~/.ssh</code> and git config are never changed.
      </p>
      <div className="cards">
        {state.accounts.map((a) => <AccountCard key={a.id} a={a} repos={usage(a.id)} />)}
        {!state.accounts.length && <div className="empty">No accounts yet.</div>}
      </div>
      {adding && <AddAccount onClose={() => setAdding(false)} onAdded={(a) => (setAdding(false), a.authMethod === 'ssh-manual' && setJustAdded(a))} />}
      {justAdded && (
        <Modal title="Add this key to GitHub" onClose={() => setJustAdded(null)}>
          <p>Paste this public key into <a onClick={() => api.openExternal('https://github.com/settings/ssh/new')}>GitHub → Settings → SSH keys</a>, signed in as the right account. Then use “Test SSH”.</p>
          <PublicKey value={justAdded.sshPublicKey!} />
        </Modal>
      )}
    </div>
  )
}

function PublicKey({ value }: { value: string }) {
  const { toast } = useApp()
  return (
    <div className="pubkey">
      <code>{value}</code>
      <button onClick={() => navigator.clipboard.writeText(value).then(() => toast('Public key copied'))}>Copy</button>
    </div>
  )
}

function AccountCard({ a, repos }: { a: Account; repos: number }) {
  const { act, reload, toast } = useApp()
  const [tokenEdit, setTokenEdit] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)

  const test = async () => {
    const r = await act(() => api.testSsh(a.id))
    if (!r) return
    toast(r.ok ? `SSH works: GitHub says you are ${r.login}` : `SSH failed: ${r.message}`, r.ok ? 'ok' : 'err')
    if (r.ok && r.login && a.login && r.login.toLowerCase() !== a.login.toLowerCase()) toast(`Warning: this key belongs to ${r.login}, not ${a.login}`, 'err')
    await reload()
  }

  const remove = async () => {
    const fromGh = !!a.githubKeyId && confirm(`Also delete this app's SSH key from the GitHub account ${a.login}?\n\nOK = delete from GitHub too, Cancel = keep it there`)
    if (!confirm(`Remove account "${a.label}" from RepoDock? Its local key and token are deleted.`)) return
    await act(() => api.removeAccount(a.id, fromGh), 'Account removed')
    await reload()
  }

  return (
    <div className="card account">
      <div className="row">
        <AccountBadge account={a} size={40} />
        <div className="grow">
          <b>{a.label}</b> {a.name && <span className="muted">({a.name})</span>}
          <div className="sub">{methodLabel(a)} · {repos} repo(s) · added {ago(a.createdAt)}</div>
        </div>
      </div>
      <div className="meta-grid">
        <span>Login</span><span>{a.login || <span className="warn-text">unknown, run Test SSH</span>}</span>
        <span>Token</span><span>{a.hasToken ? <>stored (encrypted){a.tokenScopes && <span className="sub"> · scopes: {a.tokenScopes}</span>}</> : <span className="muted">none, so no PRs/issues/Actions</span>}</span>
        {a.orgs.length > 0 && <><span>Orgs</span><span>{a.orgs.join(', ')}</span></>}
        {a.sshFingerprint && <><span>SSH key</span><span><code>{a.sshFingerprint}</code>{a.githubKeyId ? <span className="ok-text"> · on GitHub (id {a.githubKeyId})</span> : <span className="muted"> · added manually</span>}</span></>}
      </div>
      {showKey && a.sshPublicKey && <PublicKey value={a.sshPublicKey} />}
      {tokenEdit !== null && (
        <div className="row">
          <input className="grow" type="password" placeholder="New token (empty = remove)" value={tokenEdit} onChange={(e) => setTokenEdit(e.target.value)} />
          <button className="primary" onClick={async () => {
            if (a.authMethod !== 'ssh-manual' && !tokenEdit.trim()) return toast('This sign-in method needs a token', 'err')
            if ((await act(() => api.updateAccount(a.id, { token: tokenEdit }), 'Token saved')) !== undefined) setTokenEdit(null)
            await reload()
          }}>Save</button>
          <button onClick={() => setTokenEdit(null)}>Cancel</button>
        </div>
      )}
      <div className="row wrap">
        {a.sshKeyPath && <button onClick={test}>Test SSH</button>}
        {a.sshPublicKey && <button onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'} public key</button>}
        {a.authMethod === 'ssh-manual' && a.hasToken && !a.githubKeyId && (
          <button onClick={async () => (await act(() => api.uploadSshKey(a.id), 'Key uploaded to GitHub'), reload())}>Upload key to GitHub</button>
        )}
        <button onClick={() => setTokenEdit('')}>{a.hasToken ? 'Replace token' : 'Add token'}</button>
        {a.hasToken && <button onClick={async () => (await act(() => api.refreshAccount(a.id), 'Profile refreshed'), reload())}>Refresh profile</button>}
        <span className="grow" />
        <button className="danger" onClick={remove}>Remove</button>
      </div>
    </div>
  )
}

function AddAccount({ onClose, onAdded }: { onClose: () => void; onAdded: (a: Account) => void }) {
  const { act, reload, busy } = useApp()
  const [f, setF] = useState({ label: '', authMethod: 'ssh-auto' as AuthMethod, token: '', login: '', keySource: 'generate' as 'generate' | 'import', importPath: '' })
  const needsToken = f.authMethod !== 'ssh-manual'
  const usesSsh = f.authMethod !== 'token'

  const submit = async () => {
    const a = await act(() => api.addAccount(f), 'Account added')
    if (a) {
      await reload()
      onAdded(a)
    }
  }

  return (
    <Modal title="Add GitHub account" onClose={onClose} wide>
      <label>Name in RepoDock<input autoFocus placeholder="e.g. Work, Personal, Client X" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
      <div className="method-list">
        {METHODS.map((m) => (
          <label key={m.id} className={`method ${f.authMethod === m.id ? 'sel' : ''}`}>
            <input type="radio" checked={f.authMethod === m.id} onChange={() => setF({ ...f, authMethod: m.id })} />
            <div><b>{m.title}</b><div className="sub">{m.desc}</div></div>
          </label>
        ))}
      </div>
      <label>
        Personal access token {needsToken ? '(required)' : '(optional)'}
        <input type="password" placeholder="ghp_… or github_pat_…" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
      </label>
      <p className="hint">
        Sign in to GitHub <b>as this account</b>, then <a onClick={() => api.openExternal(TOKEN_URL)}>create a classic token with the right scopes ↗</a>
        {' '}(repo, workflow, read:org, plus admin:public_key for automatic SSH and delete_repo if you want to delete repos from here). It is encrypted with Windows DPAPI and never leaves this PC except to call GitHub.
      </p>
      {usesSsh && (
        <div className="row">
          <label className="check"><input type="radio" checked={f.keySource === 'generate'} onChange={() => setF({ ...f, keySource: 'generate' })} /> Generate a new ed25519 key</label>
          <label className="check"><input type="radio" checked={f.keySource === 'import'} onChange={() => setF({ ...f, keySource: 'import' })} /> Import an existing key</label>
          {f.keySource === 'import' && <>
            <input className="grow" readOnly value={f.importPath} placeholder="No key chosen" />
            <button onClick={async () => { const p = await api.pickKeyFile(); if (p) setF({ ...f, importPath: p }) }}>Browse…</button>
          </>}
        </div>
      )}
      {f.authMethod === 'ssh-manual' && !f.token && (
        <label>GitHub username (optional, detected by “Test SSH” later)<input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} /></label>
      )}
      <div className="row end">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || (needsToken && !f.token.trim()) || (usesSsh && f.keySource === 'import' && !f.importPath)} onClick={submit}>
          {busy ? 'Working…' : 'Add account'}
        </button>
      </div>
    </Modal>
  )
}
