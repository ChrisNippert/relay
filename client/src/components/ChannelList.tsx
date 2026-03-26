import type { Channel } from '../types'

export interface VoicePresenceUser {
  id: string
  displayName: string
}

interface Props {
  channels: Channel[]
  selected: Channel | null
  onSelect: (channel: Channel) => void
  voicePresence?: Map<string, VoicePresenceUser[]>
}

export default function ChannelList({ channels, selected, onSelect, voicePresence }: Props) {
  const textChannels = channels.filter((c) => c.type === 'text')
  const voiceChannels = channels.filter((c) => c.type === 'voice')

  return (
    <div className="channel-list">
      {textChannels.length > 0 && (
        <>
          <h3 className="channel-category">Text Channels</h3>
          {textChannels.map((ch) => (
            <button
              key={ch.id}
              className={`channel-item ${selected?.id === ch.id ? 'active' : ''}`}
              onClick={() => onSelect(ch)}
            >
              <span className="channel-hash">#</span> {ch.name}
            </button>
          ))}
        </>
      )}

      {voiceChannels.length > 0 && (
        <>
          <h3 className="channel-category">Voice Channels</h3>
          {voiceChannels.map((ch) => {
            const users = voicePresence?.get(ch.id) ?? []
            return (
              <div key={ch.id} className="voice-channel-group">
                <button
                  className={`channel-item ${selected?.id === ch.id ? 'active' : ''}`}
                  onClick={() => onSelect(ch)}
                >
                  <span className="channel-hash">🔊</span> {ch.name}
                </button>
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
    </div>
  )
}
