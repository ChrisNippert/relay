import { useEffect, useRef, useState } from 'react'
import type { Server, Channel, Message, ServerInvite, WSMessage as WSMsg } from '../types'
import * as api from '../services/api'
import { useAuth } from '../context/AuthContext'
import { subscribe } from '../services/ws'
import { playMessageSound, playCallRing } from '../services/sounds'
import ServerList from '../components/ServerList'
import ChannelList from '../components/ChannelList'
import ChatView from '../components/ChatView'
import VoiceChannel from '../components/VoiceChannel'
import FriendsList from '../components/FriendsList'
import SettingsPanel from '../components/SettingsPanel'
import ServerSettings from '../components/ServerSettings'
import DMCall from '../components/DMCall'

export default function Home() {
  const { user, logout } = useAuth()
  const [servers, setServers] = useState<Server[]>([])
  const [selectedServer, setSelectedServer] = useState<Server | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null)
  const [dmChannels, setDmChannels] = useState<Channel[]>([])
  const [view, setView] = useState<'server' | 'dm'>('dm')
  const selectedChannelRef = useRef<Channel | null>(null)
  const [showInvitePanel, setShowInvitePanel] = useState(false)
  const [invites, setInvites] = useState<ServerInvite[]>([])
  const [joinCode, setJoinCode] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showServerSettings, setShowServerSettings] = useState(false)
  const [dmCall, setDmCall] = useState<{ userId: string; name: string; channelId: string; video: boolean } | null>(null)
  const [incomingCall, setIncomingCall] = useState<{ fromUserId: string; fromName: string; channelId: string } | null>(null)

  // Keep ref in sync for use in WS callback
  useEffect(() => {
    selectedChannelRef.current = selectedChannel
  }, [selectedChannel])

  // Play sound for messages in other channels + handle incoming DM calls
  useEffect(() => {
    const unsub = subscribe((msg: WSMsg) => {
      if (msg.type === 'chat_message') {
        const m = msg.payload as Message
        if (m.user_id !== user?.id && (m.channel_id !== selectedChannelRef.current?.id || document.hidden)) {
          playMessageSound()
        }
      } else if (msg.type === 'call_offer') {
        const payload = msg.payload as { from_user_id?: string; channel_id?: string }
        if (payload.from_user_id && payload.from_user_id !== user?.id && !dmCall) {
          // Check if this is a DM call (not a server voice channel)
          api.getUser(payload.from_user_id).then((u) => {
            setIncomingCall({
              fromUserId: payload.from_user_id!,
              fromName: u.display_name,
              channelId: payload.channel_id || '',
            })
            playCallRing()
          }).catch(() => {})
        }
      }
    })
    return unsub
  }, [user?.id, dmCall])

  // Load servers on mount
  useEffect(() => {
    api.getServers().then(setServers).catch(console.error)
    api.getDMs().then(setDmChannels).catch(console.error)
  }, [])

  // Load channels when server changes
  useEffect(() => {
    if (selectedServer) {
      api.getChannels(selectedServer.id).then(setChannels).catch(console.error)
    } else {
      setChannels([])
    }
  }, [selectedServer])

  const handleSelectServer = (server: Server) => {
    setSelectedServer(server)
    setSelectedChannel(null)
    setView('server')
  }

  const handleSelectDMs = () => {
    setSelectedServer(null)
    setSelectedChannel(null)
    setView('dm')
  }

  const handleSelectChannel = (channel: Channel) => {
    setSelectedChannel(channel)
  }

  const handleCreateServer = async () => {
    const name = prompt('Server name:')
    if (!name) return
    const server = await api.createServer(name)
    setServers((prev) => [...prev, server])
    handleSelectServer(server)
  }

  const handleServerUpdated = (updated: Server) => {
    setServers((prev) => prev.map((s) => s.id === updated.id ? updated : s))
    if (selectedServer?.id === updated.id) setSelectedServer(updated)
  }

  const handleServerRemoved = (serverId: string) => {
    setServers((prev) => prev.filter((s) => s.id !== serverId))
    if (selectedServer?.id === serverId) {
      setSelectedServer(null)
      setSelectedChannel(null)
      setView('dm')
    }
    setShowServerSettings(false)
  }

  const handleStartDMCall = async (userId: string, video: boolean) => {
    try {
      const ch = await api.createDM(userId)
      const u = await api.getUser(userId)
      setDmCall({ userId, name: u.display_name, channelId: ch.id, video })
    } catch (err) {
      console.error('Failed to start DM call:', err)
    }
  }

  const handleAcceptIncomingCall = () => {
    if (!incomingCall) return
    setDmCall({
      userId: incomingCall.fromUserId,
      name: incomingCall.fromName,
      channelId: incomingCall.channelId,
      video: false,
    })
    setIncomingCall(null)
  }

  const handleDeclineIncomingCall = () => {
    setIncomingCall(null)
  }

  const [copiedCode, setCopiedCode] = useState('')

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedCode(text)
      setTimeout(() => setCopiedCode(''), 2000)
    }).catch(() => {
      // Fallback: select a temporary input
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
    if (!selectedServer) return
    try {
      const invite = await api.createInvite(selectedServer.id)
      setInvites((prev) => [invite, ...prev])
      copyToClipboard(invite.code)
    } catch (e) {
      console.error('Failed to create invite:', e)
    }
  }

  const handleShowInvites = async () => {
    if (!selectedServer) return
    setShowInvitePanel(true)
    try {
      const list = await api.getInvites(selectedServer.id)
      setInvites(list)
    } catch {
      setInvites([])
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

  const handleJoinByCode = async () => {
    const code = joinCode.trim()
    if (!code) return
    try {
      const server = await api.joinByInvite(code)
      setServers((prev) => prev.some((s) => s.id === server.id) ? prev : [...prev, server])
      handleSelectServer(server)
      setJoinCode('')
    } catch (e) {
      alert('Invalid or expired invite code')
    }
  }

  const isVoiceChannel = selectedChannel?.type === 'voice'

  return (
    <div className="app-layout">
      <ServerList
        servers={servers}
        selected={selectedServer}
        onSelect={handleSelectServer}
        onDMs={handleSelectDMs}
        onCreate={handleCreateServer}
        isDMView={view === 'dm'}
        joinCode={joinCode}
        onJoinCodeChange={setJoinCode}
        onJoinByCode={handleJoinByCode}
      />

      <div className="channel-sidebar">
        <div className="channel-sidebar-header">
          <h2>{view === 'dm' ? 'Direct Messages' : selectedServer?.name}</h2>
          {view === 'server' && selectedServer && (
            <>
              <button className="invite-btn" onClick={handleShowInvites} title="Invite People">
                🔗
              </button>
              <button className="invite-btn" onClick={() => setShowServerSettings(true)} title="Server Settings">
                ⚙️
              </button>
            </>
          )}
        </div>

        {showInvitePanel && selectedServer && (
          <div className="invite-panel">
            <div className="invite-panel-header">
              <h3>Invite People</h3>
              <button className="close-btn" onClick={() => setShowInvitePanel(false)}>×</button>
            </div>
            <button className="create-invite-btn" onClick={handleCreateInvite}>Generate Invite Code</button>
            {invites.length > 0 && (
              <div className="invite-list">
                {invites.map((inv) => (
                  <div key={inv.id} className="invite-item">
                    <code className="invite-code">{inv.code}</code>
                    <span className="invite-uses">
                      {inv.uses}{inv.max_uses > 0 ? `/${inv.max_uses}` : ''} uses
                    </span>
                    <button className="invite-copy" onClick={() => copyToClipboard(inv.code)} title="Copy code">
                      {copiedCode === inv.code ? '✓' : '📋'}
                    </button>
                    <button className="invite-delete" onClick={() => handleDeleteInvite(inv.id)} title="Delete invite">
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {view === 'dm' ? (
          <FriendsList dmChannels={dmChannels} onSelectChannel={handleSelectChannel} onStartCall={handleStartDMCall} />
        ) : (
          <ChannelList
            channels={channels}
            selected={selectedChannel}
            onSelect={handleSelectChannel}
          />
        )}

        <div className="user-bar">
          <button className="user-bar-btn" onClick={() => setShowSettings(true)} title="Settings">⚙️</button>
          <button className="link-btn" onClick={logout}>Logout</button>
        </div>
      </div>

      <div className="main-content">
        {dmCall ? (
          <DMCall
            targetUserId={dmCall.userId}
            targetName={dmCall.name}
            channelId={dmCall.channelId}
            startWithVideo={dmCall.video}
            onEnd={() => setDmCall(null)}
          />
        ) : selectedChannel ? (
          isVoiceChannel ? (
            <VoiceChannel channel={selectedChannel} />
          ) : (
            <ChatView channel={selectedChannel} onStartCall={handleStartDMCall} />
          )
        ) : (
          <div className="no-channel">
            <p>Select a channel to start chatting</p>
          </div>
        )}
      </div>

      {/* Settings Modal */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      {/* Server Settings Modal */}
      {showServerSettings && selectedServer && (
        <ServerSettings
          server={selectedServer}
          onClose={() => setShowServerSettings(false)}
          onServerUpdated={handleServerUpdated}
          onServerDeleted={handleServerRemoved}
          onServerLeft={handleServerRemoved}
        />
      )}

      {/* Incoming Call Notification */}
      {incomingCall && (
        <div className="incoming-call-overlay">
          <div className="incoming-call-card">
            <p>📞 Incoming call from <strong>{incomingCall.fromName}</strong></p>
            <div className="incoming-call-buttons">
              <button className="accept-call-btn" onClick={handleAcceptIncomingCall}>Accept</button>
              <button className="decline-call-btn" onClick={handleDeclineIncomingCall}>Decline</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
