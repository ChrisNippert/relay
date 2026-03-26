import { useState } from 'react'
import type { Server } from '../types'

interface Props {
  servers: Server[]
  selected: Server | null
  onSelect: (server: Server) => void
  onDMs: () => void
  onCreate: (name: string) => void
  isDMView: boolean
  onJoinByCode: (code: string) => void
}

export default function ServerList({ servers, selected, onSelect, onDMs, onCreate, isDMView, onJoinByCode }: Props) {
  const [showModal, setShowModal] = useState<'create' | 'join' | null>(null)
  const [serverName, setServerName] = useState('')
  const [joinCode, setJoinCode] = useState('')

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
    <div className="server-list">
      <button
        className={`server-icon ${isDMView ? 'active' : ''}`}
        onClick={onDMs}
        title="Direct Messages"
      >
        DM
      </button>

      <div className="server-divider" />

      {servers.map((s) => (
        <button
          key={s.id}
          className={`server-icon ${selected?.id === s.id ? 'active' : ''}`}
          onClick={() => onSelect(s)}
          title={s.name}
        >
          {s.icon_url ? (
            <img src={s.icon_url} alt="" className="server-icon-img" />
          ) : (
            s.name.charAt(0).toUpperCase()
          )}
        </button>
      ))}

      <button className="server-icon add" onClick={() => setShowModal('create')} title="Create or Join Server">
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
