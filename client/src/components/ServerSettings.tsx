import { useEffect, useState } from 'react'
import type { Server, ServerInvite } from '../types'
import * as api from '../services/api'
import { useAuth } from '../context/AuthContext'

interface Props {
  server: Server
  onClose: () => void
  onServerUpdated: (server: Server) => void
  onServerDeleted: (serverId: string) => void
  onServerLeft: (serverId: string) => void
}

export default function ServerSettings({ server, onClose, onServerUpdated, onServerDeleted, onServerLeft }: Props) {
  const { user } = useAuth()
  const [name, setName] = useState(server.name)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [invites, setInvites] = useState<ServerInvite[]>([])
  const [copiedCode, setCopiedCode] = useState('')
  const [tab, setTab] = useState<'general' | 'invites' | 'danger'>('general')
  const [closing, setClosing] = useState(false)
  const isOwner = user?.id === server.owner_id

  useEffect(() => {
    api.getInvites(server.id).then(setInvites).catch(() => setInvites([]))
  }, [server.id])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedCode(text)
      setTimeout(() => setCopiedCode(''), 2000)
    }).catch(() => {
      const el = document.createElement('textarea')
      el.value = text
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopiedCode(text)
      setTimeout(() => setCopiedCode(''), 2000)
    })
  }

  const handleCreateInvite = async () => {
    try {
      const invite = await api.createInvite(server.id)
      setInvites((prev) => [invite, ...prev])
      copyToClipboard(invite.code)
    } catch (e) {
      console.error('Failed to create invite:', e)
    }
  }

  const handleDeleteInvite = async (id: string) => {
    try {
      await api.deleteInvite(id)
      setInvites((prev) => prev.filter((i) => i.id !== id))
    } catch (e) {
      console.error('Failed to delete invite:', e)
    }
  }

  const handleSave = async () => {
    if (!name.trim() || name === server.name) return
    setSaving(true)
    try {
      const updated = await api.updateServer(server.id, { name: name.trim() })
      onServerUpdated(updated)
    } catch (err) {
      console.error('Failed to update server:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    try {
      await api.deleteServer(server.id)
      onServerDeleted(server.id)
    } catch (err) {
      console.error('Failed to delete server:', err)
    }
  }

  const handleLeave = async () => {
    try {
      await api.leaveServer(server.id)
      onServerLeft(server.id)
    } catch (err) {
      console.error('Failed to leave server:', err)
    }
  }

  const handleClose = () => {
    setClosing(true)
    setTimeout(onClose, 200)
  }

  return (
    <div className={`settings-overlay ${closing ? 'closing' : ''}`} onClick={handleClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-sidebar">
          <h3 className="settings-sidebar-title">{server.name}</h3>
          <nav className="settings-nav">
            <button className={`settings-nav-item ${tab === 'general' ? 'active' : ''}`} onClick={() => setTab('general')}>
              General
            </button>
            <button className={`settings-nav-item ${tab === 'invites' ? 'active' : ''}`} onClick={() => setTab('invites')}>
              Invites
            </button>
            <button className={`settings-nav-item ${tab === 'danger' ? 'active' : ''}`} onClick={() => setTab('danger')}>
              {isOwner ? 'Danger Zone' : 'Leave'}
            </button>
          </nav>
        </div>
        <div className="settings-content">
          <div className="settings-content-header">
            <h2>{tab === 'general' ? 'General' : tab === 'invites' ? 'Invites' : isOwner ? 'Danger Zone' : 'Leave Server'}</h2>
            <button className="close-btn" onClick={handleClose}>×</button>
          </div>

          {tab === 'general' && (
            <div className="settings-body">
              <h3 className="settings-section">Server Name</h3>
              {isOwner ? (
                <div className="server-name-edit">
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Server name"
                  />
                  <button
                    className="save-btn"
                    onClick={handleSave}
                    disabled={saving || !name.trim() || name === server.name}
                  >
                    {saving ? '...' : 'Save'}
                  </button>
                </div>
              ) : (
                <p className="settings-value">{server.name}</p>
              )}

              <h3 className="settings-section">Owner</h3>
              <p className="settings-value">{isOwner ? 'You' : server.owner_id.slice(0, 8)}</p>
            </div>
          )}

          {tab === 'invites' && (
            <div className="settings-body">
              <button className="create-invite-btn" onClick={handleCreateInvite}>Generate Invite Code</button>
              {invites.length > 0 && (
                <div className="invite-list">
                  {invites.map((inv) => (
                    <div key={inv.id} className="invite-item">
                      <code
                        className="invite-code clickable"
                        onClick={() => copyToClipboard(inv.code)}
                        title="Click to copy"
                      >
                        {inv.code}
                      </code>
                      <span className="invite-uses">
                        {inv.uses}{inv.max_uses > 0 ? `/${inv.max_uses}` : ''} uses
                      </span>
                      <span className="invite-copied-indicator">
                        {copiedCode === inv.code ? '✓ Copied!' : ''}
                      </span>
                      <button className="invite-delete" onClick={() => handleDeleteInvite(inv.id)} title="Delete invite">
                        🗑
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {invites.length === 0 && <p className="settings-hint">No invites yet. Create one to share with friends.</p>}
            </div>
          )}

          {tab === 'danger' && (
            <div className="settings-body">
              {isOwner ? (
                <div className="settings-actions">
                  <p className="settings-hint">Deleting a server is permanent and cannot be undone. All channels, messages, and member data will be lost.</p>
                  {!confirmDelete ? (
                    <button className="danger-btn" onClick={() => setConfirmDelete(true)}>
                      Delete Server
                    </button>
                  ) : (
                    <div className="confirm-row">
                      <span>Are you sure? This cannot be undone.</span>
                      <button className="danger-btn" onClick={handleDelete}>Yes, Delete</button>
                      <button className="cancel-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="settings-actions">
                  <p className="settings-hint">You will lose access to all channels in this server.</p>
                  <button className="danger-btn" onClick={handleLeave}>
                    Leave Server
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
