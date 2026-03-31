import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import type { Channel, WSMessage as WSMsg } from '../types'
import { useAuth } from '../context/AuthContext'
import { subscribe, sendCallOffer, sendCallAnswer, sendIceCandidate, sendCallEnd, sendCallRenegotiate, sendVoiceJoin, sendVoiceLeave, sendVoiceKick, sendVoiceSpeaking, sendVoiceMediaState } from '../services/ws'
import { PeerConnection } from '../services/webrtc'
import * as api from '../services/api'
import { playJoinSound, playLeaveSound, playConnectedSound, playDisconnectedSound, playCallRing, playErrorSound } from '../services/sounds'
import { getSettings, saveSettings } from '../services/settings'

interface Props {
  channel: Channel
  autoJoin?: boolean
  onJoin?: () => void
  onLeave?: () => void
  isAdmin?: boolean
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
  muted: boolean
  deafened: boolean
}

export default forwardRef<VoiceChannelHandle, Props>(function VoiceChannel({ channel, autoJoin, onJoin, onLeave, isAdmin }, ref) {
  const { user } = useAuth()
  const [joined, setJoined] = useState(false)
  const [voiceUsers, setVoiceUsers] = useState<VoiceUser[]>([])
  const [muted, setMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [videoOn, setVideoOn] = useState(false)
  const [screenSharing, setScreenSharing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [, setMembers] = useState<Map<string, string>>(new Map())
  const membersRef = useRef<Map<string, string>>(new Map())
  const [, setChannelVoiceUsers] = useState<string[]>([])
  const [, setLocalSpeaking] = useState(false)
  const [focusedUser, setFocusedUser] = useState<string | null>(null)
  const [watchingTiles, setWatchingTiles] = useState<Set<string>>(new Set())
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map())
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Map<string, MediaStream>>(new Map())
  const [isFullscreen, setIsFullscreen] = useState(false)

  const peersRef = useRef<Map<string, PeerConnection>>(new Map())
  const primaryStreamIds = useRef<Map<string, string>>(new Map())
  const localStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const localScreenRef = useRef<HTMLVideoElement>(null)
  const lastSpeakingRef = useRef(false)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const speakingAnimRef = useRef<number>(0)
  const kickedRef = useRef(false)
  const remoteVadRef = useRef<Map<string, { ctx: AudioContext; animId: number }>>(new Map())
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; userId: string; displayName: string; isSelf: boolean; tileId?: string } | null>(null)
  const [userVolumes, setUserVolumes] = useState<Record<string, number>>(() => getSettings().userVolumes || {})

  // Load server members for display names, or DM participants
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
        membersRef.current = names
        setMembers(names)
        // Update any existing voice users whose names were showing UIDs
        setVoiceUsers((prev) =>
          prev.map((u) => u.isSelf ? u : { ...u, displayName: names.get(u.id) ?? u.displayName })
        )
      }).catch(console.error)
    } else {
      // DM channel — resolve participants
      api.getDMParticipants(channel.id).then(async (ids: string[]) => {
        const names = new Map<string, string>()
        for (const id of ids) {
          try {
            const u = await api.getUser(id)
            names.set(id, u.display_name)
          } catch { /* skip */ }
        }
        membersRef.current = names
        setMembers(names)
        // Update any existing voice users whose names were showing UIDs
        setVoiceUsers((prev) =>
          prev.map((u) => u.isSelf ? u : { ...u, displayName: names.get(u.id) ?? u.displayName })
        )
      }).catch(console.error)
    }
  }, [channel.server_id, channel.id])

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
      } else if (msg.type === 'voice_kicked') {
        const payload = msg.payload as { channel_id: string }
        if (payload.channel_id === channel.id) {
          kickedRef.current = true
        }
      } else if (msg.type === 'voice_media_state') {
        const payload = msg.payload as { channel_id: string; user_id: string; muted: boolean; deafened: boolean; video_on: boolean; screen_sharing: boolean }
        if (payload.channel_id === channel.id) {
          setVoiceUsers((prev) =>
            prev.map((u) => u.id === payload.user_id ? { ...u, muted: payload.muted, deafened: payload.deafened } : u)
          )
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
        case 'call_renegotiate':
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

  const getName = useCallback((userId: string) => {
    const cached = membersRef.current.get(userId)
    if (cached) return cached
    // Kick off async fetch to resolve the name — will update voiceUsers when it resolves
    api.getUser(userId).then((u) => {
      membersRef.current.set(userId, u.display_name)
      setMembers(new Map(membersRef.current))
      setVoiceUsers((prev) =>
        prev.map((vu) => vu.id === userId ? { ...vu, displayName: u.display_name } : vu)
      )
    }).catch(() => {})
    return userId.slice(0, 8)
  }, [])

  // Fullscreen change listener
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  // Apply audio processing settings (noiseSuppression, echoCancellation, autoGainControl) live
  useEffect(() => {
    if (!joined) return
    const applySettings = () => {
      const track = localStreamRef.current?.getAudioTracks()[0]
      if (!track) return
      const settings = getSettings()
      track.applyConstraints({
        noiseSuppression: settings.noiseSuppression,
        echoCancellation: settings.echoCancellation,
        autoGainControl: settings.autoGainControl,
      }).catch(() => {})
    }
    window.addEventListener('media-settings-changed', applySettings)
    return () => window.removeEventListener('media-settings-changed', applySettings)
  }, [joined])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current?.requestFullscreen()
    }
  }

  // Voice activity detection for local mic + noise gate
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

      // Set up noise gate: source -> gain -> destination (replaces track)
      const settings = getSettings()
      if (settings.noiseGateEnabled) {
        const gain = ctx.createGain()
        gain.gain.value = 1
        gainNodeRef.current = gain
        source.connect(gain)
        const dest = ctx.createMediaStreamDestination()
        gain.connect(dest)
        // Replace the audio track in the stream and all peer connections
        const gatedTrack = dest.stream.getAudioTracks()[0]
        if (gatedTrack) {
          const originalTrack = stream.getAudioTracks()[0]
          if (originalTrack) {
            stream.removeTrack(originalTrack)
            stream.addTrack(gatedTrack)
            // Update senders in existing peer connections
            for (const pc of peersRef.current.values()) {
              const sender = pc.pc.getSenders().find(s => s.track === originalTrack)
              if (sender) sender.replaceTrack(gatedTrack)
            }
          }
        }
      }

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const check = () => {
        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]!
        const avg = sum / dataArray.length
        const curSettings = getSettings()
        const threshold = curSettings.noiseGateEnabled ? curSettings.noiseGateThreshold : 15
        const isSpeaking = avg > threshold

        // Apply noise gate
        if (curSettings.noiseGateEnabled && gainNodeRef.current) {
          gainNodeRef.current.gain.setTargetAtTime(isSpeaking ? 1 : 0, audioContextRef.current!.currentTime, 0.01)
        }

        setLocalSpeaking(isSpeaking)
        setVoiceUsers((prev) =>
          prev.map((u) => u.isSelf ? { ...u, speaking: isSpeaking } : u)
        )
        // Broadcast speaking state changes to other users
        if (isSpeaking !== lastSpeakingRef.current) {
          lastSpeakingRef.current = isSpeaking
          sendVoiceSpeaking(channel.id, isSpeaking)
        }
        speakingAnimRef.current = requestAnimationFrame(check)
      }
      check()
    } catch { /* AudioContext not supported */ }
  }

  function stopVoiceActivityDetection() {
    cancelAnimationFrame(speakingAnimRef.current)
    analyserRef.current = null
    gainNodeRef.current = null
    audioContextRef.current?.close()
    audioContextRef.current = null
    setLocalSpeaking(false)
  }

  function startRemoteVAD(userId: string, stream: MediaStream) {
    // Don't double-track the same user
    if (remoteVadRef.current.has(userId)) return
    try {
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.4
      source.connect(analyser)
      const dataArray = new Uint8Array(analyser.frequencyBinCount)

      const check = () => {
        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]!
        const avg = sum / dataArray.length
        const isSpeaking = avg > 15
        setVoiceUsers((prev) =>
          prev.map((u) => u.id === userId ? { ...u, speaking: isSpeaking } : u)
        )
        const entry = remoteVadRef.current.get(userId)
        if (entry) entry.animId = requestAnimationFrame(check)
      }
      const animId = requestAnimationFrame(check)
      remoteVadRef.current.set(userId, { ctx, animId })
    } catch { /* AudioContext not supported */ }
  }

  function stopRemoteVAD(userId: string) {
    const entry = remoteVadRef.current.get(userId)
    if (entry) {
      cancelAnimationFrame(entry.animId)
      entry.ctx.close()
      remoteVadRef.current.delete(userId)
    }
  }

  function stopAllRemoteVAD() {
    for (const [userId] of remoteVadRef.current) {
      stopRemoteVAD(userId)
    }
  }

  function getAudioConstraints(): MediaTrackConstraints | boolean {
    const settings = getSettings()
    const constraints: MediaTrackConstraints = {
      noiseSuppression: settings.noiseSuppression,
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
      channelCount: settings.channelCount,
    }
    if (settings.audioInputDevice) {
      constraints.deviceId = { exact: settings.audioInputDevice }
    }
    return constraints
  }

  async function joinVoice() {
    if (!user) return
    setConnecting(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: getAudioConstraints(), video: false })
      localStreamRef.current = stream
      setJoined(true)
      setVoiceUsers([{ id: user.id, displayName: user.display_name, isSelf: true, hasVideo: false, hasScreen: false, speaking: false, muted: false, deafened: false }])
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

    // Also add screen share tracks if currently sharing
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => pc.pc.addTrack(track, screenStreamRef.current!))
    }

    pc.onIceCandidate = (candidate) => {
      sendIceCandidate(targetUserId, channel.id, candidate)
    }

    pc.onRemoteStream = (remoteStream) => {
      attachRemoteMedia(targetUserId, remoteStream)
      const name = getName(targetUserId)
      setVoiceUsers((prev) => {
        if (prev.some((u) => u.id === targetUserId)) return prev
        playConnectedSound()
        return [...prev, { id: targetUserId, displayName: name, isSelf: false, hasVideo: false, hasScreen: false, speaking: false, muted: false, deafened: false }]
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

    // Also add screen share tracks if currently sharing
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => pc.pc.addTrack(track, screenStreamRef.current!))
    }

    pc.onIceCandidate = (candidate) => {
      sendIceCandidate(fromUserId, channel.id, candidate)
    }

    pc.onRemoteStream = (remoteStream) => {
      attachRemoteMedia(fromUserId, remoteStream)
      const name = getName(fromUserId)
      setVoiceUsers((prev) => {
        if (prev.some((u) => u.id === fromUserId)) return prev
        playConnectedSound()
        return [...prev, { id: fromUserId, displayName: name, isSelf: false, hasVideo: false, hasScreen: false, speaking: false, muted: false, deafened: false }]
      })
    }

    const answer = await pc.handleOffer(offer)
    sendCallAnswer(fromUserId, channel.id, answer)
    playCallRing()

    // If we have video or screen share, the initial answer may not include them.
    // Renegotiate so the new peer receives our extra tracks.
    const hasExtraTracks = (localStreamRef.current?.getVideoTracks().length ?? 0) > 0 || screenStreamRef.current
    if (hasExtraTracks) {
      setTimeout(async () => {
        try {
          const reoffer = await pc.createOffer()
          sendCallRenegotiate(fromUserId, channel.id, reoffer)
        } catch { /* ignore */ }
      }, 500)
    }
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
    stopRemoteVAD(userId)
    const el = document.getElementById(`remote-audio-${userId}`)
    el?.remove()
    const screenAudioEl = document.getElementById(`remote-screen-audio-${userId}`)
    screenAudioEl?.remove()
    primaryStreamIds.current.delete(userId)
    setRemoteStreams((prev) => {
      const next = new Map(prev)
      next.delete(userId)
      return next
    })
    setRemoteScreenStreams((prev) => {
      const next = new Map(prev)
      next.delete(userId)
      return next
    })
    // Clean up watching state for this user
    setWatchingTiles((prev) => {
      const next = new Set(prev)
      next.delete(userId)
      next.delete(userId + '-cam')
      next.delete(userId + '-screen')
      return next
    })
    setVoiceUsers((prev) => prev.filter((u) => u.id !== userId))
    playLeaveSound()
  }

  function attachRemoteMedia(userId: string, stream: MediaStream) {
    // Track first stream per user as primary (camera/audio)
    if (!primaryStreamIds.current.has(userId)) {
      primaryStreamIds.current.set(userId, stream.id)
    }

    const isPrimary = stream.id === primaryStreamIds.current.get(userId)

    if (isPrimary) {
      const liveVideoTracks = stream.getVideoTracks().filter(t => t.readyState === 'live')
      if (liveVideoTracks.length > 0) {
        // Create a new MediaStream wrapper so React detects a new object for srcObject
        const videoStream = new MediaStream([...liveVideoTracks, ...stream.getAudioTracks()])
        setRemoteStreams((prev) => {
          const next = new Map(prev)
          next.set(userId, videoStream)
          return next
        })
        setVoiceUsers((prev) =>
          prev.map((u) => u.id === userId ? { ...u, hasVideo: true } : u)
        )

        const clearVideo = () => {
          setRemoteStreams((prev) => {
            const next = new Map(prev)
            next.delete(userId)
            return next
          })
          setVoiceUsers((prev) =>
            prev.map((u) => u.id === userId ? { ...u, hasVideo: false } : u)
          )
        }

        // Detect when remote video tracks end or are muted (camera turned off)
        liveVideoTracks.forEach(t => {
          t.addEventListener('ended', clearVideo)
          t.addEventListener('mute', clearVideo)
        })
      } else {
        // No live video tracks — clear any existing video (e.g. after renegotiation when camera was turned off)
        setRemoteStreams((prev) => {
          const next = new Map(prev)
          next.delete(userId)
          return next
        })
        setVoiceUsers((prev) =>
          prev.map((u) => u.id === userId ? { ...u, hasVideo: false } : u)
        )
      }

      // Listen for track removal on the primary stream (handles sender removing tracks via renegotiation)
      stream.addEventListener('removetrack', () => {
        const remainingVideoTracks = stream.getVideoTracks().filter(t => t.readyState === 'live')
        if (remainingVideoTracks.length === 0) {
          setRemoteStreams((prev) => {
            const next = new Map(prev)
            next.delete(userId)
            return next
          })
          setVoiceUsers((prev) =>
            prev.map((u) => u.id === userId ? { ...u, hasVideo: false } : u)
          )
        }
      })

      // Start remote voice activity detection
      if (stream.getAudioTracks().length > 0) {
        startRemoteVAD(userId, stream)
      }

      // Set up audio element
      const existingEl = document.getElementById(`remote-audio-${userId}`)
      if (existingEl) existingEl.remove()

      const settings = getSettings()
      const audio = document.createElement('audio')
      audio.id = `remote-audio-${userId}`
      audio.srcObject = stream
      audio.autoplay = true
      const userVol = settings.userVolumes?.[userId] ?? 100
      audio.volume = Math.min((userVol / 100) * (settings.outputVolume / 100), 1)
      audio.setAttribute('playsinline', '')
      remoteAudioRef.current?.appendChild(audio)

      if (settings.audioOutputDevice && 'setSinkId' in audio) {
        (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
          .setSinkId(settings.audioOutputDevice).catch(() => {})
      }
    } else {
      // Screen share stream from remote peer
      setRemoteScreenStreams((prev) => {
        const next = new Map(prev)
        next.set(userId, stream)
        return next
      })
      setVoiceUsers((prev) =>
        prev.map((u) => u.id === userId ? { ...u, hasScreen: true } : u)
      )

      // Play screen share audio if present
      if (stream.getAudioTracks().length > 0) {
        const existingScreenAudio = document.getElementById(`remote-screen-audio-${userId}`)
        if (existingScreenAudio) existingScreenAudio.remove()
        const settings = getSettings()
        const screenAudio = document.createElement('audio')
        screenAudio.id = `remote-screen-audio-${userId}`
        screenAudio.srcObject = stream
        screenAudio.autoplay = true
        const userVol = settings.userVolumes?.[userId] ?? 100
        screenAudio.volume = Math.min((userVol / 100) * (settings.outputVolume / 100), 1)
        screenAudio.setAttribute('playsinline', '')
        remoteAudioRef.current?.appendChild(screenAudio)
        if (settings.audioOutputDevice && 'setSinkId' in screenAudio) {
          (screenAudio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
            .setSinkId(settings.audioOutputDevice).catch(() => {})
        }
      }

      // Detect when screen share tracks end
      const checkEnded = () => {
        if (stream.getTracks().length === 0 || stream.getTracks().every(t => t.readyState === 'ended')) {
          setRemoteScreenStreams((prev) => {
            const next = new Map(prev)
            next.delete(userId)
            return next
          })
          setVoiceUsers((prev) =>
            prev.map((u) => u.id === userId ? { ...u, hasScreen: false } : u)
          )
          const screenAudioEl = document.getElementById(`remote-screen-audio-${userId}`)
          screenAudioEl?.remove()
        }
      }
      stream.addEventListener('removetrack', checkEnded)
      stream.getTracks().forEach(t => t.addEventListener('ended', checkEnded))
    }
  }

  function leaveVoice() {
    for (const [userId, pc] of peersRef.current) {
      sendCallEnd(userId, channel.id)
      pc.close()
    }
    peersRef.current.clear()

    stopVoiceActivityDetection()
    stopAllRemoteVAD()

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
    setRemoteScreenStreams(new Map())
    primaryStreamIds.current.clear()
    setMuted(false)
    setDeafened(false)
    setVideoOn(false)
    setScreenSharing(false)
    playDisconnectedSound()
    onLeave?.()
  }

  // Handle being kicked from voice
  useEffect(() => {
    if (!joined) return
    const interval = setInterval(() => {
      if (kickedRef.current) {
        kickedRef.current = false
        leaveVoice()
      }
    }, 200)
    return () => clearInterval(interval)
  }, [joined])

  function broadcastMediaState(overrides: { muted?: boolean; deafened?: boolean; videoOn?: boolean; screenSharing?: boolean } = {}) {
    sendVoiceMediaState(channel.id, {
      muted: overrides.muted ?? muted,
      deafened: overrides.deafened ?? deafened,
      videoOn: overrides.videoOn ?? videoOn,
      screenSharing: overrides.screenSharing ?? screenSharing,
    })
  }

  function toggleMute() {
    const stream = localStreamRef.current
    if (!stream) return
    const newMuted = !muted
    stream.getAudioTracks().forEach((t) => { t.enabled = !newMuted })
    setMuted(newMuted)
    broadcastMediaState({ muted: newMuted })
  }

  function toggleDeafen() {
    const newDeafened = !deafened
    if (remoteAudioRef.current) {
      const elems = remoteAudioRef.current.querySelectorAll('audio, video')
      elems.forEach((a) => { (a as HTMLMediaElement).muted = newDeafened })
    }
    setDeafened(newDeafened)
    broadcastMediaState({ deafened: newDeafened })
  }

  async function toggleVideo() {
    if (!user || !joined) return
    if (videoOn) {
      localStreamRef.current?.getVideoTracks().forEach((t) => {
        t.stop()
        localStreamRef.current?.removeTrack(t)
        // Remove senders from all peer connections so remote tracks properly end
        for (const pc of peersRef.current.values()) {
          const sender = pc.pc.getSenders().find(s => s.track === t)
          if (sender) pc.pc.removeTrack(sender)
        }
      })
      if (localVideoRef.current) localVideoRef.current.srcObject = null
      setVideoOn(false)
      setVoiceUsers((prev) =>
        prev.map((u) => u.id === user.id ? { ...u, hasVideo: false } : u)
      )
      broadcastMediaState({ videoOn: false })
      await renegotiateAllPeers()
    } else {
      try {
        const settings = getSettings()
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: settings.videoDevice ? { deviceId: { exact: settings.videoDevice } } : true
        }
        const videoStream = await navigator.mediaDevices.getUserMedia(constraints)
        // Stop any audio tracks that may have been captured
        videoStream.getAudioTracks().forEach((t) => t.stop())
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
        broadcastMediaState({ videoOn: true })
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
        // Remove senders from all peer connections
        for (const pc of peersRef.current.values()) {
          const sender = pc.pc.getSenders().find(s => s.track === t)
          if (sender) pc.pc.removeTrack(sender)
        }
      })
      screenStreamRef.current = null
      if (localScreenRef.current) localScreenRef.current.srcObject = null
      setScreenSharing(false)
      setVoiceUsers((prev) =>
        prev.map((u) => u.id === user.id ? { ...u, hasScreen: false } : u)
      )
      broadcastMediaState({ screenSharing: false })
      await renegotiateAllPeers()
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        screenStreamRef.current = screenStream
        if (localScreenRef.current) {
          localScreenRef.current.srcObject = screenStream
        }
        screenStream.getTracks().forEach((t) => {
          // Add to peer connections with screenStream (not localStream) so remote gets a separate stream
          for (const pc of peersRef.current.values()) {
            pc.pc.addTrack(t, screenStream)
          }
          t.onended = () => {
            // Remove senders from all peer connections
            for (const pc of peersRef.current.values()) {
              const sender = pc.pc.getSenders().find(s => s.track === t)
              if (sender) pc.pc.removeTrack(sender)
            }
            setScreenSharing(false)
            setVoiceUsers((prev) =>
              prev.map((u) => u.id === user!.id ? { ...u, hasScreen: false } : u)
            )
            screenStreamRef.current = null
            if (localScreenRef.current) localScreenRef.current.srcObject = null
            broadcastMediaState({ screenSharing: false })
            renegotiateAllPeers()
          }
        })
        setScreenSharing(true)
        setVoiceUsers((prev) =>
          prev.map((u) => u.id === user.id ? { ...u, hasScreen: true } : u)
        )
        broadcastMediaState({ screenSharing: true })
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
        sendCallRenegotiate(userId, channel.id, offer)
      } catch (err) {
        console.error(`Renegotiation failed for ${userId}:`, err)
      }
    }
  }

  // Build display tiles: separate tiles for camera and screen
  const displayTiles: { tileId: string; userId: string; displayName: string; isSelf: boolean; speaking: boolean; type: 'user' | 'screen'; hasVideo: boolean; hasScreen: boolean }[] = []
  for (const vu of voiceUsers) {
    if (vu.hasScreen && vu.hasVideo) {
      // Two separate tiles: one for camera, one for screen
      displayTiles.push({ tileId: vu.id + '-cam', userId: vu.id, displayName: vu.displayName, isSelf: vu.isSelf, speaking: vu.speaking, type: 'user', hasVideo: true, hasScreen: false })
      displayTiles.push({ tileId: vu.id + '-screen', userId: vu.id, displayName: vu.displayName + ' (Screen)', isSelf: vu.isSelf, speaking: false, type: 'screen', hasVideo: false, hasScreen: true })
      // Migrate watching: if user was watching the base tileId, auto-watch both split tiles
      if (watchingTiles.has(vu.id) && (!watchingTiles.has(vu.id + '-cam') || !watchingTiles.has(vu.id + '-screen'))) {
        setWatchingTiles((prev) => {
          const next = new Set(prev)
          next.delete(vu.id)
          next.add(vu.id + '-cam')
          next.add(vu.id + '-screen')
          return next
        })
      }
    } else if (vu.hasScreen) {
      displayTiles.push({ tileId: vu.id, userId: vu.id, displayName: vu.displayName, isSelf: vu.isSelf, speaking: vu.speaking, type: 'screen', hasVideo: false, hasScreen: true })
      // Migrate: if split tiles exist from when user had both, merge back to base
      if (watchingTiles.has(vu.id + '-screen') && !watchingTiles.has(vu.id)) {
        setWatchingTiles((prev) => {
          const next = new Set(prev)
          next.delete(vu.id + '-cam')
          next.delete(vu.id + '-screen')
          next.add(vu.id)
          return next
        })
      }
    } else {
      displayTiles.push({ tileId: vu.id, userId: vu.id, displayName: vu.displayName, isSelf: vu.isSelf, speaking: vu.speaking, type: 'user', hasVideo: vu.hasVideo, hasScreen: false })
      // Clean up stale watching entries when user no longer has media
      if (!vu.hasVideo && !vu.hasScreen) {
        if (watchingTiles.has(vu.id) || watchingTiles.has(vu.id + '-cam') || watchingTiles.has(vu.id + '-screen')) {
          setWatchingTiles((prev) => {
            const next = new Set(prev)
            next.delete(vu.id)
            next.delete(vu.id + '-cam')
            next.delete(vu.id + '-screen')
            return next
          })
        }
      }
    }
  }

  const hasFocused = focusedUser !== null && displayTiles.some((t) => t.tileId === focusedUser)
  const sortedTiles = hasFocused
    ? [displayTiles.find((t) => t.tileId === focusedUser)!, ...displayTiles.filter((t) => t.tileId !== focusedUser)]
    : displayTiles

  const handleTileClick = (tileId: string) => {
    setFocusedUser((prev) => prev === tileId ? null : tileId)
  }

  const handleTileContextMenu = (e: React.MouseEvent, tile: typeof displayTiles[0]) => {
    if (tile.isSelf) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, userId: tile.userId, displayName: tile.displayName, isSelf: false, tileId: tile.tileId })
  }

  const handleVoiceKick = () => {
    if (!contextMenu) return
    sendVoiceKick(channel.id, contextMenu.userId)
    setContextMenu(null)
  }

  const handleUserVolumeChange = (userId: string, volume: number) => {
    setUserVolumes((prev) => {
      const next = { ...prev, [userId]: volume }
      const settings = getSettings()
      saveSettings({ ...settings, userVolumes: next })
      return next
    })
    const effectiveVol = Math.min((volume / 100) * (getSettings().outputVolume / 100), 1)
    const el = document.getElementById(`remote-audio-${userId}`) as HTMLAudioElement | null
    if (el) el.volume = effectiveVol
    const screenEl = document.getElementById(`remote-screen-audio-${userId}`) as HTMLAudioElement | null
    if (screenEl) screenEl.volume = effectiveVol
  }

  const renderTile = (tile: typeof displayTiles[0], isFocused: boolean, isUnfocused: boolean) => {
    const remoteStream = remoteStreams.get(tile.userId)
    const remoteScreen = remoteScreenStreams.get(tile.userId)
    const hasMedia = tile.hasVideo || tile.hasScreen
    const isWatching = tile.isSelf || !hasMedia || watchingTiles.has(tile.tileId)

    const vu = voiceUsers.find(u => u.id === tile.userId)
    const isMuted = tile.isSelf ? muted : vu?.muted
    const isDeafened = tile.isSelf ? deafened : vu?.deafened
    const badges = (
      <div className="voice-tile-badges">
        {isMuted && <span className="voice-tile-badge muted" title="Muted">🔇</span>}
        {isDeafened && <span className="voice-tile-badge deafened" title="Deafened">🔈</span>}
      </div>
    )

    // Non-self media tile that hasn't been opted into yet
    if (hasMedia && !isWatching) {
      return (
        <div
          key={tile.tileId}
          className={`voice-tile has-media ${isFocused ? 'focused' : ''} ${isUnfocused ? 'unfocused' : ''}`}
          onClick={() => setWatchingTiles((prev) => new Set(prev).add(tile.tileId))}
          onContextMenu={(e) => handleTileContextMenu(e, tile)}
        >
          <div className="voice-tile-media voice-tile-unwatched">
            <span className="voice-tile-avatar">{tile.displayName.charAt(0).toUpperCase()}</span>
            <span className="voice-tile-watch-label">{tile.type === 'screen' ? '🖥️ Click to watch screen' : '📷 Click to watch video'}</span>
            <div className="voice-tile-overlay">
              <span className="voice-tile-name">{tile.displayName}</span>
              {badges}
            </div>
          </div>
        </div>
      )
    }

    if (tile.type === 'screen') {
      return (
        <div
          key={tile.tileId}
          className={`voice-tile has-media ${isFocused ? 'focused' : ''} ${isUnfocused ? 'unfocused' : ''}`}
          onClick={() => handleTileClick(tile.tileId)}
          onContextMenu={(e) => handleTileContextMenu(e, tile)}
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
              ) : remoteScreen ? (
                <video autoPlay playsInline muted ref={(el) => { if (el && el.srcObject !== remoteScreen) el.srcObject = remoteScreen }} />
              ) : null}
            </div>
            <div className="voice-tile-overlay">
              <span className="voice-tile-name">{tile.displayName}'s screen</span>
              {badges}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div
        key={tile.tileId}
        className={`voice-tile ${tile.speaking ? 'speaking' : ''} ${tile.isSelf ? 'is-self' : ''} ${muted && tile.isSelf ? 'is-muted' : ''} ${isFocused ? 'focused' : ''} ${isUnfocused ? 'unfocused' : ''} ${(tile.hasVideo || tile.hasScreen) ? 'has-media' : ''}`}
        onClick={() => handleTileClick(tile.tileId)}
        onContextMenu={(e) => handleTileContextMenu(e, tile)}
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
                <video autoPlay playsInline muted ref={(el) => { if (el && el.srcObject !== remoteStream) el.srcObject = remoteStream }} />
              ) : null}
            </div>
            <div className="voice-tile-overlay">
              <span className="voice-tile-name">
                {tile.displayName}
                {tile.isSelf && <span className="voice-tile-tag"> (you)</span>}
              </span>
              {badges}
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
            {badges}
          </>
        )}
      </div>
    )
  }

  const focusedTile = hasFocused ? sortedTiles[0] : null
  const unfocusedTiles = hasFocused ? sortedTiles.slice(1) : []

  return (
    <div className="voice-channel" ref={containerRef}>
      <div className="voice-header">
        <span className="voice-header-name">🔊 {channel.name}</span>
        {joined && <span className="voice-status connected">Connected</span>}
        {connecting && <span className="voice-status connecting">Connecting…</span>}
        {joined && (
          <button className="voice-fullscreen-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>
            {isFullscreen ? '⊠' : '⛶'}
          </button>
        )}
      </div>

      {hasFocused ? (
        <div className="voice-tile-grid focused-layout">
          <div className="voice-focused-main">
            {focusedTile && renderTile(focusedTile, true, false)}
          </div>
          {unfocusedTiles.length > 0 && (
            <div className="voice-focused-sidebar">
              {unfocusedTiles.map((t) => renderTile(t, false, true))}
            </div>
          )}
        </div>
      ) : (
        <div className={`voice-tile-grid count-${Math.min(displayTiles.length, 16)}`}>
          {voiceUsers.length === 0 && !joined && (
            <p className="voice-empty">No one is in this channel</p>
          )}
          {sortedTiles.map((t) => renderTile(t, false, false))}
        </div>
      )}

      {/* Hidden container for remote audio elements */}
      <div ref={remoteAudioRef} style={{ display: 'none' }} />

      {/* Voice context menu */}
      {contextMenu && (
        <div className="voice-context-menu-overlay" onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null) }}>
          <div className="voice-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
            <div className="voice-context-menu-header">{contextMenu.displayName}</div>
            <div className="voice-context-menu-item volume-control">
              <label>
                <span>Volume</span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={userVolumes[contextMenu.userId] ?? 100}
                  onChange={(e) => handleUserVolumeChange(contextMenu.userId, Number(e.target.value))}
                />
                <span className="volume-value">{userVolumes[contextMenu.userId] ?? 100}%</span>
              </label>
            </div>
            {contextMenu.tileId && watchingTiles.has(contextMenu.tileId) && (
              <button className="voice-context-menu-item" onClick={() => {
                setWatchingTiles((prev) => {
                  const next = new Set(prev)
                  if (contextMenu.tileId) next.delete(contextMenu.tileId)
                  return next
                })
                setContextMenu(null)
              }}>
                Stop Watching
              </button>
            )}
            {isAdmin && !contextMenu.isSelf && (
              <button className="voice-context-menu-item kick" onClick={handleVoiceKick}>
                Kick from Voice
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
