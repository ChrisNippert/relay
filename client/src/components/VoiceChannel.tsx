import { useEffect, useRef, useState } from 'react'
import type { Channel, WSMessage as WSMsg } from '../types'
import { useAuth } from '../context/AuthContext'
import { subscribe, sendCallOffer, sendCallAnswer, sendIceCandidate, sendCallEnd } from '../services/ws'
import { PeerConnection } from '../services/webrtc'
import * as api from '../services/api'
import { playJoinSound, playLeaveSound, playConnectedSound, playDisconnectedSound, playCallRing, playErrorSound } from '../services/sounds'
import { getSettings } from '../services/settings'

interface Props {
  channel: Channel
}

interface VoiceUser {
  id: string
  displayName: string
  isSelf: boolean
  hasVideo: boolean
  hasScreen: boolean
}

export default function VoiceChannel({ channel }: Props) {
  const { user } = useAuth()
  const [joined, setJoined] = useState(false)
  const [voiceUsers, setVoiceUsers] = useState<VoiceUser[]>([])
  const [muted, setMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [videoOn, setVideoOn] = useState(false)
  const [screenSharing, setScreenSharing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [members, setMembers] = useState<Map<string, string>>(new Map())

  const peersRef = useRef<Map<string, PeerConnection>>(new Map())
  const localStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const remoteMediaRef = useRef<HTMLDivElement>(null)

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

  const getName = (userId: string) => members.get(userId) ?? userId.slice(0, 8)

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
      setVoiceUsers([{ id: user.id, displayName: user.display_name, isSelf: true, hasVideo: false, hasScreen: false }])
      playJoinSound()

      if (channel.server_id) {
        const serverMembers = await api.getMembers(channel.server_id)
        for (const m of serverMembers) {
          if (m.user_id === user.id) continue
          await initiateCall(m.user_id, stream)
        }
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
        return [...prev, { id: targetUserId, displayName: name, isSelf: false, hasVideo: false, hasScreen: false }]
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
        return [...prev, { id: fromUserId, displayName: name, isSelf: false, hasVideo: false, hasScreen: false }]
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
    const el = document.getElementById(`remote-media-${userId}`)
    el?.remove()
    setVoiceUsers((prev) => prev.filter((u) => u.id !== userId))
    playLeaveSound()
  }

  function attachRemoteMedia(userId: string, stream: MediaStream) {
    const existingEl = document.getElementById(`remote-media-${userId}`)
    if (existingEl) existingEl.remove()

    const settings = getSettings()
    const hasVideoTrack = stream.getVideoTracks().length > 0

    if (hasVideoTrack) {
      const container = document.createElement('div')
      container.id = `remote-media-${userId}`
      container.className = 'video-tile'
      const video = document.createElement('video')
      video.srcObject = stream
      video.autoplay = true
      video.playsInline = true
      video.volume = settings.outputVolume / 100
      const nameLabel = document.createElement('span')
      nameLabel.className = 'video-tile-name'
      nameLabel.textContent = getName(userId)
      container.appendChild(video)
      container.appendChild(nameLabel)
      remoteMediaRef.current?.appendChild(container)

      setVoiceUsers((prev) =>
        prev.map((u) => u.id === userId ? { ...u, hasVideo: true } : u)
      )
    } else {
      const audio = document.createElement('audio')
      audio.id = `remote-media-${userId}`
      audio.srcObject = stream
      audio.autoplay = true
      audio.volume = settings.outputVolume / 100
      audio.setAttribute('playsinline', '')
      remoteMediaRef.current?.appendChild(audio)
    }

    // Set output device if supported
    if (settings.audioOutputDevice) {
      const el = document.getElementById(`remote-media-${userId}`)
      const mediaEl = el?.tagName === 'DIV' ? el.querySelector('video') : el
      if (mediaEl && 'setSinkId' in mediaEl) {
        (mediaEl as HTMLMediaElement & { setSinkId: (id: string) => Promise<void> })
          .setSinkId(settings.audioOutputDevice).catch(() => {})
      }
    }
  }

  function leaveVoice() {
    for (const [userId, pc] of peersRef.current) {
      sendCallEnd(userId, channel.id)
      pc.close()
    }
    peersRef.current.clear()

    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    screenStreamRef.current?.getTracks().forEach((t) => t.stop())
    screenStreamRef.current = null

    if (remoteMediaRef.current) remoteMediaRef.current.innerHTML = ''
    if (localVideoRef.current) localVideoRef.current.srcObject = null

    setJoined(false)
    setVoiceUsers([])
    setMuted(false)
    setDeafened(false)
    setVideoOn(false)
    setScreenSharing(false)
    playDisconnectedSound()
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
    if (remoteMediaRef.current) {
      const elems = remoteMediaRef.current.querySelectorAll('audio, video')
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
            localVideoRef.current.srcObject = new MediaStream([videoTrack])
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
      setScreenSharing(false)
      setVoiceUsers((prev) =>
        prev.map((u) => u.id === user.id ? { ...u, hasScreen: false } : u)
      )
      await renegotiateAllPeers()
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        screenStreamRef.current = screenStream
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

  const anyoneHasVideo = voiceUsers.some((u) => u.hasVideo || u.hasScreen)

  return (
    <div className="voice-channel">
      <div className="voice-header">
        <span className="voice-header-name">🔊 {channel.name}</span>
        {joined && <span className="voice-status connected">Connected</span>}
      </div>

      {/* Video grid */}
      {anyoneHasVideo && joined && (
        <div className="video-grid">
          {videoOn && (
            <div className="video-tile self-video">
              <video ref={localVideoRef} autoPlay playsInline muted />
              <span className="video-tile-name">{user?.display_name} (you)</span>
            </div>
          )}
        </div>
      )}

      <div className="voice-users">
        {voiceUsers.length === 0 && !joined && (
          <p className="voice-empty">No one is in this channel</p>
        )}
        {voiceUsers.map((vu) => (
          <div key={vu.id} className={`voice-user ${vu.isSelf ? 'self' : ''} ${muted && vu.isSelf ? 'muted' : ''}`}>
            <span className="voice-user-indicator">
              {muted && vu.isSelf ? '🔇' : '🎙️'}
              {vu.hasVideo ? ' 📷' : ''}
              {vu.hasScreen ? ' 🖥️' : ''}
            </span>
            <span className="voice-user-name">{vu.displayName}</span>
            {vu.isSelf && <span className="voice-user-tag">(you)</span>}
          </div>
        ))}
      </div>

      <div className="voice-controls">
        {!joined ? (
          <button className="voice-join-btn" onClick={joinVoice} disabled={connecting}>
            {connecting ? 'Connecting...' : 'Join Voice'}
          </button>
        ) : (
          <div className="voice-buttons">
            <button
              className={`voice-ctrl-btn ${muted ? 'active' : ''}`}
              onClick={toggleMute}
              title={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? '🔇' : '🎙️'}
            </button>
            <button
              className={`voice-ctrl-btn ${deafened ? 'active' : ''}`}
              onClick={toggleDeafen}
              title={deafened ? 'Undeafen' : 'Deafen'}
            >
              {deafened ? '🔈' : '🔊'}
            </button>
            <button
              className={`voice-ctrl-btn ${videoOn ? 'active' : ''}`}
              onClick={toggleVideo}
              title={videoOn ? 'Camera Off' : 'Camera On'}
            >
              📷
            </button>
            <button
              className={`voice-ctrl-btn ${screenSharing ? 'active' : ''}`}
              onClick={toggleScreenShare}
              title={screenSharing ? 'Stop Sharing' : 'Share Screen'}
            >
              🖥️
            </button>
            <button className="voice-leave-btn" onClick={leaveVoice} title="Disconnect">
              📞
            </button>
          </div>
        )}
      </div>

      {/* Container for remote media elements — visible when video is active */}
      <div
        ref={remoteMediaRef}
        className={anyoneHasVideo ? 'video-grid remote-grid' : ''}
        style={anyoneHasVideo ? {} : { display: 'none' }}
      />
    </div>
  )
}
