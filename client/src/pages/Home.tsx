import { useEffect, useRef, useState, useCallback } from 'react'
import type { Server, Channel, Message, WSMessage as WSMsg } from '../types'
import * as api from '../services/api'
import { useAuth } from '../context/AuthContext'
import { subscribe } from '../services/ws'
import { playMessageSound, playCallRing } from '../services/sounds'
import ServerList from '../components/ServerList'
import ChannelList from '../components/ChannelList'
import type { VoicePresenceUser } from '../components/ChannelList'
import ChatView from '../components/ChatView'
import VoiceChannel from '../components/VoiceChannel'
import type { VoiceChannelHandle } from '../components/VoiceChannel'
import FriendsList from '../components/FriendsList'
import SettingsPanel from '../components/SettingsPanel'
import ServerSettings from '../components/ServerSettings'
import DMCall from '../components/DMCall'
import MembersSidebar from '../components/MembersSidebar'

export default function Home() {
  const { user } = useAuth()
  const [servers, setServers] = useState<Server[]>([])
  const [selectedServer, setSelectedServer] = useState<Server | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null)
  const [dmChannels, setDmChannels] = useState<Channel[]>([])
  const [view, setView] = useState<'server' | 'dm'>('dm')
  const selectedChannelRef = useRef<Channel | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showServerSettings, setShowServerSettings] = useState(false)
  const [dmCall, setDmCall] = useState<{ userId: string; name: string; channelId: string; video: boolean; incomingOffer?: RTCSessionDescriptionInit } | null>(null)
  const [incomingCall, setIncomingCall] = useState<{ fromUserId: string; fromName: string; channelId: string; offer: RTCSessionDescriptionInit } | null>(null)
  const [activeVoiceChannel, setActiveVoiceChannel] = useState<Channel | null>(null)
  const voiceRef = useRef<VoiceChannelHandle>(null)
  const [voiceControls, setVoiceControls] = useState({
    muted: false, deafened: false, videoOn: false, screenSharing: false, joined: false,
  })
  const [voicePresence, setVoicePresence] = useState<Map<string, VoicePresenceUser[]>>(new Map())
  const [isAdmin, setIsAdmin] = useState(false)
  const [showMembers, setShowMembers] = useState(true)
  const [channelSidebarCollapsed, setChannelSidebarCollapsed] = useState(false)

  // Poll voice ref state to keep sidebar controls in sync
  const syncVoiceControls = useCallback(() => {
    if (voiceRef.current) {
      setVoiceControls({
        muted: voiceRef.current.muted,
        deafened: voiceRef.current.deafened,
        videoOn: voiceRef.current.videoOn,
        screenSharing: voiceRef.current.screenSharing,
        joined: voiceRef.current.joined,
      })
    }
  }, [])

  useEffect(() => {
    if (!activeVoiceChannel) return
    const interval = setInterval(syncVoiceControls, 150)
    return () => clearInterval(interval)
  }, [activeVoiceChannel, syncVoiceControls])

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
        const payload = msg.payload as { from_user_id?: string; channel_id?: string; signal?: RTCSessionDescriptionInit }
        if (payload.from_user_id && payload.from_user_id !== user?.id && !dmCall) {
          // Skip voice channel renegotiation offers
          if (activeVoiceChannel && payload.channel_id === activeVoiceChannel.id) return
          api.getUser(payload.from_user_id).then((u) => {
            setIncomingCall({
              fromUserId: payload.from_user_id!,
              fromName: u.display_name,
              channelId: payload.channel_id || '',
              offer: payload.signal!,
            })
            playCallRing()
          }).catch(() => {})
        }
      }
    })
    return unsub
  }, [user?.id, dmCall, activeVoiceChannel?.id])

  // Load servers on mount
  useEffect(() => {
    api.getServers().then(setServers).catch(console.error)
    api.getDMs().then(setDmChannels).catch(console.error)
  }, [])

  // Track voice presence for sidebar display
  useEffect(() => {
    const voiceChannelIds = channels.filter((c) => c.type === 'voice').map((c) => c.id)
    if (voiceChannelIds.length === 0) {
      setVoicePresence(new Map())
      return
    }
    // Fetch initial presence for all voice channels
    Promise.all(voiceChannelIds.map(async (chId) => {
      const userIds = await api.getVoiceUsers(chId).catch(() => [] as string[])
      const users: VoicePresenceUser[] = await Promise.all(
        (userIds || []).map(async (uid) => {
          try {
            const u = await api.getUser(uid)
            return { id: uid, displayName: u.display_name }
          } catch { return { id: uid, displayName: uid.slice(0, 8) } }
        })
      )
      return [chId, users] as [string, VoicePresenceUser[]]
    })).then((entries) => {
      setVoicePresence(new Map(entries))
    })

    // Subscribe to voice_state updates
    const unsub = subscribe((msg: WSMsg) => {
      if (msg.type === 'voice_state') {
        const payload = msg.payload as { channel_id: string; user_ids: string[] }
        if (!voiceChannelIds.includes(payload.channel_id)) return
        Promise.all(
          (payload.user_ids || []).map(async (uid) => {
            try {
              const u = await api.getUser(uid)
              return { id: uid, displayName: u.display_name }
            } catch { return { id: uid, displayName: uid.slice(0, 8) } }
          })
        ).then((users) => {
          setVoicePresence((prev) => {
            const next = new Map(prev)
            next.set(payload.channel_id, users)
            return next
          })
        })
      }
    })
    return unsub
  }, [channels])

  // Load channels when server changes
  useEffect(() => {
    if (selectedServer) {
      api.getChannels(selectedServer.id).then((chs) => {
        setChannels(chs)
        // Auto-select the first text channel if none selected
        if (!selectedChannel || selectedChannel.server_id !== selectedServer.id) {
          const firstText = chs.find((c) => c.type === 'text')
          if (firstText) setSelectedChannel(firstText)
        }
      }).catch(console.error)
      // Determine admin status
      api.getMembers(selectedServer.id).then((members) => {
        const me = members.find((m) => m.user_id === user?.id)
        setIsAdmin(me?.role === 'admin')
      }).catch(() => setIsAdmin(false))
    } else {
      setChannels([])
      setIsAdmin(false)
    }
  }, [selectedServer, user?.id])

  const refreshChannels = useCallback(() => {
    if (selectedServer) {
      api.getChannels(selectedServer.id).then(setChannels).catch(console.error)
    }
  }, [selectedServer])

  // Listen for channel changes via WS
  useEffect(() => {
    const unsub = subscribe((msg: WSMsg) => {
      const payload = msg.payload as Record<string, unknown>
      const serverID = payload?.server_id as string | undefined
      if (!serverID || serverID !== selectedServer?.id) return

      if (msg.type === 'channel_created') {
        setChannels((prev) => [...prev, payload as unknown as Channel])
      } else if (msg.type === 'channel_updated') {
        setChannels((prev) => prev.map((c) => c.id === (payload as { id: string }).id ? (payload as unknown as Channel) : c))
      } else if (msg.type === 'channel_deleted') {
        const deletedId = (payload as { id: string }).id
        setChannels((prev) => prev.filter((c) => c.id !== deletedId))
        if (selectedChannel?.id === deletedId) setSelectedChannel(null)
      } else if (msg.type === 'channels_reordered') {
        const chs = (payload as { channels: Channel[] }).channels
        if (chs) setChannels(chs)
      } else if (msg.type === 'member_role_updated') {
        const uid = (payload as { user_id: string }).user_id
        const role = (payload as { role: string }).role
        if (uid === user?.id) setIsAdmin(role === 'admin')
      } else if (msg.type === 'member_kicked') {
        const uid = (payload as { user_id: string }).user_id
        if (uid === user?.id) {
          // We were kicked from this server
          setServers((prev) => prev.filter((s) => s.id !== serverID))
          if (selectedServer?.id === serverID) {
            setSelectedServer(null)
            setSelectedChannel(null)
            setView('dm')
          }
        }
      }
    })
    return unsub
  }, [selectedServer?.id, selectedChannel?.id, user?.id])

  const handleSelectServer = (server: Server) => {
    setSelectedServer(server)
    setView('server')
  }

  const handleSelectDMs = () => {
    setSelectedServer(null)
    setSelectedChannel(null)
    setView('dm')
  }

  const handleSelectChannel = (channel: Channel) => {
    setSelectedChannel(channel)
    // Clicking a voice channel auto-joins it
    if (channel.type === 'voice' && activeVoiceChannel?.id !== channel.id) {
      // If already in a different voice channel, leave it first
      if (activeVoiceChannel && voiceRef.current) {
        voiceRef.current.leaveVoice()
      }
      setActiveVoiceChannel(channel)
    }
  }

  const handleCreateServer = async (name: string) => {
    try {
      const server = await api.createServer(name)
      setServers((prev) => [...prev, server])
      handleSelectServer(server)
    } catch (e) {
      console.error('Failed to create server:', e)
    }
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

  const handleDMUser = useCallback(async (userId: string) => {
    try {
      const ch = await api.createDM(userId)
      setDmChannels((prev) => prev.some((d) => d.id === ch.id) ? prev : [...prev, ch])
      setSelectedServer(null)
      setView('dm')
      setSelectedChannel(ch)
    } catch (e) {
      console.error('Failed to open DM:', e)
    }
  }, [])

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
      incomingOffer: incomingCall.offer,
    })
    setIncomingCall(null)
  }

  const handleDeclineIncomingCall = () => {
    setIncomingCall(null)
  }

  const handleJoinByCode = async (code: string) => {
    if (!code) return
    try {
      const server = await api.joinByInvite(code)
      setServers((prev) => prev.some((s) => s.id === server.id) ? prev : [...prev, server])
      handleSelectServer(server)
    } catch (e) {
      alert('Invalid or expired invite code')
    }
  }

  const isVoiceChannel = selectedChannel?.type === 'voice'
  const isViewingActiveVoice = activeVoiceChannel != null && selectedChannel?.id === activeVoiceChannel.id

  const handleVoiceLeave = () => {
    setActiveVoiceChannel(null)
  }

  return (
    <div className="app-layout">
      <ServerList
        servers={servers}
        selected={selectedServer}
        onSelect={handleSelectServer}
        onDMs={handleSelectDMs}
        onCreate={handleCreateServer}
        isDMView={view === 'dm'}
        onJoinByCode={handleJoinByCode}
      />

      <div className={`channel-sidebar ${channelSidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="channel-sidebar-header">
          <button className="sidebar-collapse-btn" onClick={() => setChannelSidebarCollapsed(!channelSidebarCollapsed)} title={channelSidebarCollapsed ? 'Expand' : 'Collapse'}>
            {channelSidebarCollapsed ? '»' : '«'}
          </button>
          {!channelSidebarCollapsed && (
            <>
              <h2>{view === 'dm' ? 'Direct Messages' : selectedServer?.name}</h2>
              {view === 'server' && selectedServer && (
                <>
                  <button className="invite-btn" onClick={() => setShowServerSettings(true)} title="Server Settings">
                    ⚙️
                  </button>
                </>
              )}
            </>
          )}
        </div>

        {!channelSidebarCollapsed && (
          <>
            <div className="sidebar-panels-container">
              <div className={`sidebar-panel ${view === 'dm' ? 'active' : ''}`}>
                <FriendsList dmChannels={dmChannels} onSelectChannel={handleSelectChannel} onStartCall={handleStartDMCall} />
              </div>
              <div className={`sidebar-panel ${view === 'server' ? 'active' : ''}`}>
                <ChannelList
                  channels={channels}
                  selected={selectedChannel}
                  onSelect={handleSelectChannel}
                  voicePresence={voicePresence}
                  isAdmin={isAdmin}
                  serverId={selectedServer?.id}
                  onChannelsChanged={refreshChannels}
                />
              </div>
            </div>
          </>
        )}

        {/* Voice status bar — Discord-style, shows when connected to voice */}
        {activeVoiceChannel && voiceControls.joined && (
          <div className="voice-status-bar">
            <div className="voice-status-bar-top">
              <div className="voice-status-bar-info">
                <span className="voice-status-bar-label">🔊 Voice Connected</span>
                <button
                  className="voice-status-bar-channel"
                  onClick={() => {
                    if (activeVoiceChannel.server_id) {
                      const srv = servers.find((s) => s.id === activeVoiceChannel.server_id)
                      if (srv) {
                        setSelectedServer(srv)
                        setView('server')
                        api.getChannels(srv.id).then(setChannels).catch(console.error)
                      }
                    }
                    setSelectedChannel(activeVoiceChannel)
                  }}
                >
                  {activeVoiceChannel.name}
                </button>
              </div>
            </div>
            <div className="voice-status-bar-controls">
              <button
                className={`voice-bar-btn ${voiceControls.muted ? 'active' : ''}`}
                onClick={() => { voiceRef.current?.toggleMute(); syncVoiceControls() }}
                title={voiceControls.muted ? 'Unmute' : 'Mute'}
              >
                {voiceControls.muted ? '🔇' : '🎙️'}
              </button>
              <button
                className={`voice-bar-btn ${voiceControls.deafened ? 'active' : ''}`}
                onClick={() => { voiceRef.current?.toggleDeafen(); syncVoiceControls() }}
                title={voiceControls.deafened ? 'Undeafen' : 'Deafen'}
              >
                {voiceControls.deafened ? '🔈' : '🔊'}
              </button>
              <button
                className={`voice-bar-btn ${voiceControls.videoOn ? 'active' : ''}`}
                onClick={() => { voiceRef.current?.toggleVideo(); syncVoiceControls() }}
                title={voiceControls.videoOn ? 'Camera Off' : 'Camera On'}
              >
                📷
              </button>
              <button
                className={`voice-bar-btn ${voiceControls.screenSharing ? 'active' : ''}`}
                onClick={() => { voiceRef.current?.toggleScreenShare(); syncVoiceControls() }}
                title={voiceControls.screenSharing ? 'Stop Sharing' : 'Share Screen'}
              >
                🖥️
              </button>
              <button
                className="voice-bar-btn disconnect"
                onClick={() => { voiceRef.current?.leaveVoice() }}
                title="Disconnect"
              >
                📞
              </button>
            </div>
          </div>
        )}

        <div className="user-panel">
          <div className="user-panel-info">
            <div className="user-panel-avatar">
              {user?.avatar_url ? (
                <img src={user.avatar_url} alt="" className="user-panel-avatar-img" />
              ) : (
                <span className="user-panel-avatar-fallback">{user?.display_name?.[0]?.toUpperCase() ?? '?'}</span>
              )}
              <span className="user-panel-status-dot online" />
            </div>
            <div className="user-panel-names">
              <span className="user-panel-display" style={user?.name_color ? { color: user.name_color } : undefined}>
                {user?.display_name}
              </span>
              {user?.custom_status ? (
                <span className="user-panel-status-text">{user.custom_status}</span>
              ) : (
                <span className="user-panel-username">@{user?.username}</span>
              )}
            </div>
          </div>
          <div className="user-panel-buttons">
            <button className="user-panel-btn" onClick={() => setShowSettings(true)} title="Settings">⚙️</button>
          </div>
        </div>
      </div>

      <div className="main-content">
        {/* Persistent voice channel — stays mounted to keep WebRTC alive */}
        {activeVoiceChannel && (
          <div className="voice-channel-wrapper" style={{ display: isViewingActiveVoice ? 'flex' : 'none' }}>
            <VoiceChannel
              ref={voiceRef}
              channel={activeVoiceChannel}
              autoJoin
              isAdmin={isAdmin}
              onJoin={() => { setActiveVoiceChannel(activeVoiceChannel); syncVoiceControls() }}
              onLeave={handleVoiceLeave}
            />
          </div>
        )}

        {/* Regular content — shown when not viewing active voice channel */}
        {!isViewingActiveVoice && (
          dmCall ? (
            <DMCall
              targetUserId={dmCall.userId}
              targetName={dmCall.name}
              channelId={dmCall.channelId}
              startWithVideo={dmCall.video}
              incomingOffer={dmCall.incomingOffer}
              onEnd={() => setDmCall(null)}
            />
          ) : selectedChannel && !isVoiceChannel ? (
            <ChatView channel={selectedChannel} onStartCall={handleStartDMCall} onDMUser={handleDMUser}
              showMembersToggle={view === 'server'} showMembers={showMembers} onToggleMembers={() => setShowMembers((p) => !p)}
              isAdmin={isAdmin} serverId={selectedServer?.id} />
          ) : !selectedChannel ? (
            <div className="no-channel">
              <p>Select a channel to start chatting</p>
            </div>
          ) : null
        )}
      </div>

      {/* Members sidebar for servers */}
      {view === 'server' && selectedServer && (
        <div className={`members-sidebar-wrapper ${showMembers ? 'open' : ''}`}>
          <MembersSidebar serverId={selectedServer.id} onMessage={handleDMUser} isAdmin={isAdmin} />
        </div>
      )}

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
