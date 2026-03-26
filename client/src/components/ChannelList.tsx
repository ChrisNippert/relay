import { useState } from 'react'
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

  const handleCreateStart = (type: 'text' | 'voice') => {
    setCreatingType(type)
    setCreateName('')
  }

  const handleCreateSubmit = async () => {
    if (!serverId || !creatingType || !createName.trim()) return
    await api.createChannel(serverId, createName.trim(), creatingType)
    setCreatingType(null)
    setCreateName('')
    onChannelsChanged?.()
  }

  const handleCreateCancel = () => {
    setCreatingType(null)
    setCreateName('')
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
            <button className="channel-action-btn" onClick={() => setSettingsChannel(ch)} title="Settings">⚙️</button>
          </div>
        )}
      </div>
    )
  }

  const renderCreateInput = (type: 'text' | 'voice') => {
    if (creatingType !== type) return null
    return (
      <div className="channel-create-input">
        <input
          type="text"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          placeholder={`New ${type} channel name`}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreateSubmit()
            if (e.key === 'Escape') handleCreateCancel()
          }}
        />
        <button className="channel-action-btn" onClick={handleCreateSubmit} title="Create">✓</button>
        <button className="channel-action-btn" onClick={handleCreateCancel} title="Cancel">✕</button>
      </div>
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
          {renderCreateInput('text')}
          {textChannels.map((ch) => renderChannelItem(ch))}
        </>
      )}

      {(voiceChannels.length > 0 || isAdmin) && (
        <>
          <div className="channel-category-row">
            <h3 className="channel-category">Voice Channels</h3>
            {isAdmin && <button className="channel-add-btn" onClick={() => handleCreateStart('voice')} title="Create Voice Channel">+</button>}
          </div>
          {renderCreateInput('voice')}
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

      {settingsChannel && (
        <ChannelSettings
          channel={settingsChannel}
          onClose={() => setSettingsChannel(null)}
          onChannelUpdated={() => { setSettingsChannel(null); onChannelsChanged?.() }}
          onChannelDeleted={() => { setSettingsChannel(null); onChannelsChanged?.() }}
        />
      )}
    </div>
  )
}
