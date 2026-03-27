import { useEffect, useRef, useState } from 'react'
import type { WSMessage as WSMsg } from '../types'
import { useAuth } from '../context/AuthContext'
import { subscribe, sendCallOffer, sendCallAnswer, sendIceCandidate, sendCallEnd, sendCallRenegotiate } from '../services/ws'
import { PeerConnection } from '../services/webrtc'
import { playCallRing, playConnectedSound, playDisconnectedSound, playErrorSound } from '../services/sounds'
import { getSettings } from '../services/settings'

interface Props {
  targetUserId: string
  targetName: string
  channelId: string
  startWithVideo: boolean
  incomingOffer?: RTCSessionDescriptionInit
  onEnd: () => void
}

export default function DMCall({ targetUserId, targetName, channelId, startWithVideo, incomingOffer, onEnd }: Props) {
  const { user } = useAuth()
  const [connected, setConnected] = useState(false)
  const [muted, setMuted] = useState(false)
  const [videoOn, setVideoOn] = useState(startWithVideo)
  const [screenSharing, setScreenSharing] = useState(false)
  const [remoteScreening, setRemoteScreening] = useState(false)
  const [callState, setCallState] = useState<'calling' | 'connected'>('calling')
  const [isFullscreen, setIsFullscreen] = useState(false)

  const pcRef = useRef<PeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const remoteAudioRef = useRef<HTMLAudioElement>(null)
  const remoteScreenRef = useRef<HTMLVideoElement>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const connectedRef = useRef(false)
  const primaryStreamIdRef = useRef<string | null>(null)

  useEffect(() => {
    startCall(incomingOffer)
    return () => { cleanupCall() }
  }, [])

  // Fullscreen change listener
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current?.requestFullscreen()
    }
  }

  // Listen for signaling
  useEffect(() => {
    const unsub = subscribe((msg: WSMsg) => {
      const payload = msg.payload as {
        from_user_id?: string
        channel_id?: string
        signal?: RTCSessionDescriptionInit | RTCIceCandidateInit
      }

      if (payload.from_user_id !== targetUserId) return

      switch (msg.type) {
        case 'call_answer':
          handleAnswer(payload.signal as RTCSessionDescriptionInit)
          break
        case 'call_offer':
        case 'call_renegotiate':
          handleRemoteOffer(payload.signal as RTCSessionDescriptionInit)
          break
        case 'ice_candidate':
          handleIce(payload.signal as RTCIceCandidateInit)
          break
        case 'call_end':
          handleRemoteEnd()
          break
      }
    })
    return unsub
  }, [targetUserId])

  async function startCall(remoteOffer?: RTCSessionDescriptionInit) {
    try {
      const settings = getSettings()
      const audioConstraint: MediaTrackConstraints = {
        noiseSuppression: settings.noiseSuppression,
        echoCancellation: settings.echoCancellation,
        autoGainControl: settings.autoGainControl,
      }
      if (settings.audioInputDevice) {
        audioConstraint.deviceId = { exact: settings.audioInputDevice }
      }
      const videoConstraint: MediaTrackConstraints | boolean = (!remoteOffer && startWithVideo)
        ? (settings.videoDevice ? { deviceId: { exact: settings.videoDevice } } : true)
        : false

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraint,
        video: videoConstraint,
      })
      localStreamRef.current = stream

      if (!remoteOffer && startWithVideo && localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      const pc = new PeerConnection()
      pcRef.current = pc

      stream.getTracks().forEach((t) => pc.pc.addTrack(t, stream))

      pc.onIceCandidate = (candidate) => {
        sendIceCandidate(targetUserId, channelId, candidate)
      }

      pc.onRemoteStream = (remoteStream) => {
        const settings = getSettings()

        // Track primary stream (camera/audio) vs screen share
        if (!primaryStreamIdRef.current) {
          primaryStreamIdRef.current = remoteStream.id
        }

        if (remoteStream.id === primaryStreamIdRef.current) {
          // Primary stream — video + audio
          if (remoteStream.getVideoTracks().length > 0 && remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream
            remoteVideoRef.current.volume = settings.outputVolume / 100

            // Clear video element when remote camera is turned off to avoid freeze frame
            remoteStream.getVideoTracks().forEach(t => {
              t.addEventListener('ended', () => {
                if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
              })
            })
            remoteStream.addEventListener('removetrack', (ev) => {
              if (ev.track.kind === 'video' && remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = null
              }
            })
          }
          if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = remoteStream
            remoteAudioRef.current.volume = settings.outputVolume / 100
          }
        } else {
          // Screen share stream
          if (remoteScreenRef.current) {
            remoteScreenRef.current.srcObject = remoteStream
          }
          setRemoteScreening(true)

          const checkEnded = () => {
            if (remoteStream.getTracks().length === 0 || remoteStream.getTracks().every(t => t.readyState === 'ended')) {
              setRemoteScreening(false)
              if (remoteScreenRef.current) remoteScreenRef.current.srcObject = null
            }
          }
          remoteStream.addEventListener('removetrack', checkEnded)
          remoteStream.getTracks().forEach(t => t.addEventListener('ended', checkEnded))
        }

        if (!connectedRef.current) {
          connectedRef.current = true
          setConnected(true)
          setCallState('connected')
          playConnectedSound()
        }
      }

      if (remoteOffer) {
        // Receiver: answer the incoming offer
        const answer = await pc.handleOffer(remoteOffer)
        sendCallAnswer(targetUserId, channelId, answer)
      } else {
        // Caller: create and send offer
        const offer = await pc.createOffer()
        sendCallOffer(targetUserId, channelId, offer)
        playCallRing()
      }
    } catch (err) {
      console.error('Failed to start call:', err)
      playErrorSound()
      onEnd()
    }
  }

  async function handleAnswer(answer: RTCSessionDescriptionInit) {
    await pcRef.current?.handleAnswer(answer)
  }

  async function handleRemoteOffer(offer: RTCSessionDescriptionInit) {
    if (!pcRef.current) return
    try {
      const answer = await pcRef.current.handleOffer(offer)
      sendCallAnswer(targetUserId, channelId, answer)
    } catch {
      // If renegotiation fails, ignore
    }
  }

  async function handleIce(candidate: RTCIceCandidateInit) {
    await pcRef.current?.addIceCandidate(candidate)
  }

  function handleRemoteEnd() {
    cleanupCall()
    playDisconnectedSound()
    onEnd()
  }

  function cleanupCall() {
    sendCallEnd(targetUserId, channelId)
    pcRef.current?.close()
    pcRef.current = null
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    screenStreamRef.current?.getTracks().forEach((t) => t.stop())
    screenStreamRef.current = null
  }

  function endCall() {
    cleanupCall()
    playDisconnectedSound()
    onEnd()
  }

  function toggleMute() {
    const stream = localStreamRef.current
    if (!stream) return
    const next = !muted
    stream.getAudioTracks().forEach((t) => { t.enabled = !next })
    setMuted(next)
  }

  async function toggleVideo() {
    if (!user) return
    if (videoOn) {
      localStreamRef.current?.getVideoTracks().forEach((t) => {
        t.stop()
        localStreamRef.current?.removeTrack(t)
      })
      if (localVideoRef.current) localVideoRef.current.srcObject = null
      setVideoOn(false)
    } else {
      try {
        const settings = getSettings()
        const constraints: MediaStreamConstraints = {
          video: settings.videoDevice ? { deviceId: { exact: settings.videoDevice } } : true
        }
        const videoStream = await navigator.mediaDevices.getUserMedia(constraints)
        const videoTrack = videoStream.getVideoTracks()[0]
        if (videoTrack && localStreamRef.current && pcRef.current) {
          localStreamRef.current.addTrack(videoTrack)
          pcRef.current.pc.addTrack(videoTrack, localStreamRef.current)
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = new MediaStream([videoTrack])
          }
          // Renegotiate
          const offer = await pcRef.current.createOffer()
          sendCallRenegotiate(targetUserId, channelId, offer)
        }
        setVideoOn(true)
      } catch (err) {
        console.error('Failed to enable video:', err)
        playErrorSound()
      }
    }
  }

  async function toggleScreenShare() {
    if (!user) return
    if (screenSharing) {
      screenStreamRef.current?.getTracks().forEach((t) => {
        t.stop()
        if (pcRef.current) {
          const sender = pcRef.current.pc.getSenders().find(s => s.track === t)
          if (sender) pcRef.current.pc.removeTrack(sender)
        }
      })
      screenStreamRef.current = null
      setScreenSharing(false)
      // Renegotiate
      if (pcRef.current) {
        const offer = await pcRef.current.createOffer()
        sendCallRenegotiate(targetUserId, channelId, offer)
      }
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        screenStreamRef.current = screenStream
        screenStream.getTracks().forEach((t) => {
          // Add with screenStream as the stream param so remote gets a separate stream
          pcRef.current?.pc.addTrack(t, screenStream)
          t.onended = () => {
            if (pcRef.current) {
              const sender = pcRef.current.pc.getSenders().find(s => s.track === t)
              if (sender) pcRef.current.pc.removeTrack(sender)
            }
            setScreenSharing(false)
            screenStreamRef.current = null
            // Renegotiate
            if (pcRef.current) {
              pcRef.current.createOffer().then(offer => {
                sendCallRenegotiate(targetUserId, channelId, offer)
              })
            }
          }
        })
        setScreenSharing(true)
        // Renegotiate
        if (pcRef.current) {
          const offer = await pcRef.current.createOffer()
          sendCallRenegotiate(targetUserId, channelId, offer)
        }
      } catch {
        // User cancelled screen share picker
      }
    }
  }

  return (
    <div className="dm-call" ref={containerRef}>
      <div className="dm-call-header">
        <span className="dm-call-status">
          {callState === 'calling' ? `Calling ${targetName}...` : `In call with ${targetName}`}
        </span>
        {connected && (
          <button className="voice-fullscreen-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>
            {isFullscreen ? '⊠' : '⛶'}
          </button>
        )}
      </div>

      <div className="dm-call-media">
        <div className="dm-call-videos">
          {remoteScreening && (
            <div className="video-tile remote-screen">
              <video ref={remoteScreenRef} autoPlay playsInline />
              <span className="video-tile-name">{targetName}'s screen</span>
            </div>
          )}
          {connected && (
            <div className={`video-tile remote-video ${remoteScreening ? 'pip' : ''}`}>
              <video ref={remoteVideoRef} autoPlay playsInline />
              <span className="video-tile-name">{targetName}</span>
            </div>
          )}
          {videoOn && (
            <div className="video-tile self-video-small">
              <video ref={localVideoRef} autoPlay playsInline muted />
            </div>
          )}
        </div>
        <audio ref={remoteAudioRef} autoPlay />
      </div>

      <div className="dm-call-controls">
        <button
          className={`voice-ctrl-btn ${muted ? 'active' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🎙️'}
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
        <button className="voice-leave-btn" onClick={endCall} title="End Call">
          📞
        </button>
      </div>
    </div>
  )
}
