import { useState, useRef } from 'react'
import type { Server, Channel } from '../types'

interface DMEntry {
  channel: Channel
  name: string
  unread: number
  mentioned: boolean
}

interface Props {
  servers: Server[]
  selected: Server | null
  onSelect: (server: Server) => void
  onDMs: () => void
  onCreate: (name: string) => void
  isDMView: boolean
  onJoinByCode: (code: string) => void
  unreadDMs?: DMEntry[]
  onSelectDM?: (channel: Channel) => void
  serverUnreads?: Record<string, { count: number; mentioned: boolean }>
  onReorder?: (serverIds: string[]) => void
  width?: number
  mobileOpen?: boolean
}

export type { DMEntry }

export default function ServerList({ servers, selected, onSelect, onDMs, onCreate, isDMView, onJoinByCode, unreadDMs, onSelectDM, serverUnreads, onReorder, width, mobileOpen }: Props) {
  const [showModal, setShowModal] = useState<'create' | 'join' | null>(null)
  const [serverName, setServerName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const dragIdxRef = useRef<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  const handleCreate = () => {
    const name = serverName.trim()
    if (!name) return
    onCreate(name)
    setServerName('')
    setShowModal(null)
  }

  const handleJoin = () => {
    const code = joinCode.trim()
    if (!code) return
    onJoinByCode(code)
    setJoinCode('')
    setShowModal(null)
  }

  return (
    <div className={`server-list${mobileOpen ? ' mobile-open' : ''}`} style={width ? { width } : undefined}>
      <button
        className={`server-nav-item dm-btn ${isDMView ? 'active' : ''}`}
        onClick={onDMs}
        title="Direct Messages"
      >
        <span className="server-nav-label">DMs</span>
      </button>

      {unreadDMs && unreadDMs.length > 0 && (
        <>
          {unreadDMs.map((dm) => (
            <button
              key={dm.channel.id}
              className="server-nav-item dm-unread-item"
              onClick={() => onSelectDM?.(dm.channel)}
              title={dm.name}
            >
              <span className="server-nav-label">{dm.name}</span>
              <span className={`server-nav-badge ${dm.mentioned ? 'mentioned' : ''}`}>{dm.unread}</span>
            </button>
          ))}
        </>
      )}

      <div className="server-divider" />

      {servers.map((s, idx) => {
        const unreads = serverUnreads?.[s.id]
        return (
          <button
            key={s.id}
            className={`server-nav-item ${selected?.id === s.id ? 'active' : ''} ${dragOverIdx === idx ? 'drag-over' : ''}`}
            onClick={() => onSelect(s)}
            title={s.name}
            draggable
            onDragStart={(e) => {
              dragIdxRef.current = idx
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDragOverIdx(idx)
            }}
            onDragLeave={() => setDragOverIdx(null)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOverIdx(null)
              const from = dragIdxRef.current
              if (from === null || from === idx) return
              const reordered = [...servers]
              const [moved] = reordered.splice(from, 1)
              reordered.splice(idx, 0, moved!)
              onReorder?.(reordered.map((srv) => srv.id))
              dragIdxRef.current = null
            }}
            onDragEnd={() => { dragIdxRef.current = null; setDragOverIdx(null) }}
          >
            <span className="server-nav-label">{s.name}</span>
            {unreads && unreads.count > 0 && (
              <span className={`server-nav-badge ${unreads.mentioned ? 'mentioned' : ''}`}>{unreads.count}</span>
            )}
          </button>
        )
      })}

      <button className="server-nav-item add" onClick={() => setShowModal('create')} title="Create or Join Server">
        +
      </button>

      {showModal && (
        <div className="server-modal-overlay" onClick={() => setShowModal(null)}>
          <div className="server-modal" onClick={(e) => e.stopPropagation()}>
            <div className="server-modal-header">
              <h3>{showModal === 'create' ? 'Create a Server' : 'Join a Server'}</h3>
              <button className="close-btn" onClick={() => setShowModal(null)}>×</button>
            </div>

            <div className="server-modal-tabs">
              <button
                className={`server-modal-tab ${showModal === 'create' ? 'active' : ''}`}
                onClick={() => setShowModal('create')}
              >
                Create
              </button>
              <button
                className={`server-modal-tab ${showModal === 'join' ? 'active' : ''}`}
                onClick={() => setShowModal('join')}
              >
                Join
              </button>
            </div>

            {showModal === 'create' ? (
              <div className="server-modal-body">
                <label className="server-modal-label">Server Name</label>
                <input
                  type="text"
                  className="server-modal-input"
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  placeholder="My Awesome Server"
                  autoFocus
                  maxLength={64}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
                <p className="server-modal-hint">Give your server a personality with a name. You can always change it later.</p>
                <button
                  className="server-modal-submit"
                  onClick={handleCreate}
                  disabled={!serverName.trim()}
                >
                  Create Server
                </button>
              </div>
            ) : (
              <div className="server-modal-body">
                <label className="server-modal-label">Invite Code</label>
                <input
                  type="text"
                  className="server-modal-input"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="Enter invite code"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                />
                <p className="server-modal-hint">Enter an invite code to join an existing server.</p>
                <button
                  className="server-modal-submit"
                  onClick={handleJoin}
                  disabled={!joinCode.trim()}
                >
                  Join Server
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
