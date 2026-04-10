// WebRTC wrapper for voice/video calls and screenshare

export interface CallOptions {
  audio: boolean
  video: boolean
  screen: boolean
}

const DEFAULT_ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

let cachedICEConfig: RTCConfiguration | null = null

export function setICEConfig(servers: { urls: string[]; username?: string; credential?: string }[]) {
  cachedICEConfig = {
    iceServers: servers.map(s => ({
      urls: s.urls,
      username: s.username,
      credential: s.credential,
    })),
  }
}

function getICEConfig(): RTCConfiguration {
  return cachedICEConfig ?? DEFAULT_ICE_CONFIG
}

export class PeerConnection {
  pc: RTCPeerConnection
  localStream: MediaStream | null = null
  onIceCandidate: ((candidate: RTCIceCandidateInit) => void) | null = null
  onRemoteStream: ((stream: MediaStream) => void) | null = null
  onDisconnected: (() => void) | null = null
  private _remoteStreams = new Map<string, MediaStream>()

  constructor() {
    this.pc = new RTCPeerConnection(getICEConfig())

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.onIceCandidate?.(ev.candidate.toJSON())
      }
    }

    this.pc.ontrack = (ev) => {
      if (ev.streams[0]) {
        // Browser properly associates tracks with streams — use it directly
        // Cache so we can detect new vs existing
        const streamId = ev.streams[0].id
        if (!this._remoteStreams.has(streamId)) {
          this._remoteStreams.set(streamId, ev.streams[0])
        }
        this.onRemoteStream?.(ev.streams[0])
      } else {
        // Firefox fallback: no stream association. Group by transceiver mid to
        // approximate stream grouping. video tracks without a stream get their own
        // stream. audio-only tracks also get their own to handle screen share audio.
        const stream = new MediaStream([ev.track])
        this.onRemoteStream?.(stream)
      }
    }

    // Monitor connection state and trigger recovery on failures
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState
      if (state === 'disconnected' || state === 'failed') {
        this.onDisconnected?.()
      }
    }
  }

  async startLocalStream(opts: CallOptions): Promise<MediaStream> {
    if (opts.screen) {
      this.localStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: opts.audio,
      })
    } else {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: opts.audio,
        video: opts.video,
      })
    }

    this.localStream.getTracks().forEach((track) => {
      this.pc.addTrack(track, this.localStream!)
    })

    return this.localStream
  }

  async createOffer(iceRestart = false): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer({ iceRestart })
    await this.pc.setLocalDescription(offer)
    return offer
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer))
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    return answer
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer))
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate))
  }

  close() {
    this.localStream?.getTracks().forEach((t) => t.stop())
    this.pc.close()
    this.localStream = null
  }
}
