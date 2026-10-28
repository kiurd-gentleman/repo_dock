import { useState } from 'react'
import type { Group, Repo } from '../../../shared/types'
import { api } from '../api'
import type { View } from '../App'
import { GROUP_COLORS, Modal, useApp } from './ui'
import logo from '../assets/logo.svg'

export function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const { state, summaries, act, reload, refreshSummaries, toast } = useApp()
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [editGroup, setEditGroup] = useState<Group | 'new' | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  const match = (r: Repo) => {
    const s = summaries[r.id]
    const q = filter.toLowerCase()
    return !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q) || (s?.owner ?? '').toLowerCase().includes(q)
  }

  const sections: { id: string | null; name: string; color?: string; group?: Group }[] = [
    ...state.groups.map((g) => ({ id: g.id, name: g.name, color: g.color, group: g })),
    { id: null, name: 'Ungrouped' }
  ]

  const addRepo = async () => {
    const r = await act(() => api.addRepo())
    if (r) {
      await reload()
      await refreshSummaries([r.id])
      setView({ kind: 'repo', id: r.id })
    }
  }

  const importFolder = async () => {
    const r = await act(() => api.importFolder(null))
    if (r) {
      toast(`Found ${r.found} repositories, added ${r.added} new`)
      await reload()
      await refreshSummaries()
    }
  }

  const drop = async (groupId: string | null, e: React.DragEvent) => {
    setDragOver(null)
    const id = e.dataTransfer.getData('repo-id')
    if (!id) return
    await act(() => api.setRepoGroup([id], groupId))
    await reload()
  }

  return (
    <aside className="sidebar">
      <div className="brand"><img src={logo} alt="" width={26} height={26} /> RepoDock</div>
      <nav className="nav">
        <button className={view.kind === 'dashboard' ? 'active' : ''} onClick={() => setView({ kind: 'dashboard' })}>▦ Overview</button>
        <button className={view.kind === 'accounts' ? 'active' : ''} onClick={() => setView({ kind: 'accounts' })}>⚿ Accounts <span className="count">{state.accounts.length}</span></button>
        <button className={view.kind === 'github' ? 'active' : ''} onClick={() => setView({ kind: 'github' })}>☁ GitHub repos</button>
      </nav>
      <div className="side-actions">
        <button onClick={addRepo}>+ Add repo</button>
        <button onClick={importFolder}>⤓ Import folder</button>
        <button onClick={() => setEditGroup('new')} title="New group">+ Group</button>
      </div>
      <input className="search" placeholder="Filter repos…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="repo-list">
        {sections.map((sec) => {
          const repos = state.repos.filter((r) => r.groupId === sec.id && match(r)).sort((a, b) => a.name.localeCompare(b.name))
          if (sec.id === null && !repos.length && state.repos.length) return null
          const key = sec.id ?? '__none'
          return (
            <div
              key={key}
              className={`group ${dragOver === key ? 'drag-over' : ''}`}
              onDragOver={(e) => (e.preventDefault(), setDragOver(key))}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => drop(sec.id, e)}
            >
              <div className="group-head" onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}>
                <span className="caret">{collapsed[key] ? '▸' : '▾'}</span>
                {sec.color && <span className="dot" style={{ background: sec.color }} />}
                <span className="group-name">{sec.name}</span>
                <span className="count">{repos.length}</span>
                {sec.group && <button className="icon small" onClick={(e) => (e.stopPropagation(), setEditGroup(sec.group!))} title="Edit group">✎</button>}
              </div>
              {!collapsed[key] && repos.map((r) => {
                const s = summaries[r.id]
                const changes = s ? s.staged + s.unstaged + s.untracked + s.conflicted : 0
                return (
                  <div
                    key={r.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('repo-id', r.id)}
                    className={`repo-item ${view.kind === 'repo' && view.id === r.id ? 'active' : ''}`}
                    onClick={() => setView({ kind: 'repo', id: r.id })}
                    title={r.path}
                  >
                    <span className="repo-name">{r.name}</span>
                    <span className="repo-meta">
                      {s?.error && <span className="pill err" title={s.error}>!</span>}
                      {changes > 0 && <span className="pill warn" title="Uncommitted changes">{changes}</span>}
                      {!!s?.ahead && <span className="pill" title="Commits to push">↑{s.ahead}</span>}
                      {!!s?.behind && <span className="pill" title="Commits to pull">↓{s.behind}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        })}
        {!state.repos.length && <div className="empty small">No repos yet. Add one or import a folder.</div>}
      </div>
      {editGroup && <GroupModal group={editGroup === 'new' ? null : editGroup} onClose={() => setEditGroup(null)} />}
    </aside>
  )
}

export function GroupModal({ group, onClose, onCreated }: { group: Group | null; onClose: () => void; onCreated?: (g: Group) => Promise<void> }) {
  const { act, reload, state } = useApp()
  const [name, setName] = useState(group?.name ?? '')
  const [color, setColor] = useState(group?.color ?? GROUP_COLORS[state.groups.length % GROUP_COLORS.length])
  const save = async () => {
    if (!name.trim()) return
    if (group) await act(() => api.updateGroup(group.id, { name: name.trim(), color }))
    else {
      const g = await act(() => api.createGroup(name.trim(), color))
      if (g && onCreated) await onCreated(g)
    }
    await reload()
    onClose()
  }
  const del = async () => {
    if (!group || !confirm(`Delete group "${group.name}"? Its repos move to Ungrouped.`)) return
    await act(() => api.deleteGroup(group.id))
    await reload()
    onClose()
  }
  return (
    <Modal title={group ? 'Edit group' : 'New group'} onClose={onClose}>
      <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} /></label>
      <div className="colors">
        {GROUP_COLORS.map((c) => (
          <button key={c} className={`swatch ${c === color ? 'sel' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
        ))}
      </div>
      <p className="hint">Tip: drag repos in the sidebar onto a group.</p>
      <div className="row end">
        {group && <button className="danger" onClick={del}>Delete</button>}
        <span className="grow" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save}>Save</button>
      </div>
    </Modal>
  )
}
