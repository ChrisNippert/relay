import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Channel } from '../types'
import * as api from '../services/api'
import * as e2e from '../services/e2e'
import { useAuth } from '../context/AuthContext'
import ChannelSettings from './ChannelSettings'

export interface VoicePresenceUser {
  id: string
  displayName: string
  speaking?: boolean
  muted?: boolean
  deafened?: boolean
  videoOn?: boolean
  screenSharing?: boolean
}

interface Props {
  channels: Channel[]
  selected: Channel | null
  onSelect: (channel: Channel) => void
  voicePresence?: Map<string, VoicePresenceUser[]>
  isAdmin?: boolean
  serverId?: string
  onChannelsChanged?: () => void
  unreadChannels?: Record<string, { count: number; mentioned: boolean }>
  onVoiceUserVolumeChange?: (userId: string, volume: number) => void
  getVoiceUserVolume?: (userId: string) => number
  onVoiceKick?: (channelId: string, userId: string) => void
}

export default function ChannelList({ channels, selected, onSelect, voicePresence, isAdmin, serverId, onChannelsChanged, unreadChannels, onVoiceUserVolumeChange, getVoiceUserVolume, onVoiceKick }: Props) {
  const { user: me } = useAuth()
  const textChannels = channels.filter((c) => c.type === 'text')
  const voiceChannels = channels.filter((c) => c.type === 'voice')
  const [settingsChannel, setSettingsChannel] = useState<Channel | null>(null)
  const [creatingType, setCreatingType] = useState<'text' | 'voice' | null>(null)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createEncrypted, setCreateEncrypted] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [voiceCtxMenu, setVoiceCtxMenu] = useState<{ x: number; y: number; userId: string; displayName: string; channelId: string } | null>(null)
  const [voiceCtxVolume, setVoiceCtxVolume] = useState(100)
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const handleCreateStart = (type: 'text' | 'voice') => {
    setCreatingType(type)
    setCreateName('')
    setCreateDescription('')
    setCreateEncrypted(false)
  }

  const handleCreateSubmit = async () => {
    if (!serverId || !creatingType || !createName.trim()) return
    const channel = await api.createChannel(serverId, createName.trim(), creatingType, createDescription.trim())
    if (createEncrypted && channel?.id) {
      await e2e.enableEncryption(channel.id)
      window.dispatchEvent(new CustomEvent('channel-encryption-enabled', { detail: { channelId: channel.id } }))
    }
    setCreatingType(null)
    setCreateName('')
    setCreateDescription('')
    setCreateEncrypted(false)
    onChannelsChanged?.()
  }

  const handleCreateCancel = () => {
    setCreatingType(null)
    setCreateName('')
    setCreateDescription('')
  }

  const handleDrop = async (targetCh: Channel) => {
    if (!serverId || !dragId || dragId === targetCh.id) {
      setDragId(null)
      setDragOverId(null)
      return
    }
    const dragCh = channels.find((c) => c.id === dragId)
    if (!dragCh || dragCh.type !== targetCh.type) {
      setDragId(null)
      setDragOverId(null)
      return
    }
    const group = channels.filter((c) => c.type === dragCh.type).sort((a, b) => a.position - b.position)
    const fromIdx = group.findIndex((c) => c.id === dragId)
    const toIdx = group.findIndex((c) => c.id === targetCh.id)
    if (fromIdx === -1 || toIdx === -1) return
    const reordered = [...group]
    reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, dragCh)
    const positions: Record<string, number> = {}
    reordered.forEach((c, i) => { positions[c.id] = i })
    setDragId(null)
    setDragOverId(null)
    await api.updateChannelPositions(serverId, positions)
    onChannelsChanged?.()
  }

  const renderChannelItem = (ch: Channel) => {
    return (
      <div
        key={ch.id}
        className={`channel-item-row ${dragOverId === ch.id ? 'drag-over' : ''}`}
        draggable={!!isAdmin}
        onDragStart={(e) => { setDragId(ch.id); e.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => { setDragId(null); setDragOverId(null) }}
        onDragOver={(e) => { e.preventDefault(); setDragOverId(ch.id) }}
        onDragLeave={() => setDragOverId(null)}
        onDrop={(e) => { e.preventDefault(); handleDrop(ch) }}
      >
        <button
          className={`channel-item ${selected?.id === ch.id ? 'active' : ''}${unreadChannels?.[ch.id] ? ' unread' : ''}${unreadChannels?.[ch.id]?.mentioned ? ' has-mention' : ''}`}
          onClick={() => onSelect(ch)}
        >
          <span className="channel-hash">{ch.type === 'voice' ? '🔊' : '#'}</span> {ch.name}
          {unreadChannels?.[ch.id] && (
            <span className={`channel-unread-badge${unreadChannels?.[ch.id]?.mentioned ? ' mention' : ''}`}>
              {unreadChannels?.[ch.id]?.mentioned ? '@' : unreadChannels?.[ch.id]?.count}
            </span>
          )}
        </button>
        {isAdmin && (
          <div className="channel-actions">
            <button className="channel-action-btn" onClick={() => setSettingsChannel(ch)} title="Settings">⚙️</button>
          </div>
        )}
      </div>
    )
  }

  const renderCreateModal = () => {
    if (!creatingType) return null
    return createPortal(
      <div className="settings-overlay" onClick={handleCreateCancel}>
        <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
          <div className="settings-header">
            <h2>Create {creatingType === 'text' ? 'Text' : 'Voice'} Channel</h2>
            <button className="close-btn" onClick={handleCreateCancel}>×</button>
          </div>
          <div className="settings-body">
            <h3 className="settings-section">Channel Name</h3>
            <div className="server-name-edit">
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={`Enter ${creatingType} channel name`}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateSubmit()
                  if (e.key === 'Escape') handleCreateCancel()
                }}
              />
            </div>
            <h3 className="settings-section">Description (optional)</h3>
            <div className="server-name-edit">
              <input
                type="text"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="What's this channel about?"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateSubmit()
                  if (e.key === 'Escape') handleCreateCancel()
                }}
              />
            </div>
            {creatingType === 'text' && (
              <>
                <h3 className="settings-section">Encryption</h3>
                <label className="ch-settings-encrypt-toggle">
                  <input
                    type="checkbox"
                    checked={createEncrypted}
                    onChange={(e) => setCreateEncrypted(e.target.checked)}
                  />
                  <span>Enable end-to-end encryption</span>
                </label>
                {createEncrypted && (
                  <p className="ch-settings-enc-warn" style={{ marginTop: 4 }}>
                    ⚠️ Encryption is permanent and cannot be disabled later.
                  </p>
                )}
              </>
            )}
          </div>
          <div className="settings-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button className="danger-btn" style={{ background: 'var(--bg-tertiary)' }} onClick={handleCreateCancel}>Cancel</button>
            <button className="save-btn" onClick={handleCreateSubmit} disabled={!createName.trim()}>Create</button>
          </div>
        </div>
      </div>,
      document.body
    )
  }

  return (
    <div className="channel-list">
      {(textChannels.length > 0 || isAdmin) && (
        <>
          <div className="channel-category-row">
            <h3 className="channel-category">Text Channels</h3>
            {isAdmin && <button className="channel-add-btn" onClick={() => handleCreateStart('text')} title="Create Text Channel">+</button>}
          </div>
          {textChannels.map((ch) => renderChannelItem(ch))}
        </>
      )}

      {(voiceChannels.length > 0 || isAdmin) && (
        <>
          <div className="channel-category-row">
            <h3 className="channel-category">Voice Channels</h3>
            {isAdmin && <button className="channel-add-btn" onClick={() => handleCreateStart('voice')} title="Create Voice Channel">+</button>}
          </div>
          {voiceChannels.map((ch) => {
            const users = voicePresence?.get(ch.id) ?? []
            return (
              <div key={ch.id} className="voice-channel-group">
                {renderChannelItem(ch)}
                {users.length > 0 && (
                  <div className="voice-channel-users">
                    {users.map((u) => (
                      <div key={u.id} className="voice-channel-user" onContextMenu={(e) => {
                        if (u.id === me?.id) return
                        e.preventDefault()
                        setVoiceCtxVolume(getVoiceUserVolume?.(u.id) ?? 100)
                        setVoiceCtxMenu({ x: e.clientX, y: e.clientY, userId: u.id, displayName: u.displayName, channelId: ch.id })
                      }}
                      onTouchStart={(e) => {
                        if (u.id === me?.id) return
                        const touch = e.touches[0]
                        if (!touch) return
                        const x = touch.clientX, y = touch.clientY
                        longPressTimer.current = setTimeout(() => {
                          setVoiceCtxVolume(getVoiceUserVolume?.(u.id) ?? 100)
                          setVoiceCtxMenu({ x, y, userId: u.id, displayName: u.displayName, channelId: ch.id })
                        }, 500)
                      }}
                      onTouchEnd={() => clearTimeout(longPressTimer.current)}
                      onTouchMove={() => clearTimeout(longPressTimer.current)}
                      >
                        <span className={`voice-channel-user-dot ${u.speaking ? 'speaking' : ''}`} />
                        <span className="voice-channel-user-name">{u.displayName}</span>
                        <span className="voice-channel-user-icons">
                          {u.muted && <span title="Muted">🔇</span>}
                          {u.deafened && <span title="Deafened">🔈</span>}
                          {u.videoOn && <span title="Camera">📷</span>}
                          {u.screenSharing && <span title="Screenshare">🖥️</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}

      {renderCreateModal()}

      {settingsChannel && createPortal(
        <ChannelSettings
          channel={settingsChannel}
          onClose={() => setSettingsChannel(null)}
          onChannelUpdated={() => { setSettingsChannel(null); onChannelsChanged?.() }}
          onChannelDeleted={() => { setSettingsChannel(null); onChannelsChanged?.() }}
        />,
        document.body
      )}

      {voiceCtxMenu && createPortal(
        <div className="voice-context-menu-overlay" onClick={() => setVoiceCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setVoiceCtxMenu(null) }}>
          <div className="voice-context-menu" style={{ left: Math.min(voiceCtxMenu.x, window.innerWidth - 220), top: Math.min(voiceCtxMenu.y, window.innerHeight - 120) }} onClick={(e) => e.stopPropagation()}>
            <div className="voice-context-menu-header">{voiceCtxMenu.displayName}</div>
            <div className="voice-context-menu-item volume-control">
              <label>
                <span>Volume</span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={voiceCtxVolume}
                  onChange={(e) => {
                    const vol = Number(e.target.value)
                    setVoiceCtxVolume(vol)
                    onVoiceUserVolumeChange?.(voiceCtxMenu.userId, vol)
                  }}
                />
                <span className="volume-value">{voiceCtxVolume}%</span>
              </label>
            </div>
            {isAdmin && (
              <button className="voice-context-menu-item kick" onClick={() => {
                onVoiceKick?.(voiceCtxMenu.channelId, voiceCtxMenu.userId)
                setVoiceCtxMenu(null)
              }}>
                Kick from Voice
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
