// WebRTC wrapper for voice/video calls and screenshare

export interface CallOptions {
  audio: boolean
  video: boolean
  screen: boolean
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

export class PeerConnection {
  pc: RTCPeerConnection
  localStream: MediaStream | null = null
  remoteStream: MediaStream = new MediaStream()
  onIceCandidate: ((candidate: RTCIceCandidateInit) => void) | null = null
  onRemoteStream: ((stream: MediaStream) => void) | null = null

  constructor() {
    this.pc = new RTCPeerConnection(ICE_SERVERS)

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.onIceCandidate?.(ev.candidate.toJSON())
      }
    }

    this.pc.ontrack = (ev) => {
      ev.streams[0]?.getTracks().forEach((track) => {
        this.remoteStream.addTrack(track)
      })
      this.onRemoteStream?.(this.remoteStream)
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
