import type { Channel } from '../types'

interface Props {
  channels: Channel[]
  selected: Channel | null
  onSelect: (channel: Channel) => void
}

export default function ChannelList({ channels, selected, onSelect }: Props) {
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
          {voiceChannels.map((ch) => (
            <button
              key={ch.id}
              className={`channel-item ${selected?.id === ch.id ? 'active' : ''}`}
              onClick={() => onSelect(ch)}
            >
              <span className="channel-hash">🔊</span> {ch.name}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
