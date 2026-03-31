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

  constructor() {
    this.pc = new RTCPeerConnection(getICEConfig())

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.onIceCandidate?.(ev.candidate.toJSON())
      }
    }

    this.pc.ontrack = (ev) => {
      const stream = ev.streams[0]
      if (stream) {
        this.onRemoteStream?.(stream)
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

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer()
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
