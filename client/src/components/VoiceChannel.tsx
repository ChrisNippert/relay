import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import type { Channel, WSMessage as WSMsg } from '../types'
import { useAuth } from '../context/AuthContext'
import { subscribe, sendCallOffer, sendCallAnswer, sendIceCandidate, sendCallEnd, sendVoiceJoin, sendVoiceLeave } from '../services/ws'
import { PeerConnection } from '../services/webrtc'
import * as api from '../services/api'
import { playJoinSound, playLeaveSound, playConnectedSound, playDisconnectedSound, playCallRing, playErrorSound } from '../services/sounds'
import { getSettings } from '../services/settings'

interface Props {
  channel: Channel
  autoJoin?: boolean
  onJoin?: () => void
  onLeave?: () => void
}

export interface VoiceChannelHandle {
  toggleMute: () => void
  toggleDeafen: () => void
  toggleVideo: () => void
  toggleScreenShare: () => void
  leaveVoice: () => void
  muted: boolean
  deafened: boolean
  videoOn: boolean
  screenSharing: boolean
  joined: boolean
}

interface VoiceUser {
  id: string
  displayName: string
  isSelf: boolean
  hasVideo: boolean
  hasScreen: boolean
  speaking: boolean
}

export default forwardRef<VoiceChannelHandle, Props>(function VoiceChannel({ channel, autoJoin, onJoin, onLeave }, ref) {
  const { user } = useAuth()
  const [joined, setJoined] = useState(false)
  const [voiceUsers, setVoiceUsers] = useState<VoiceUser[]>([])
  const [muted, setMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [videoOn, setVideoOn] = useState(false)
  const [screenSharing, setScreenSharing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [members, setMembers] = useState<Map<string, string>>(new Map())
  const [, setChannelVoiceUsers] = useState<string[]>([])
  const [, setLocalSpeaking] = useState(false)
  const [focusedUser, setFocusedUser] = useState<string | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map())

  const peersRef = useRef<Map<string, PeerConnection>>(new Map())
  const localStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const localScreenRef = useRef<HTMLVideoElement>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLDivElement>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const speakingAnimRef = useRef<number>(0)

  // Load server members for display names
  useEffect(() => {
    if (channel.server_id) {
      api.getMembers(channel.server_id).then(async (serverMembers) => {
        const names = new Map<string, string>()
        for (const m of serverMembers) {
          try {
            const u = await api.getUser(m.user_id)
            names.set(m.user_id, u.display_name)
          } catch { /* skip */ }
        }
        setMembers(names)
      }).catch(console.error)
    }
  }, [channel.server_id])

  // Fetch initial voice state
  useEffect(() => {
    api.getVoiceUsers(channel.id).then((userIds) => {
      setChannelVoiceUsers(userIds || [])
    }).catch(() => {})
  }, [channel.id])

  // Listen for voice state updates
  useEffect(() => {
    const unsub = subscribe((msg: WSMsg) => {
      if (msg.type === 'voice_state') {
        const payload = msg.payload as { channel_id: string; user_ids: string[] }
        if (payload.channel_id === channel.id) {
          setChannelVoiceUsers(payload.user_ids || [])
        }
      }
    })
    return unsub
  }, [channel.id])

  // Listen for WebRTC signaling
  useEffect(() => {
    if (!joined) return

    const unsub = subscribe((msg: WSMsg) => {
      const payload = msg.payload as {
        from_user_id?: string
        channel_id?: string
        signal?: RTCSessionDescriptionInit | RTCIceCandidateInit
      }

      if (payload.channel_id !== channel.id) return

      switch (msg.type) {
        case 'call_offer':
          handleIncomingOffer(payload.from_user_id!, payload.signal as RTCSessionDescriptionInit)
          break
        case 'call_answer':
          handleIncomingAnswer(payload.from_user_id!, payload.signal as RTCSessionDescriptionInit)
          break
        case 'ice_candidate':
          handleIncomingIce(payload.from_user_id!, payload.signal as RTCIceCandidateInit)
          break
        case 'call_end':
          handlePeerLeft(payload.from_user_id!)
          break
      }
    })

    return unsub
  }, [joined, channel.id])

  // Expose controls to parent via ref
  useImperativeHandle(ref, () => ({
    toggleMute: () => toggleMute(),
    toggleDeafen: () => toggleDeafen(),
    toggleVideo: () => toggleVideo(),
    toggleScreenShare: () => toggleScreenShare(),
    leaveVoice: () => leaveVoice(),
    muted,
    deafened,
    videoOn,
    screenSharing,
    joined,
  }))

  // Auto-join when prop is set
  const autoJoinedRef = useRef(false)
  useEffect(() => {
    if (autoJoin && !joined && !connecting && !autoJoinedRef.current) {
      autoJoinedRef.current = true
      joinVoice()
    }
  }, [autoJoin])

  const getName = useCallback((userId: string) => members.get(userId) ?? userId.slice(0, 8), [members])

  // Voice activity detection for local mic
  function startVoiceActivityDetection(stream: MediaStream) {
    try {
      const ctx = new AudioContext()
      audioContextRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.4
      source.connect(analyser)
      analyserRef.current = analyser

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const check = () => {
        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]!
        const avg = sum / dataArray.length
        const isSpeaking = avg > 15
        setLocalSpeaking(isSpeaking)
        setVoiceUsers((prev) =>
          prev.map((u) => u.isSelf ? { ...u, speaking: isSpeaking } : u)
        )
        speakingAnimRef.current = requestAnimationFrame(check)
      }
      check()
    } catch { /* AudioContext not supported */ }
  }

  function stopVoiceActivityDetection() {
    cancelAnimationFrame(speakingAnimRef.current)
    analyserRef.current = null
    audioContextRef.current?.close()
    audioContextRef.current = null
    setLocalSpeaking(false)
  }

  function getAudioConstraints(): MediaTrackConstraints | boolean {
    const settings = getSettings()
    return settings.audioInputDevice
      ? { deviceId: { exact: settings.audioInputDevice } }
      : true
  }

  async function joinVoice() {
    if (!user) return
    setConnecting(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: getAudioConstraints(), video: false })
      localStreamRef.current = stream
      setJoined(true)
      setVoiceUsers([{ id: user.id, displayName: user.display_name, isSelf: true, hasVideo: false, hasScreen: false, speaking: false }])
      playJoinSound()
      startVoiceActivityDetection(stream)
      onJoin?.()

      // Tell server we joined voice
      sendVoiceJoin(channel.id)

      // Get current voice users and initiate calls to them (only those already in voice)
      const currentUsers = await api.getVoiceUsers(channel.id)
      for (const uid of currentUsers) {
        if (uid === user.id) continue
        await initiateCall(uid, stream)
      }
    } catch (err) {
      console.error('Failed to get microphone:', err)
      playErrorSound()
      alert('Could not access microphone. Check browser permissions.')
    } finally {
      setConnecting(false)
    }
  }

  async function initiateCall(targetUserId: string, stream: MediaStream) {
    const pc = new PeerConnection()
    peersRef.current.set(targetUserId, pc)

    stream.getTracks().forEach((track) => pc.pc.addTrack(track, stream))

    pc.onIceCandidate = (candidate) => {
      sendIceCandidate(targetUserId, channel.id, candidate)
    }

    pc.onRemoteStream = (remoteStream) => {
      attachRemoteMedia(targetUserId, remoteStream)
      const name = getName(targetUserId)
      setVoiceUsers((prev) => {
        if (prev.some((u) => u.id === targetUserId)) return prev
        playConnectedSound()
        return [...prev, { id: targetUserId, displayName: name, isSelf: false, hasVideo: false, hasScreen: false, speaking: false }]
      })
    }

    const offer = await pc.createOffer()
    sendCallOffer(targetUserId, channel.id, offer)
  }

  async function handleIncomingOffer(fromUserId: string, offer: RTCSessionDescriptionInit) {
    if (!localStreamRef.current) return

    const existing = peersRef.current.get(fromUserId)
    if (existing) {
      // Renegotiation: just set remote description and answer
      try {
        const answer = await existing.handleOffer(offer)
        sendCallAnswer(fromUserId, channel.id, answer)
        return
      } catch {
        existing.close()
        peersRef.current.delete(fromUserId)
      }
    }

    const pc = new PeerConnection()
    peersRef.current.set(fromUserId, pc)

    localStreamRef.current.getTracks().forEach((track) => pc.pc.addTrack(track, localStreamRef.current!))

    pc.onIceCandidate = (candidate) => {
      sendIceCandidate(fromUserId, channel.id, candidate)
    }

    pc.onRemoteStream = (remoteStream) => {
      attachRemoteMedia(fromUserId, remoteStream)
      const name = getName(fromUserId)
      setVoiceUsers((prev) => {
        if (prev.some((u) => u.id === fromUserId)) return prev
        playConnectedSound()
        return [...prev, { id: fromUserId, displayName: name, isSelf: false, hasVideo: false, hasScreen: false, speaking: false }]
      })
    }

    const answer = await pc.handleOffer(offer)
    sendCallAnswer(fromUserId, channel.id, answer)
    playCallRing()
  }

  async function handleIncomingAnswer(fromUserId: string, answer: RTCSessionDescriptionInit) {
    const pc = peersRef.current.get(fromUserId)
    if (pc) await pc.handleAnswer(answer)
  }

  async function handleIncomingIce(fromUserId: string, candidate: RTCIceCandidateInit) {
    const pc = peersRef.current.get(fromUserId)
    if (pc) await pc.addIceCandidate(candidate)
  }

  function handlePeerLeft(userId: string) {
    const pc = peersRef.current.get(userId)
    if (pc) {
      pc.close()
      peersRef.current.delete(userId)
    }
    const el = document.getElementById(`remote-audio-${userId}`)
    el?.remove()
    setRemoteStreams((prev) => {
      const next = new Map(prev)
      next.delete(userId)
      return next
    })
    setVoiceUsers((prev) => prev.filter((u) => u.id !== userId))
    playLeaveSound()
  }

  function attachRemoteMedia(userId: string, stream: MediaStream) {
    // Remove any existing audio-only element
    const existingEl = document.getElementById(`remote-audio-${userId}`)
    if (existingEl) existingEl.remove()

    const settings = getSettings()
    const hasVideoTrack = stream.getVideoTracks().length > 0

    if (hasVideoTrack) {
      // Store stream in React state so it renders in the user's tile
      setRemoteStreams((prev) => {
        const next = new Map(prev)
        next.set(userId, stream)
        return next
      })

      setVoiceUsers((prev) =>
        prev.map((u) => u.id === userId ? { ...u, hasVideo: true } : u)
      )
    }

    // Always create a hidden audio element for audio playback
    const audio = document.createElement('audio')
    audio.id = `remote-audio-${userId}`
    audio.srcObject = stream
    audio.autoplay = true
    audio.volume = settings.outputVolume / 100
    audio.setAttribute('playsinline', '')
    remoteAudioRef.current?.appendChild(audio)

    // Set output device if supported
    if (settings.audioOutputDevice && 'setSinkId' in audio) {
      (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
        .setSinkId(settings.audioOutputDevice).catch(() => {})
    }
  }

  function leaveVoice() {
    for (const [userId, pc] of peersRef.current) {
      sendCallEnd(userId, channel.id)
      pc.close()
    }
    peersRef.current.clear()

    stopVoiceActivityDetection()

    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    screenStreamRef.current?.getTracks().forEach((t) => t.stop())
    screenStreamRef.current = null

    if (remoteAudioRef.current) remoteAudioRef.current.innerHTML = ''
    if (localVideoRef.current) localVideoRef.current.srcObject = null
    if (localScreenRef.current) localScreenRef.current.srcObject = null

    sendVoiceLeave(channel.id)

    setJoined(false)
    setVoiceUsers([])
    setRemoteStreams(new Map())
    setMuted(false)
    setDeafened(false)
    setVideoOn(false)
    setScreenSharing(false)
    playDisconnectedSound()
    onLeave?.()
  }

  function toggleMute() {
    const stream = localStreamRef.current
    if (!stream) return
    const newMuted = !muted
    stream.getAudioTracks().forEach((t) => { t.enabled = !newMuted })
    setMuted(newMuted)
  }

  function toggleDeafen() {
    const newDeafened = !deafened
    if (remoteAudioRef.current) {
      const elems = remoteAudioRef.current.querySelectorAll('audio, video')
      elems.forEach((a) => { (a as HTMLMediaElement).muted = newDeafened })
    }
    setDeafened(newDeafened)
  }

  async function toggleVideo() {
    if (!user || !joined) return
    if (videoOn) {
      localStreamRef.current?.getVideoTracks().forEach((t) => {
        t.stop()
        localStreamRef.current?.removeTrack(t)
      })
      if (localVideoRef.current) localVideoRef.current.srcObject = null
      setVideoOn(false)
      setVoiceUsers((prev) =>
        prev.map((u) => u.id === user.id ? { ...u, hasVideo: false } : u)
      )
      await renegotiateAllPeers()
    } else {
      try {
        const settings = getSettings()
        const constraints: MediaStreamConstraints = {
          video: settings.videoDevice ? { deviceId: { exact: settings.videoDevice } } : true
        }
        const videoStream = await navigator.mediaDevices.getUserMedia(constraints)
        const videoTrack = videoStream.getVideoTracks()[0]
        if (videoTrack && localStreamRef.current) {
          localStreamRef.current.addTrack(videoTrack)
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = localStreamRef.current
          }
          for (const pc of peersRef.current.values()) {
            pc.pc.addTrack(videoTrack, localStreamRef.current)
          }
        }
        setVideoOn(true)
        setVoiceUsers((prev) =>
          prev.map((u) => u.id === user.id ? { ...u, hasVideo: true } : u)
        )
        await renegotiateAllPeers()
      } catch (err) {
        console.error('Failed to enable video:', err)
        playErrorSound()
      }
    }
  }

  async function toggleScreenShare() {
    if (!user || !joined) return
    if (screenSharing) {
      screenStreamRef.current?.getTracks().forEach((t) => {
        t.stop()
        localStreamRef.current?.removeTrack(t)
      })
      screenStreamRef.current = null
      if (localScreenRef.current) localScreenRef.current.srcObject = null
      setScreenSharing(false)
      setVoiceUsers((prev) =>
        prev.map((u) => u.id === user.id ? { ...u, hasScreen: false } : u)
      )
      await renegotiateAllPeers()
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        screenStreamRef.current = screenStream
        if (localScreenRef.current) {
          localScreenRef.current.srcObject = screenStream
        }
        screenStream.getTracks().forEach((t) => {
          localStreamRef.current?.addTrack(t)
          for (const pc of peersRef.current.values()) {
            pc.pc.addTrack(t, localStreamRef.current!)
          }
          t.onended = () => {
            setScreenSharing(false)
            setVoiceUsers((prev) =>
              prev.map((u) => u.id === user!.id ? { ...u, hasScreen: false } : u)
            )
            screenStreamRef.current = null
            if (localScreenRef.current) localScreenRef.current.srcObject = null
          }
        })
        setScreenSharing(true)
        setVoiceUsers((prev) =>
          prev.map((u) => u.id === user.id ? { ...u, hasScreen: true } : u)
        )
        await renegotiateAllPeers()
      } catch (err) {
        console.error('Failed to share screen:', err)
      }
    }
  }

  async function renegotiateAllPeers() {
    for (const [userId, pc] of peersRef.current) {
      try {
        const offer = await pc.createOffer()
        sendCallOffer(userId, channel.id, offer)
      } catch (err) {
        console.error(`Renegotiation failed for ${userId}:`, err)
      }
    }
  }

  // Build display tiles: screen shares become their own separate tiles
  const displayTiles: { tileId: string; userId: string; displayName: string; isSelf: boolean; speaking: boolean; type: 'user' | 'screen'; hasVideo: boolean }[] = []
  for (const vu of voiceUsers) {
    displayTiles.push({ tileId: vu.id, userId: vu.id, displayName: vu.displayName, isSelf: vu.isSelf, speaking: vu.speaking, type: 'user', hasVideo: vu.hasVideo })
    if (vu.hasScreen) {
      displayTiles.push({ tileId: `${vu.id}:screen`, userId: vu.id, displayName: vu.displayName, isSelf: vu.isSelf, speaking: false, type: 'screen', hasVideo: false })
    }
  }

  const hasFocused = focusedUser !== null && displayTiles.some((t) => t.tileId === focusedUser)
  const sortedTiles = hasFocused
    ? [displayTiles.find((t) => t.tileId === focusedUser)!, ...displayTiles.filter((t) => t.tileId !== focusedUser)]
    : displayTiles

  const handleTileClick = (tileId: string) => {
    setFocusedUser((prev) => prev === tileId ? null : tileId)
  }

  return (
    <div className="voice-channel">
      <div className="voice-header">
        <span className="voice-header-name">🔊 {channel.name}</span>
        {joined && <span className="voice-status connected">Connected</span>}
        {connecting && <span className="voice-status connecting">Connecting…</span>}
      </div>

      <div className={`voice-tile-grid ${hasFocused ? 'has-focused' : ''} count-${Math.min(displayTiles.length, 16)}`}>
        {voiceUsers.length === 0 && !joined && (
          <p className="voice-empty">No one is in this channel</p>
        )}
        {sortedTiles.map((tile) => {
          const remoteStream = remoteStreams.get(tile.userId)
          const isFocused = focusedUser === tile.tileId
          const isUnfocused = hasFocused && !isFocused

          if (tile.type === 'screen') {
            return (
              <div
                key={tile.tileId}
                className={`voice-tile has-media ${isFocused ? 'focused' : ''} ${isUnfocused ? 'unfocused' : ''}`}
                onClick={() => handleTileClick(tile.tileId)}
              >
                <div className="voice-tile-media">
                  <div className="voice-tile-video-pane screen-pane">
                    {tile.isSelf ? (
                      <video ref={(el) => {
                        localScreenRef.current = el
                        if (el && screenStreamRef.current && el.srcObject !== screenStreamRef.current) {
                          el.srcObject = screenStreamRef.current
                        }
                      }} autoPlay playsInline muted />
                    ) : remoteStream ? (
                      <video autoPlay playsInline ref={(el) => { if (el && el.srcObject !== remoteStream) el.srcObject = remoteStream }} />
                    ) : null}
                  </div>
                  <div className="voice-tile-overlay">
                    <span className="voice-tile-name">{tile.displayName}'s screen</span>
                  </div>
                </div>
              </div>
            )
          }

          return (
            <div
              key={tile.tileId}
              className={`voice-tile ${tile.speaking ? 'speaking' : ''} ${tile.isSelf ? 'is-self' : ''} ${muted && tile.isSelf ? 'is-muted' : ''} ${isFocused ? 'focused' : ''} ${isUnfocused ? 'unfocused' : ''} ${tile.hasVideo ? 'has-media' : ''}`}
              onClick={() => handleTileClick(tile.tileId)}
            >
              {tile.hasVideo ? (
                <div className="voice-tile-media">
                  <div className="voice-tile-video-pane camera-pane">
                    {tile.isSelf ? (
                      <video ref={(el) => {
                        localVideoRef.current = el
                        if (el && localStreamRef.current && el.srcObject !== localStreamRef.current) {
                          el.srcObject = localStreamRef.current
                        }
                      }} autoPlay playsInline muted />
                    ) : remoteStream ? (
                      <video autoPlay playsInline ref={(el) => { if (el && el.srcObject !== remoteStream) el.srcObject = remoteStream }} />
                    ) : null}
                  </div>
                  <div className="voice-tile-overlay">
                    <span className="voice-tile-name">
                      {tile.displayName}
                      {tile.isSelf && <span className="voice-tile-tag"> (you)</span>}
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <span className={`voice-tile-avatar ${tile.speaking ? 'speaking' : ''}`}>
                    {tile.displayName.charAt(0).toUpperCase()}
                  </span>
                  <span className="voice-tile-name">
                    {tile.displayName}
                    {tile.isSelf && <span className="voice-tile-tag"> (you)</span>}
                  </span>
                  <div className="voice-tile-badges">
                    {muted && tile.isSelf && <span className="voice-tile-badge muted" title="Muted">🔇</span>}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* Hidden container for remote audio elements */}
      <div ref={remoteAudioRef} style={{ display: 'none' }} />
    </div>
  )
})
