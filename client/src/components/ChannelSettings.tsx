import { useEffect, useState } from 'react'
import type { Channel } from '../types'
import * as api from '../services/api'
import * as e2e from '../services/e2e'

interface Props {
  channel: Channel
  onClose: () => void
  onChannelUpdated: () => void
  onChannelDeleted: () => void
}

function randomCode(): string {
  const chars = 'ABCDEFGHJKLMNPRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

export default function ChannelSettings({ channel, onClose, onChannelUpdated, onChannelDeleted }: Props) {
  const [name, setName] = useState(channel.name)
  const [saving, setSaving] = useState(false)

  // Encryption
  const [encrypted, setEncrypted] = useState(false)
  const [showEncryptConfirm, setShowEncryptConfirm] = useState(false)
  const [encryptCode, setEncryptCode] = useState('')
  const [encryptInput, setEncryptInput] = useState('')
  const [encrypting, setEncrypting] = useState(false)

  // Delete
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteInput, setDeleteInput] = useState('')

  useEffect(() => {
    e2e.isChannelEncrypted(channel.id).then(setEncrypted).catch(() => setEncrypted(false))
  }, [channel.id])

  const handleSaveName = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === channel.name) return
    setSaving(true)
    try {
      await api.updateChannel(channel.id, trimmed)
      onChannelUpdated()
    } catch (err) {
      console.error('Failed to rename channel:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleStartEncrypt = () => {
    const code = randomCode()
    setEncryptCode(code)
    setEncryptInput('')
    setShowEncryptConfirm(true)
  }

  const handleConfirmEncrypt = async () => {
    if (encryptInput !== encryptCode) return
    setEncrypting(true)
    try {
      const ok = await e2e.enableEncryption(channel.id, channel.server_id || undefined)
      if (ok) {
        setEncrypted(true)
        setShowEncryptConfirm(false)
      }
    } catch (err) {
      console.error('Failed to enable encryption:', err)
    } finally {
      setEncrypting(false)
    }
  }

  const handleDelete = async () => {
    if (deleteInput !== channel.name) return
    try {
      await api.deleteChannel(channel.id)
      onChannelDeleted()
    } catch (err) {
      console.error('Failed to delete channel:', err)
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Channel Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-body">
          {/* Channel Name */}
          <h3 className="settings-section">Channel Name</h3>
          <div className="server-name-edit">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Channel name"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName() }}
            />
            <button
              className="save-btn"
              onClick={handleSaveName}
              disabled={saving || !name.trim() || name.trim() === channel.name}
            >
              {saving ? '...' : 'Save'}
            </button>
          </div>

          {/* Encryption */}
          <h3 className="settings-section">Encryption</h3>
          {encrypted ? (
            <div className="ch-settings-encrypted">
              <span className="ch-settings-lock">🔒</span>
              <div>
                <div className="ch-settings-enc-status">End-to-end encrypted</div>
                <div className="ch-settings-enc-note">Messages in this channel are encrypted. Only members with keys can read them.</div>
              </div>
            </div>
          ) : !showEncryptConfirm ? (
            <div className="ch-settings-encrypt-section">
              <p className="ch-settings-enc-desc">
                Enable end-to-end encryption for this channel. All future messages will be encrypted so only channel members can read them.
              </p>
              <p className="ch-settings-enc-warn">
                ⚠️ This action is permanent and cannot be reversed.
              </p>
              <button className="danger-btn" onClick={handleStartEncrypt}>
                Enable Encryption
              </button>
            </div>
          ) : (
            <div className="ch-settings-encrypt-confirm">
              <p className="ch-settings-enc-desc">
                You are about to permanently enable end-to-end encryption on <strong>#{channel.name}</strong>. This cannot be undone.
              </p>
              <p className="ch-settings-enc-desc">
                Type the code below to confirm:
              </p>
              <div className="ch-settings-confirm-code">{encryptCode}</div>
              <input
                type="text"
                className="ch-settings-confirm-input"
                value={encryptInput}
                onChange={(e) => setEncryptInput(e.target.value.toUpperCase())}
                placeholder="Type the code above"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmEncrypt() }}
              />
              <div className="ch-settings-confirm-actions">
                <button
                  className="danger-btn"
                  onClick={handleConfirmEncrypt}
                  disabled={encrypting || encryptInput !== encryptCode}
                >
                  {encrypting ? 'Encrypting...' : 'Confirm Encryption'}
                </button>
                <button className="cancel-btn" onClick={() => setShowEncryptConfirm(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Danger Zone */}
          <div className="settings-actions">
            <h3 className="settings-section">Danger Zone</h3>
            {!showDeleteConfirm ? (
              <button className="danger-btn" onClick={() => { setShowDeleteConfirm(true); setDeleteInput('') }}>
                Delete Channel
              </button>
            ) : (
              <div className="ch-settings-delete-confirm">
                <p className="ch-settings-enc-desc">
                  Type <strong>{channel.name}</strong> to confirm deletion. This cannot be undone.
                </p>
                <input
                  type="text"
                  className="ch-settings-confirm-input"
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                  placeholder={`Type ${channel.name}`}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') handleDelete() }}
                />
                <div className="ch-settings-confirm-actions">
                  <button
                    className="danger-btn"
                    onClick={handleDelete}
                    disabled={deleteInput !== channel.name}
                  >
                    Delete #{channel.name}
                  </button>
                  <button className="cancel-btn" onClick={() => setShowDeleteConfirm(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
