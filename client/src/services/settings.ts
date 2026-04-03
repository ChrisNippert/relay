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
  // Camera settings
  cameraSettings: {
    whiteBalanceMode?: string       // 'none' | 'manual' | 'single-shot' | 'continuous'
    exposureMode?: string           // 'none' | 'manual' | 'single-shot' | 'continuous'
    focusMode?: string              // 'none' | 'manual' | 'single-shot' | 'continuous'
    exposureCompensation?: number
    exposureTime?: number           // microseconds (shutter speed)
    iso?: number
    brightness?: number
    contrast?: number
    saturation?: number
    colorTemperature?: number       // Kelvin
    sharpness?: number
    resolution?: string             // 'default' | 'WxH'
  }
}

const STORAGE_KEY = 'relay_media_settings'

export const defaults: MediaSettings = {
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
  cameraSettings: {},
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
  gradient?: string
  cssClass?: string
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
  // --- OLED ---
  {
    id: 'oled',
    name: 'OLED Black',
    colors: {
      '--bg-primary': '#000000',
      '--bg-secondary': '#0a0a0a',
      '--bg-tertiary': '#141414',
      '--bg-input': '#1a1a1a',
      '--text-primary': '#e8e8e8',
      '--text-secondary': '#888888',
      '--text-muted': '#555555',
      '--accent': '#e94560',
      '--accent-hover': '#ff6b81',
      '--border': '#1e1e1e',
      '--success': '#4ecdc4',
      '--danger': '#e94560',
    },
  },
  // --- Dark gradient themes ---
  {
    id: 'aurora',
    name: 'Aurora',
    gradient: 'linear-gradient(135deg, #0a0a1a 0%, #0d1b2a 40%, #1b2838 100%)',
    colors: {
      '--bg-primary': '#0d1b2a',
      '--bg-secondary': '#0a1628',
      '--bg-tertiary': '#1b2838',
      '--bg-input': '#162030',
      '--text-primary': '#e0f0ff',
      '--text-secondary': '#7ec8e3',
      '--text-muted': '#4a7a8c',
      '--accent': '#00d4aa',
      '--accent-hover': '#00f0c0',
      '--border': '#1a3040',
      '--success': '#00d4aa',
      '--danger': '#ff4466',
    },
  },
  {
    id: 'nebula',
    name: 'Nebula',
    gradient: 'linear-gradient(135deg, #1a0a2e 0%, #2d1b69 50%, #16213e 100%)',
    colors: {
      '--bg-primary': '#1a0a2e',
      '--bg-secondary': '#150828',
      '--bg-tertiary': '#2d1b69',
      '--bg-input': '#251545',
      '--text-primary': '#e8dff5',
      '--text-secondary': '#b8a9d4',
      '--text-muted': '#6e5a8a',
      '--accent': '#bf5af2',
      '--accent-hover': '#d580ff',
      '--border': '#36206e',
      '--success': '#30d158',
      '--danger': '#ff453a',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    gradient: 'linear-gradient(135deg, #1a0a0a 0%, #2d1520 50%, #1a1025 100%)',
    colors: {
      '--bg-primary': '#1a0c10',
      '--bg-secondary': '#150a0e',
      '--bg-tertiary': '#2d1520',
      '--bg-input': '#251218',
      '--text-primary': '#f5e6e8',
      '--text-secondary': '#d4a0a8',
      '--text-muted': '#8a5a62',
      '--accent': '#ff6b6b',
      '--accent-hover': '#ff9090',
      '--border': '#3a1a22',
      '--success': '#ffd93d',
      '--danger': '#ff4757',
    },
  },
  {
    id: 'ocean',
    name: 'Deep Ocean',
    gradient: 'linear-gradient(135deg, #020c1b 0%, #0a192f 50%, #112240 100%)',
    colors: {
      '--bg-primary': '#0a192f',
      '--bg-secondary': '#071222',
      '--bg-tertiary': '#112240',
      '--bg-input': '#0d1a30',
      '--text-primary': '#ccd6f6',
      '--text-secondary': '#8892b0',
      '--text-muted': '#495670',
      '--accent': '#64ffda',
      '--accent-hover': '#90ffe6',
      '--border': '#1d3461',
      '--success': '#64ffda',
      '--danger': '#ff5370',
    },
  },
  // --- Light gradient themes ---
  {
    id: 'peach',
    name: 'Peach Blossom',
    gradient: 'linear-gradient(135deg, #fff5f5 0%, #ffe8e0 50%, #fff0f5 100%)',
    colors: {
      '--bg-primary': '#fff5f2',
      '--bg-secondary': '#ffe8e0',
      '--bg-tertiary': '#ffd6cc',
      '--bg-input': '#fff0eb',
      '--text-primary': '#3d2020',
      '--text-secondary': '#6b4040',
      '--text-muted': '#a07070',
      '--accent': '#e8596a',
      '--accent-hover': '#d04050',
      '--border': '#f0ccc0',
      '--success': '#2a9d6a',
      '--danger': '#e04050',
    },
  },
  {
    id: 'mint',
    name: 'Mint Breeze',
    gradient: 'linear-gradient(135deg, #f0faf5 0%, #e0f5ee 50%, #f5fffa 100%)',
    colors: {
      '--bg-primary': '#f2faf6',
      '--bg-secondary': '#e0f5ee',
      '--bg-tertiary': '#c8eadb',
      '--bg-input': '#eaf7f0',
      '--text-primary': '#1a3a2a',
      '--text-secondary': '#3a6a50',
      '--text-muted': '#7aaa90',
      '--accent': '#18b06a',
      '--accent-hover': '#10904a',
      '--border': '#c0e0d0',
      '--success': '#18b06a',
      '--danger': '#d04040',
    },
  },
  {
    id: 'lavender',
    name: 'Lavender Mist',
    gradient: 'linear-gradient(135deg, #f5f0ff 0%, #ece0ff 50%, #f8f5ff 100%)',
    colors: {
      '--bg-primary': '#f6f2ff',
      '--bg-secondary': '#ece0ff',
      '--bg-tertiary': '#ddd0f5',
      '--bg-input': '#f0eaff',
      '--text-primary': '#2a1a4a',
      '--text-secondary': '#5a3a8a',
      '--text-muted': '#9080aa',
      '--accent': '#7c3aed',
      '--accent-hover': '#6025d0',
      '--border': '#d8c8f0',
      '--success': '#22c55e',
      '--danger': '#dc2626',
    },
  },
  // --- Fruity / fun ---
  {
    id: 'tropical',
    name: 'Tropical',
    gradient: 'linear-gradient(135deg, #0a1a15 0%, #0a2018 50%, #102010 100%)',
    colors: {
      '--bg-primary': '#0c1a14',
      '--bg-secondary': '#0a1510',
      '--bg-tertiary': '#14281e',
      '--bg-input': '#122018',
      '--text-primary': '#e0ffe8',
      '--text-secondary': '#80d4a0',
      '--text-muted': '#4a8a60',
      '--accent': '#ff9f43',
      '--accent-hover': '#ffb86c',
      '--border': '#1a3828',
      '--success': '#00e676',
      '--danger': '#ff5252',
    },
  },
  {
    id: 'berry',
    name: 'Berry Crush',
    gradient: 'linear-gradient(135deg, #1a0818 0%, #2a0a28 50%, #1a0620 100%)',
    colors: {
      '--bg-primary': '#1a0818',
      '--bg-secondary': '#140612',
      '--bg-tertiary': '#2a0a28',
      '--bg-input': '#20081e',
      '--text-primary': '#f8e0f5',
      '--text-secondary': '#d4a0cc',
      '--text-muted': '#8a5a80',
      '--accent': '#ff2d78',
      '--accent-hover': '#ff5a9a',
      '--border': '#3a1038',
      '--success': '#50e890',
      '--danger': '#ff2d55',
    },
  },
  // --- Space ---
  {
    id: 'cosmos',
    name: 'Cosmos',
    gradient: 'linear-gradient(135deg, #05050f 0%, #0a0a2a 40%, #150a30 100%)',
    colors: {
      '--bg-primary': '#08081a',
      '--bg-secondary': '#050515',
      '--bg-tertiary': '#12122e',
      '--bg-input': '#0e0e24',
      '--text-primary': '#d8d8f8',
      '--text-secondary': '#9090cc',
      '--text-muted': '#5858aa',
      '--accent': '#6366f1',
      '--accent-hover': '#818cf8',
      '--border': '#1a1a40',
      '--success': '#34d399',
      '--danger': '#f87171',
    },
  },
  // --- Rainbow ---
  {
    id: 'rainbow',
    name: 'Rainbow',
    cssClass: 'theme-rainbow',
    gradient: 'linear-gradient(135deg, #1a0a1e 0%, #0a1a2e 25%, #0a1e1a 50%, #1e1a0a 75%, #1e0a14 100%)',
    colors: {
      '--bg-primary': '#0e0e18',
      '--bg-secondary': '#0a0a14',
      '--bg-tertiary': '#161622',
      '--bg-input': '#12121e',
      '--text-primary': '#f0f0f0',
      '--text-secondary': '#b8b8cc',
      '--text-muted': '#6868aa',
      '--accent': '#f472b6',
      '--accent-hover': '#fb7dc5',
      '--border': '#1e1e3a',
      '--success': '#34d399',
      '--danger': '#f87171',
    },
  },
  // --- Glitter ---
  {
    id: 'glitter',
    name: 'Glitter',
    cssClass: 'theme-glitter',
    gradient: 'linear-gradient(135deg, #12061e 0%, #1a0a2e 30%, #0e0828 60%, #180a28 100%)',
    colors: {
      '--bg-primary': '#100818',
      '--bg-secondary': '#0c0612',
      '--bg-tertiary': '#1a0e28',
      '--bg-input': '#14091e',
      '--text-primary': '#f0e8ff',
      '--text-secondary': '#c8a8e8',
      '--text-muted': '#7858a8',
      '--accent': '#e8a0ff',
      '--accent-hover': '#f0c0ff',
      '--border': '#281840',
      '--success': '#a0f0c8',
      '--danger': '#ff6888',
    },
  },
  // --- Fun patterns ---
  {
    id: 'stripes',
    name: 'Stripes',
    cssClass: 'theme-stripes',
    colors: {
      '--bg-primary': '#141420',
      '--bg-secondary': '#101018',
      '--bg-tertiary': '#1c1c30',
      '--bg-input': '#18182a',
      '--text-primary': '#e8e8f0',
      '--text-secondary': '#a0a0c0',
      '--text-muted': '#606080',
      '--accent': '#7c8cf8',
      '--accent-hover': '#9aa4ff',
      '--border': '#2a2a44',
      '--success': '#5ae0a0',
      '--danger': '#f06060',
    },
  },
  {
    id: 'checkerboard',
    name: 'Checkerboard',
    cssClass: 'theme-checkerboard',
    colors: {
      '--bg-primary': '#1a1a1a',
      '--bg-secondary': '#141414',
      '--bg-tertiary': '#222222',
      '--bg-input': '#1e1e1e',
      '--text-primary': '#e0e0e0',
      '--text-secondary': '#a0a0a0',
      '--text-muted': '#606060',
      '--accent': '#e8e8e8',
      '--accent-hover': '#ffffff',
      '--border': '#2a2a2a',
      '--success': '#50c878',
      '--danger': '#e05050',
    },
  },
  {
    id: 'polkadots',
    name: 'Polka Dots',
    cssClass: 'theme-polkadots',
    colors: {
      '--bg-primary': '#1a1028',
      '--bg-secondary': '#140c20',
      '--bg-tertiary': '#221638',
      '--bg-input': '#1c1030',
      '--text-primary': '#f0e0ff',
      '--text-secondary': '#c0a0d8',
      '--text-muted': '#7060a0',
      '--accent': '#ff80c0',
      '--accent-hover': '#ffa0d0',
      '--border': '#2a1840',
      '--success': '#80e0a0',
      '--danger': '#ff5080',
    },
  },
  {
    id: 'neapolitan',
    name: 'Neapolitan',
    cssClass: 'theme-neapolitan',
    gradient: 'linear-gradient(180deg, #3a1a1a 0%, #3a1a1a 33%, #f5e6d0 33%, #f5e6d0 66%, #1a0e0a 66%, #1a0e0a 100%)',
    colors: {
      '--bg-primary': '#2a1515',
      '--bg-secondary': '#1e1010',
      '--bg-tertiary': '#3a1a1a',
      '--bg-input': '#2e1818',
      '--text-primary': '#f5e6d0',
      '--text-secondary': '#d4a8a0',
      '--text-muted': '#8a5a5a',
      '--accent': '#e8a0b0',
      '--accent-hover': '#f0b8c0',
      '--border': '#4a2828',
      '--success': '#80c8a0',
      '--danger': '#e05050',
    },
  },
  {
    id: 'zigzag',
    name: 'Zigzag',
    cssClass: 'theme-zigzag',
    colors: {
      '--bg-primary': '#0e1a18',
      '--bg-secondary': '#0a1412',
      '--bg-tertiary': '#142420',
      '--bg-input': '#10201c',
      '--text-primary': '#d0f0e8',
      '--text-secondary': '#80c0a8',
      '--text-muted': '#508070',
      '--accent': '#40e0d0',
      '--accent-hover': '#60f0e0',
      '--border': '#1a3830',
      '--success': '#40e0a0',
      '--danger': '#f06060',
    },
  },
  // --- Pride flags (UI colors inspired by flag palettes) ---
  {
    id: 'pride-rainbow',
    name: '🏳️‍🌈 Rainbow',
    colors: {
      '--bg-primary': '#1e1030',
      '--bg-secondary': '#2a1040',
      '--bg-tertiary': '#341250',
      '--bg-input': '#22103a',
      '--text-primary': '#fff8e8',
      '--text-secondary': '#ffcc66',
      '--text-muted': '#a07850',
      '--accent': '#e44040',
      '--accent-hover': '#ff6040',
      '--border': '#4a2068',
      '--success': '#00a030',
      '--danger': '#e44040',
    },
  },
  {
    id: 'pride-trans',
    name: '🏳️‍⚧️ Trans',
    colors: {
      '--bg-primary': '#1a2838',
      '--bg-secondary': '#2a1828',
      '--bg-tertiary': '#1e3040',
      '--bg-input': '#24202e',
      '--text-primary': '#f0f4ff',
      '--text-secondary': '#f7a8b8',
      '--text-muted': '#7090a8',
      '--accent': '#55cdfc',
      '--accent-hover': '#80d8ff',
      '--border': '#3a2840',
      '--success': '#55cdaa',
      '--danger': '#f07088',
    },
  },
  {
    id: 'pride-bi',
    name: '🩷💜💙 Bi',
    colors: {
      '--bg-primary': '#1a1030',
      '--bg-secondary': '#2e0c3e',
      '--bg-tertiary': '#0c1838',
      '--bg-input': '#1e1028',
      '--text-primary': '#f0e0ff',
      '--text-secondary': '#d898d0',
      '--text-muted': '#7858a0',
      '--accent': '#d6026e',
      '--accent-hover': '#e840a0',
      '--border': '#3a1860',
      '--success': '#60c0a0',
      '--danger': '#d6026e',
    },
  },
  {
    id: 'pride-lesbian',
    name: '🧡🤍💜 Lesbian',
    colors: {
      '--bg-primary': '#281018',
      '--bg-secondary': '#3a0820',
      '--bg-tertiary': '#201828',
      '--bg-input': '#2e1020',
      '--text-primary': '#ffe8f0',
      '--text-secondary': '#ef7636',
      '--text-muted': '#a06070',
      '--accent': '#d52d00',
      '--accent-hover': '#ef6536',
      '--border': '#4a1830',
      '--success': '#d098b0',
      '--danger': '#a30262',
    },
  },
  {
    id: 'pride-nonbinary',
    name: '💛🤍💜🖤 Nonbinary',
    colors: {
      '--bg-primary': '#1a1420',
      '--bg-secondary': '#0e0c10',
      '--bg-tertiary': '#282030',
      '--bg-input': '#1c1624',
      '--text-primary': '#fcf4d0',
      '--text-secondary': '#e0d8c0',
      '--text-muted': '#8878a0',
      '--accent': '#c8b800',
      '--accent-hover': '#e0d030',
      '--border': '#3a2850',
      '--success': '#9c59d1',
      '--danger': '#c04040',
    },
  },
  {
    id: 'pride-ace',
    name: '🖤🩶🤍💜 Ace',
    colors: {
      '--bg-primary': '#121014',
      '--bg-secondary': '#1c1620',
      '--bg-tertiary': '#0a0a0c',
      '--bg-input': '#161218',
      '--text-primary': '#e8e0f0',
      '--text-secondary': '#a8a0b8',
      '--text-muted': '#606068',
      '--accent': '#810081',
      '--accent-hover': '#a800a8',
      '--border': '#2a2230',
      '--success': '#70a080',
      '--danger': '#a04060',
    },
  },
  {
    id: 'pride-pan',
    name: '💗💛💙 Pan',
    colors: {
      '--bg-primary': '#1a1028',
      '--bg-secondary': '#280820',
      '--bg-tertiary': '#0c1830',
      '--bg-input': '#201028',
      '--text-primary': '#fff0f8',
      '--text-secondary': '#ffd866',
      '--text-muted': '#8870a0',
      '--accent': '#ff218c',
      '--accent-hover': '#ff50a0',
      '--border': '#3a1848',
      '--success': '#21b1ff',
      '--danger': '#ff218c',
    },
  },
]

const THEME_KEY = 'relay_theme'
const CUSTOM_THEMES_KEY = 'relay_custom_themes'

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
  if (theme.gradient) {
    root.style.setProperty('--bg-gradient', theme.gradient)
    root.classList.add('gradient-theme')
  } else {
    root.style.removeProperty('--bg-gradient')
    root.classList.remove('gradient-theme')
  }
  // Remove all theme-specific css classes, then add the current one
  const themeCssClasses = THEME_PRESETS.map((t) => t.cssClass).filter(Boolean) as string[]
  root.classList.remove(...themeCssClasses)
  if (theme.cssClass) {
    root.classList.add(theme.cssClass)
  }
}

export function loadAndApplyTheme() {
  const id = getThemeId()
  const all = getAllThemes()
  const theme = all.find((t) => t.id === id) || THEME_PRESETS[0]!
  applyTheme(theme)
}

export function getCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveCustomThemes(themes: Theme[]) {
  localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes))
}

export function getAllThemes(): Theme[] {
  return [...THEME_PRESETS, ...getCustomThemes()]
}

// --- Text customization ---
export interface TextSettings {
  fontFamily: string
  fontSize: number      // px
  lineHeight: number    // unitless multiplier
  letterSpacing: number // px
}

const TEXT_SETTINGS_KEY = 'relay_text_settings'

export const FONT_OPTIONS = [
  { label: 'Default (Inter)', value: "'Inter', system-ui, -apple-system, sans-serif" },
  { label: 'System UI', value: 'system-ui, -apple-system, sans-serif' },
  { label: 'Monospace', value: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Comic Sans', value: '"Comic Sans MS", "Comic Sans", cursive' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
]

export const DEFAULT_TEXT_SETTINGS: TextSettings = {
  fontFamily: FONT_OPTIONS[0]!.value,
  fontSize: 14,
  lineHeight: 1.5,
  letterSpacing: 0,
}

export function getTextSettings(): TextSettings {
  try {
    const raw = localStorage.getItem(TEXT_SETTINGS_KEY)
    return raw ? { ...DEFAULT_TEXT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_TEXT_SETTINGS }
  } catch { return { ...DEFAULT_TEXT_SETTINGS } }
}

export function saveTextSettings(s: TextSettings) {
  localStorage.setItem(TEXT_SETTINGS_KEY, JSON.stringify(s))
}

export function applyTextSettings(s: TextSettings) {
  const root = document.documentElement
  root.style.setProperty('--font-family', s.fontFamily)
  root.style.setProperty('--font-size', `${s.fontSize}px`)
  root.style.setProperty('--line-height', `${s.lineHeight}`)
  root.style.setProperty('--letter-spacing', `${s.letterSpacing}px`)
}

export function loadAndApplyTextSettings() {
  applyTextSettings(getTextSettings())
}
