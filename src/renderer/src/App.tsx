import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppState, RepoSummary } from '../../shared/types'
import { api } from './api'
import { AppCtx, type Ctx } from './components/ui'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './components/Dashboard'
import { RepoView } from './components/RepoView'
import { Accounts } from './components/Accounts'
import { GitHubRepos } from './components/GitHubRepos'
import { AlertHost, type AlertItem } from './components/Alert'

export type View = { kind: 'dashboard' } | { kind: 'repo'; id: string } | { kind: 'accounts' } | { kind: 'github' }

export function App() {
  const [state, setState] = useState<AppState>({ accounts: [], groups: [], repos: [] })
  const [summaries, setSummaries] = useState<Record<string, RepoSummary>>({})
  const [view, setView] = useState<View>({ kind: 'dashboard' })
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([])
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [busy, setBusy] = useState(false)

  // Successes are brief toasts; errors need reading, so they open a dialog that stays until dismissed.
  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random()
    if (kind === 'err') {
      setAlerts((a) => (a.some((x) => x.message === msg) ? a : [...a, { id, message: msg }]))
      return
    }
    setToasts((t) => [...t, { id, msg }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500)
  }, [])
  const dismissAlert = useCallback((id: number) => setAlerts((a) => a.filter((x) => x.id !== id)), [])

  const refreshSummaries = useCallback(async (ids?: string[]) => {
    const list = await api.summaries(ids)
    setSummaries((s) => {
      const next = ids ? { ...s } : {}
      for (const x of list) next[x.id] = x
      return next
    })
  }, [])

  const reload = useCallback(async () => {
    setState(await api.state())
  }, [])

  const act = useCallback(async <T,>(fn: () => Promise<T>, okMsg?: string) => {
    setBusy(true)
    try {
      const r = await fn()
      if (okMsg) toast(okMsg)
      return r
    } catch (e) {
      toast((e as Error).message, 'err')
      return undefined
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    reload().then(() => refreshSummaries())
    // Keep the sidebar's change counts fresh when coming back to the app.
    const onFocus = () => refreshSummaries()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload, refreshSummaries])

  const ctx: Ctx = useMemo(() => ({
    state, summaries, reload, refreshSummaries, toast, act, busy,
    accountById: (id) => state.accounts.find((a) => a.id === id),
    groupById: (id) => state.groups.find((g) => g.id === id)
  }), [state, summaries, reload, refreshSummaries, toast, act, busy])

  const current = view.kind === 'repo' ? state.repos.find((r) => r.id === view.id) : undefined

  return (
    <AppCtx.Provider value={ctx}>
      <div className="layout">
        <Sidebar view={view} setView={setView} />
        <main className="main">
          {view.kind === 'dashboard' && <Dashboard open={(id) => setView({ kind: 'repo', id })} />}
          {view.kind === 'repo' && current && <RepoView key={current.id} repo={current} onRemoved={() => setView({ kind: 'dashboard' })} />}
          {view.kind === 'repo' && !current && <div className="empty">Repository not found</div>}
          {view.kind === 'accounts' && <Accounts />}
          {view.kind === 'github' && <GitHubRepos />}
        </main>
      </div>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>{t.msg}</div>
        ))}
      </div>
      <AlertHost items={alerts} dismiss={dismissAlert} />
    </AppCtx.Provider>
  )
}
