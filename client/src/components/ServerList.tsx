import type { Server } from '../types'

interface Props {
  servers: Server[]
  selected: Server | null
  onSelect: (server: Server) => void
  onDMs: () => void
  onCreate: () => void
  isDMView: boolean
  joinCode: string
  onJoinCodeChange: (code: string) => void
  onJoinByCode: () => void
}

export default function ServerList({ servers, selected, onSelect, onDMs, onCreate, isDMView, joinCode, onJoinCodeChange, onJoinByCode }: Props) {
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
          {s.name.charAt(0).toUpperCase()}
        </button>
      ))}

      <button className="server-icon add" onClick={onCreate} title="Create Server">
        +
      </button>

      <div className="server-divider" />

      <div className="join-code-input">
        <input
          type="text"
          value={joinCode}
          onChange={(e) => onJoinCodeChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onJoinByCode()}
          placeholder="Code"
          title="Enter invite code to join a server"
        />
        <button className="server-icon join" onClick={onJoinByCode} title="Join Server">
          →
        </button>
      </div>
    </div>
  )
}
