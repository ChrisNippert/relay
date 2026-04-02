// Audio/video device settings with localStorage persistence

export interface MediaSettings {
  audioInputDevice: string   // deviceId
  audioOutputDevice: string  // deviceId
  videoDevice: string        // deviceId
  inputVolume: number        // 0-100
  outputVolume: number       // 0-100
  noiseSuppression: boolean  // browser-level noise suppression
  echoCancellation: boolean  // browser-level echo cancellation
  autoGainControl: boolean   // browser-level auto gain control
  channelCount: 1 | 2        // 1 = mono, 2 = stereo
  noiseGateEnabled: boolean  // client-side noise gate
  noiseGateThreshold: number // 0-100 noise gate threshold
  noiseGateHold: number      // ms to hold gate open after speech stops (50-1000)
  noiseGateAttack: number    // ms attack time (1-100)
  noiseGateRelease: number   // ms release time (10-500)
  highpassFreq: number       // legacy — unused
  lowpassFreq: number        // legacy — unused
  eqBands: { freq: number; gain: number; type: 'peaking' | 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf' }[]
  userVolumes: Record<string, number>  // per-user volume overrides (userId -> 0-200)
  audioChainOrder: string[]     // order of audio processing nodes ['eq', 'noisegate']
  screenShareResolution: number // 0 = native, 360, 480, 720, 1080, 1440
  screenShareFramerate: number  // 15, 30, 60, 120
  screenShareMaxBitrate: number // 0 = auto, in kbps (e.g. 2500, 5000, 8000, 15000)
  // Notification settings
  notifyMessages: boolean    // play sound on new messages
  notifyMentions: boolean    // play sound on @mentions
  notifyDMs: boolean         // play sound on DM messages
  desktopNotifications: boolean // show browser desktop notifications
  notificationVolume: number // 0-100
}

const STORAGE_KEY = 'relay_media_settings'

const defaults: MediaSettings = {
  audioInputDevice: '',
  audioOutputDevice: '',
  videoDevice: '',
  inputVolume: 100,
  outputVolume: 100,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  channelCount: 1,
  noiseGateEnabled: false,
  noiseGateThreshold: 15,
  noiseGateHold: 250,
  noiseGateAttack: 10,
  noiseGateRelease: 80,
  highpassFreq: 0,
  lowpassFreq: 0,
  eqBands: [
    { freq: 31, gain: 0, type: 'highpass' as const },
    { freq: 63, gain: 0, type: 'peaking' as const },
    { freq: 125, gain: 0, type: 'peaking' as const },
    { freq: 250, gain: 0, type: 'peaking' as const },
    { freq: 500, gain: 0, type: 'peaking' as const },
    { freq: 1000, gain: 0, type: 'peaking' as const },
    { freq: 2000, gain: 0, type: 'peaking' as const },
    { freq: 4000, gain: 0, type: 'peaking' as const },
    { freq: 8000, gain: 0, type: 'peaking' as const },
    { freq: 16000, gain: 0, type: 'lowpass' as const },
  ],
  userVolumes: {},
  audioChainOrder: ['eq', 'noisegate'],
  screenShareResolution: 0,
  screenShareFramerate: 30,
  screenShareMaxBitrate: 8000,
  notifyMessages: true,
  notifyMentions: true,
  notifyDMs: true,
  desktopNotifications: false,
  notificationVolume: 100,
}

export function getSettings(): MediaSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = { ...defaults, ...JSON.parse(raw) } as MediaSettings
      // Migrate old chain order: replace highpass/lowpass with eq
      if (saved.audioChainOrder && !saved.audioChainOrder.includes('eq')) {
        const order = saved.audioChainOrder.filter((n: string) => n !== 'highpass' && n !== 'lowpass')
        order.unshift('eq')
        saved.audioChainOrder = order
      }
      // Ensure eqBands exists and has type field
      if (!saved.eqBands || saved.eqBands.length === 0) {
        saved.eqBands = defaults.eqBands
      } else {
        // Migrate old bands without type field
        saved.eqBands = saved.eqBands.map((b: { freq: number; gain: number; type?: string }) => ({
          ...b,
          type: (b.type || 'peaking') as 'peaking' | 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf',
        }))
      }
      return saved
    }
  } catch { /* ignore */ }
  return { ...defaults }
}

export function saveSettings(s: MediaSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  window.dispatchEvent(new CustomEvent('media-settings-changed'))
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

// Theme system

export interface ThemeColors {
  '--bg-primary': string
  '--bg-secondary': string
  '--bg-tertiary': string
  '--bg-input': string
  '--text-primary': string
  '--text-secondary': string
  '--text-muted': string
  '--accent': string
  '--accent-hover': string
  '--border': string
  '--success': string
  '--danger': string
}

export interface Theme {
  id: string
  name: string
  colors: ThemeColors
}

export const THEME_PRESETS: Theme[] = [
  {
    id: 'default',
    name: 'Midnight',
    colors: {
      '--bg-primary': '#1a1a2e',
      '--bg-secondary': '#16213e',
      '--bg-tertiary': '#0f3460',
      '--bg-input': '#1a1a3e',
      '--text-primary': '#e0e0e0',
      '--text-secondary': '#a0a0b0',
      '--text-muted': '#666680',
      '--accent': '#e94560',
      '--accent-hover': '#ff6b81',
      '--border': '#2a2a4a',
      '--success': '#4ecdc4',
      '--danger': '#e94560',
    },
  },
  {
    id: 'discord',
    name: 'Discord',
    colors: {
      '--bg-primary': '#313338',
      '--bg-secondary': '#2b2d31',
      '--bg-tertiary': '#1e1f22',
      '--bg-input': '#383a40',
      '--text-primary': '#f2f3f5',
      '--text-secondary': '#b5bac1',
      '--text-muted': '#949ba4',
      '--accent': '#5865f2',
      '--accent-hover': '#4752c4',
      '--border': '#3f4147',
      '--success': '#23a55a',
      '--danger': '#da373c',
    },
  },
  {
    id: 'vscode',
    name: 'VS Code',
    colors: {
      '--bg-primary': '#1e1e1e',
      '--bg-secondary': '#252526',
      '--bg-tertiary': '#333333',
      '--bg-input': '#3c3c3c',
      '--text-primary': '#d4d4d4',
      '--text-secondary': '#9cdcfe',
      '--text-muted': '#808080',
      '--accent': '#007acc',
      '--accent-hover': '#1a8ad4',
      '--border': '#474747',
      '--success': '#6a9955',
      '--danger': '#f44747',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    colors: {
      '--bg-primary': '#272822',
      '--bg-secondary': '#1e1f1c',
      '--bg-tertiary': '#3e3d32',
      '--bg-input': '#3e3d32',
      '--text-primary': '#f8f8f2',
      '--text-secondary': '#e6db74',
      '--text-muted': '#75715e',
      '--accent': '#a6e22e',
      '--accent-hover': '#b6f23e',
      '--border': '#49483e',
      '--success': '#a6e22e',
      '--danger': '#f92672',
    },
  },
  {
    id: 'atom',
    name: 'Atom',
    colors: {
      '--bg-primary': '#282c34',
      '--bg-secondary': '#21252b',
      '--bg-tertiary': '#2c313a',
      '--bg-input': '#3a3f4b',
      '--text-primary': '#abb2bf',
      '--text-secondary': '#61afef',
      '--text-muted': '#636d83',
      '--accent': '#c678dd',
      '--accent-hover': '#d19ae8',
      '--border': '#3e4451',
      '--success': '#98c379',
      '--danger': '#e06c75',
    },
  },
  {
    id: 'colorful',
    name: 'Colorful',
    colors: {
      '--bg-primary': '#1b1028',
      '--bg-secondary': '#251640',
      '--bg-tertiary': '#3a1f6e',
      '--bg-input': '#2d1a50',
      '--text-primary': '#f0e6ff',
      '--text-secondary': '#c4a1ff',
      '--text-muted': '#8b6cb5',
      '--accent': '#ff6ec7',
      '--accent-hover': '#ff9ad8',
      '--border': '#452b80',
      '--success': '#00e5a0',
      '--danger': '#ff4466',
    },
  },
  {
    id: 'light',
    name: 'Light',
    colors: {
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f2f3f5',
      '--bg-tertiary': '#e3e5e8',
      '--bg-input': '#ebedef',
      '--text-primary': '#2e3338',
      '--text-secondary': '#4f5660',
      '--text-muted': '#96989d',
      '--accent': '#5865f2',
      '--accent-hover': '#4752c4',
      '--border': '#d4d7dc',
      '--success': '#23a55a',
      '--danger': '#da373c',
    },
  },
]

const THEME_KEY = 'relay_theme'

export function getThemeId(): string {
  return localStorage.getItem(THEME_KEY) || 'default'
}

export function saveThemeId(id: string) {
  localStorage.setItem(THEME_KEY, id)
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  for (const [prop, value] of Object.entries(theme.colors)) {
    root.style.setProperty(prop, value)
  }
}

export function loadAndApplyTheme() {
  const id = getThemeId()
  const theme = THEME_PRESETS.find((t) => t.id === id) || THEME_PRESETS[0]!
  applyTheme(theme)
}
