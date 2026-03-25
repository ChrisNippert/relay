// Sound effects for UI events
// Uses short oscillator tones generated via Web Audio API — no external files needed.

let audioCtx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

function playTone(freq: number, duration: number, type: OscillatorType = 'sine', volume = 0.15) {
  const ctx = getCtx()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.value = volume
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + duration)
}

export function playJoinSound() {
  // Ascending two-tone chime
  playTone(440, 0.15, 'sine', 0.12)
  setTimeout(() => playTone(660, 0.2, 'sine', 0.12), 120)
}

export function playLeaveSound() {
  // Descending two-tone
  playTone(660, 0.15, 'sine', 0.1)
  setTimeout(() => playTone(440, 0.2, 'sine', 0.1), 120)
}

export function playMessageSound() {
  // Quick blip
  playTone(800, 0.08, 'sine', 0.08)
}

export function playCallRing() {
  // Phone-like ring, repeated
  playTone(523, 0.3, 'sine', 0.12)
  setTimeout(() => playTone(659, 0.3, 'sine', 0.12), 350)
}

export function playConnectedSound() {
  // Happy ascending triad
  playTone(523, 0.12, 'sine', 0.1)
  setTimeout(() => playTone(659, 0.12, 'sine', 0.1), 100)
  setTimeout(() => playTone(784, 0.2, 'sine', 0.1), 200)
}

export function playDisconnectedSound() {
  // Descending minor
  playTone(587, 0.12, 'sine', 0.1)
  setTimeout(() => playTone(466, 0.15, 'sine', 0.1), 100)
  setTimeout(() => playTone(392, 0.2, 'sine', 0.1), 200)
}

export function playErrorSound() {
  playTone(200, 0.3, 'square', 0.08)
}
