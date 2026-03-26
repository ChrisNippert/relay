// Audio/video device settings with localStorage persistence

export interface MediaSettings {
  audioInputDevice: string   // deviceId
  audioOutputDevice: string  // deviceId
  videoDevice: string        // deviceId
  inputVolume: number        // 0-100
  outputVolume: number       // 0-100
}

const STORAGE_KEY = 'relay_media_settings'

const defaults: MediaSettings = {
  audioInputDevice: '',
  audioOutputDevice: '',
  videoDevice: '',
  inputVolume: 100,
  outputVolume: 100,
}

export function getSettings(): MediaSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaults, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...defaults }
}

export function saveSettings(s: MediaSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

export async function getDevices() {
  // Only request audio permission for device labels — no camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
  } catch { /* no devices accessible */ }

  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    audioInputs: devices.filter((d) => d.kind === 'audioinput'),
    audioOutputs: devices.filter((d) => d.kind === 'audiooutput'),
    videoInputs: devices.filter((d) => d.kind === 'videoinput'),
  }
}
