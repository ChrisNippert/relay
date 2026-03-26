import { useState } from 'react'
import type { Channel } from '../types'
import * as api from '../services/api'

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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const handleCreate = async (type: 'text' | 'voice') => {
    if (!serverId) return
    const name = prompt(`New ${type} channel name:`)
    if (!name?.trim()) return
    await api.createChannel(serverId, name.trim(), type)
    onChannelsChanged?.()
  }

  const handleDelete = async (ch: Channel) => {
    if (!confirm(`Delete #${ch.name}?`)) return
    await api.deleteChannel(ch.id)
    onChannelsChanged?.()
  }

  const handleEditStart = (ch: Channel) => {
    setEditingId(ch.id)
    setEditName(ch.name)
  }

  const handleEditSave = async (ch: Channel) => {
    const name = editName.trim()
    if (!name || name === ch.name) { setEditingId(null); return }
    await api.updateChannel(ch.id, name)
    setEditingId(null)
    onChannelsChanged?.()
  }

  const handleMove = async (ch: Channel, dir: -1 | 1) => {
    if (!serverId) return
    const group = channels.filter((c) => c.type === ch.type).sort((a, b) => a.position - b.position)
    const idx = group.findIndex((c) => c.id === ch.id)
    const swapIdx = idx + dir
    if (swapIdx < 0 || swapIdx >= group.length) return
    const other = group[swapIdx]
    if (!other) return
    const positions: Record<string, number> = {
      [ch.id]: other.position,
      [other.id]: ch.position,
    }
    await api.updateChannelPositions(serverId, positions)
    onChannelsChanged?.()
  }

  const renderChannelItem = (ch: Channel) => {
    if (editingId === ch.id) {
      return (
        <div key={ch.id} className="channel-item editing">
          <input
            className="channel-edit-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleEditSave(ch); if (e.key === 'Escape') setEditingId(null) }}
            autoFocus
          />
          <button className="channel-action-btn" onClick={() => handleEditSave(ch)} title="Save">✓</button>
          <button className="channel-action-btn" onClick={() => setEditingId(null)} title="Cancel">✕</button>
        </div>
      )
    }
    return (
      <div key={ch.id} className="channel-item-row">
        <button
          className={`channel-item ${selected?.id === ch.id ? 'active' : ''}`}
          onClick={() => onSelect(ch)}
        >
          <span className="channel-hash">{ch.type === 'voice' ? '🔊' : '#'}</span> {ch.name}
        </button>
        {isAdmin && (
          <div className="channel-actions">
            <button className="channel-action-btn" onClick={() => handleMove(ch, -1)} title="Move up">▲</button>
            <button className="channel-action-btn" onClick={() => handleMove(ch, 1)} title="Move down">▼</button>
            <button className="channel-action-btn" onClick={() => handleEditStart(ch)} title="Edit">✏️</button>
            <button className="channel-action-btn delete" onClick={() => handleDelete(ch)} title="Delete">🗑</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="channel-list">
      {textChannels.length > 0 && (
        <>
          <div className="channel-category-row">
            <h3 className="channel-category">Text Channels</h3>
            {isAdmin && <button className="channel-add-btn" onClick={() => handleCreate('text')} title="Create Text Channel">+</button>}
          </div>
          {textChannels.map((ch) => renderChannelItem(ch))}
        </>
      )}
      {textChannels.length === 0 && isAdmin && (
        <div className="channel-category-row">
          <h3 className="channel-category">Text Channels</h3>
          <button className="channel-add-btn" onClick={() => handleCreate('text')} title="Create Text Channel">+</button>
        </div>
      )}

      {voiceChannels.length > 0 && (
        <>
          <div className="channel-category-row">
            <h3 className="channel-category">Voice Channels</h3>
            {isAdmin && <button className="channel-add-btn" onClick={() => handleCreate('voice')} title="Create Voice Channel">+</button>}
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
      {voiceChannels.length === 0 && isAdmin && (
        <div className="channel-category-row">
          <h3 className="channel-category">Voice Channels</h3>
          <button className="channel-add-btn" onClick={() => handleCreate('voice')} title="Create Voice Channel">+</button>
        </div>
      )}
    </div>
  )
}
