import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { Channel } from '../types'
import * as api from '../services/api'
import ChannelSettings from './ChannelSettings'

export interface VoicePresenceUser {
  id: string
  displayName: string
}

interface Props {
  channels: Channel[]
  selected: Channel | null
  onSelect: (channel: Channel) => void
  voicePresence?: Map<string, VoicePresenceUser[]>
  isAdmin?: boolean
  serverId?: string
  onChannelsChanged?: () => void
}

export default function ChannelList({ channels, selected, onSelect, voicePresence, isAdmin, serverId, onChannelsChanged }: Props) {
  const textChannels = channels.filter((c) => c.type === 'text')
  const voiceChannels = channels.filter((c) => c.type === 'voice')
  const [settingsChannel, setSettingsChannel] = useState<Channel | null>(null)
  const [creatingType, setCreatingType] = useState<'text' | 'voice' | null>(null)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const handleCreateStart = (type: 'text' | 'voice') => {
    setCreatingType(type)
    setCreateName('')
    setCreateDescription('')
  }

  const handleCreateSubmit = async () => {
    if (!serverId || !creatingType || !createName.trim()) return
    await api.createChannel(serverId, createName.trim(), creatingType, createDescription.trim())
    setCreatingType(null)
    setCreateName('')
    setCreateDescription('')
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
          className={`channel-item ${selected?.id === ch.id ? 'active' : ''}`}
          onClick={() => onSelect(ch)}
        >
          <span className="channel-hash">{ch.type === 'voice' ? '🔊' : '#'}</span> {ch.name}
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
                      <div key={u.id} className="voice-channel-user">
                        <span className="voice-channel-user-dot" />
                        <span className="voice-channel-user-name">{u.displayName}</span>
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
    </div>
  )
}
