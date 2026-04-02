import { useEffect, useRef, useState, useCallback } from 'react'
import { getSettings, saveSettings, getDevices, type MediaSettings, THEME_PRESETS, getThemeId, saveThemeId, applyTheme } from '../services/settings'
import { useAuth } from '../context/AuthContext'
import * as api from '../services/api'
import type { Device } from '../types'

interface Props {
  onClose: () => void
}

const COLOR_PRESETS = [
  '#e94560', '#ff6b81', '#4ecdc4', '#45b7d1', '#96ceb4',
  '#ffeaa7', '#dfe6e9', '#fd79a8', '#6c5ce7', '#a29bfe',
  '#00b894', '#fdcb6e', '#e17055', '#0984e3', '#b2bec3',
  '',
]

export default function SettingsPanel({ onClose }: Props) {
  const { user, updateUser, logout } = useAuth()
  const [settings, setSettings] = useState<MediaSettings>(getSettings)
  const [closing, setClosing] = useState(false)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [devicesLoaded, setDevicesLoaded] = useState(false)
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)

  // Profile fields
  const [displayName, setDisplayName] = useState(user?.display_name ?? '')
  const [customStatus, setCustomStatus] = useState(user?.custom_status ?? '')
  const [nameColor, setNameColor] = useState(user?.name_color ?? '')
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)
  const [tab, setTab] = useState<'profile' | 'audio-stack' | 'video' | 'theme' | 'devices' | 'notifications'>('profile')
  const [activeTheme, setActiveTheme] = useState(getThemeId)
  const [micTestStream, setMicTestStream] = useState<MediaStream | null>(null)
  const [, setMicLevel] = useState(0)
  const [expandedNode, setExpandedNode] = useState<string | null>(null)
  const [draggedNode, setDraggedNode] = useState<string | null>(null)
  const [eqContextMenu, setEqContextMenu] = useState<{ x: number; y: number; bandIdx: number } | null>(null)
  const micTestCtxRef = useRef<AudioContext | null>(null)
  const micTestAnimRef = useRef<number>(0)
  const micMonitorRef = useRef<{ stream: MediaStream; ctx: AudioContext; anim: number } | null>(null)
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const canvasDragRef = useRef<{ type: 'eq'; bandIdx: number } | { type: 'noisegate' } | null>(null)
  const spectrumAnalyserRef = useRef<AnalyserNode | null>(null)
  const spectrumDataRef = useRef<Uint8Array | null>(null)
  const spectrumSampleRateRef = useRef<number>(48000)
  const micTestEqFiltersRef = useRef<BiquadFilterNode[]>([])

  // E2E device approval state
  const [e2eDevices, setE2eDevices] = useState<Device[]>([])
  const [pendingDevices, setPendingDevices] = useState<Device[]>([])
  const [e2eLoaded, setE2eLoaded] = useState(false)

  const loadE2eDevices = useCallback(async () => {
    try {
      const [all, pending] = await Promise.all([api.getMyDevices(), api.getPendingDevices()])
      setE2eDevices(all)
      setPendingDevices(pending)
      setE2eLoaded(true)
    } catch { setE2eLoaded(true) }
  }, [])

  useEffect(() => {
    if (tab === 'devices' && !e2eLoaded) loadE2eDevices()
  }, [tab, e2eLoaded, loadE2eDevices])

  // Load pending count on mount for badge display
  useEffect(() => {
    api.getPendingDevices().then(setPendingDevices).catch(() => {})
  }, [])

  // Only load devices when audio-stack or video tab is opened
  useEffect(() => {
    if ((tab !== 'audio-stack' && tab !== 'video') || devicesLoaded) return
    setLoading(true)
    getDevices().then((d) => {
      setAudioInputs(d.audioInputs)
      setAudioOutputs(d.audioOutputs)
      setVideoInputs(d.videoInputs)
      setDevicesLoaded(true)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [tab, devicesLoaded])

  // Stop camera stream on unmount or tab change
  useEffect(() => {
    return () => { cameraStream?.getTracks().forEach((t) => t.stop()) }
  }, [cameraStream])

  // Stop mic test on unmount or tab change
  useEffect(() => {
    return () => {
      micTestStream?.getTracks().forEach((t) => t.stop())
      cancelAnimationFrame(micTestAnimRef.current)
      micTestCtxRef.current?.close()
    }
  }, [micTestStream])

  // Auto mic level monitoring when on audio-stack tab (no loopback) — also draws spectrum
  useEffect(() => {
    if (tab !== 'audio-stack' || micTestStream) {
      // Stop monitor if conditions not met or mic test is active (it provides its own)
      if (micMonitorRef.current) {
        cancelAnimationFrame(micMonitorRef.current.anim)
        micMonitorRef.current.stream.getTracks().forEach(t => t.stop())
        micMonitorRef.current.ctx.close()
        micMonitorRef.current = null
        spectrumAnalyserRef.current = null
        spectrumDataRef.current = null
        if (!micTestStream) setMicLevel(0)
      }
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const curSettings = getSettings()
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: curSettings.noiseSuppression,
            echoCancellation: false,
            autoGainControl: curSettings.autoGainControl,
            ...(curSettings.audioInputDevice ? { deviceId: { exact: curSettings.audioInputDevice } } : {}),
          },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        const ctx = new AudioContext()
        if (ctx.state === 'suspended') await ctx.resume()
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.7
        source.connect(analyser)
        spectrumAnalyserRef.current = analyser
        spectrumSampleRateRef.current = ctx.sampleRate
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        spectrumDataRef.current = dataArray
        const check = () => {
          analyser.getByteFrequencyData(dataArray)
          let sum = 0
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]!
          const avg = sum / dataArray.length
          const normalized = Math.min((avg / 60) * 100, 100)
          setMicLevel(normalized)
          drawSpectrum()
          if (!cancelled) micMonitorRef.current!.anim = requestAnimationFrame(check)
        }
        micMonitorRef.current = { stream, ctx, anim: requestAnimationFrame(check) }
      } catch { /* mic not available */ }
    })()
    return () => {
      cancelled = true
      if (micMonitorRef.current) {
        cancelAnimationFrame(micMonitorRef.current.anim)
        micMonitorRef.current.stream.getTracks().forEach(t => t.stop())
        micMonitorRef.current.ctx.close()
        micMonitorRef.current = null
        spectrumAnalyserRef.current = null
        spectrumDataRef.current = null
      }
    }
  }, [tab, micTestStream, settings.audioInputDevice])

  const drawSpectrum = useCallback(() => {
    const canvas = spectrumCanvasRef.current
    const dataArray = spectrumDataRef.current
    if (!canvas || !dataArray) return
    const c = canvas.getContext('2d')
    if (!c) return
    const w = canvas.width, h = canvas.height
    const liveS = getSettings()
    const sr = spectrumSampleRateRef.current
    const nyquist = sr / 2
    const minF = 20, maxF = Math.min(nyquist, 20000)
    const logMin = Math.log10(minF), logMax = Math.log10(maxF), logRange = logMax - logMin

    c.clearRect(0, 0, w, h)
    c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-tertiary').trim() || '#1a1a2e'
    c.fillRect(0, 0, w, h)

    // Draw frequency bars (log scale, 2px wide for smoother look)
    for (let px = 0; px < w; px += 2) {
      const f0 = Math.pow(10, logMin + (px / w) * logRange)
      const f1 = Math.pow(10, logMin + ((px + 2) / w) * logRange)
      const bin0 = Math.floor((f0 / nyquist) * dataArray.length)
      const bin1 = Math.ceil((f1 / nyquist) * dataArray.length)
      let maxAmp = 0
      for (let b = Math.max(0, bin0); b <= Math.min(dataArray.length - 1, bin1); b++) {
        if (dataArray[b]! > maxAmp) maxAmp = dataArray[b]!
      }
      const amplitude = maxAmp / 255
      const barHeight = amplitude * h
      c.fillStyle = `hsla(${120 - amplitude * 120}, 80%, 50%, 0.8)`
      c.fillRect(px, h - barHeight, 2, barHeight)
    }

    // Draw EQ curve overlay
    const bands = liveS.eqBands || []
    if (bands.length > 0) {
      c.beginPath()
      c.strokeStyle = 'rgba(78, 205, 196, 0.7)'
      c.lineWidth = 2
      for (let px = 0; px < w; px++) {
        const freq = Math.pow(10, logMin + (px / w) * logRange)
        let gainDb = 0
        for (const band of bands) {
          const t = band.type || 'peaking'
          if (t === 'peaking') {
            const octaveDist = Math.log2(freq / band.freq)
            gainDb += band.gain * Math.exp(-0.5 * Math.pow(octaveDist / 0.75, 2))
          } else if (t === 'lowshelf') {
            gainDb += band.gain / (1 + Math.pow(freq / band.freq, 2))
          } else if (t === 'highshelf') {
            gainDb += band.gain / (1 + Math.pow(band.freq / freq, 2))
          } else if (t === 'lowpass') {
            const ratio = freq / band.freq
            if (ratio > 1) gainDb -= 12 * Math.log2(ratio) * Math.abs(band.gain) / 12
          } else if (t === 'highpass') {
            const ratio = band.freq / freq
            if (ratio > 1) gainDb -= 12 * Math.log2(ratio) * Math.abs(band.gain) / 12
          }
        }
        const y = h / 2 - (Math.max(-12, Math.min(12, gainDb)) / 12) * (h / 2)
        if (px === 0) c.moveTo(px, y)
        else c.lineTo(px, y)
      }
      c.stroke()

      // Draw band handles with type-specific shapes
      c.font = '9px Inter, sans-serif'
      c.textAlign = 'center'
      const typeColors: Record<string, string> = {
        peaking: '#4ecdc4', lowpass: '#e94560', highpass: '#ff6b6b',
        lowshelf: '#ffd93d', highshelf: '#6bcb77',
      }
      for (let i = 0; i < bands.length; i++) {
        const band = bands[i]!
        const bx = ((Math.log10(Math.max(band.freq, minF)) - logMin) / logRange) * w
        const by = h / 2 - (band.gain / 12) * (h / 2)
        const color = typeColors[band.type] || '#4ecdc4'
        const dimColor = band.gain !== 0 ? color : `${color}80`
        c.fillStyle = dimColor
        c.strokeStyle = '#fff'
        c.lineWidth = 1.5

        const t = band.type || 'peaking'
        if (t === 'lowpass' || t === 'highpass') {
          // Triangle
          const dir = t === 'lowpass' ? 1 : -1
          c.beginPath()
          c.moveTo(bx + dir * 8, by)
          c.lineTo(bx - dir * 5, by - 7)
          c.lineTo(bx - dir * 5, by + 7)
          c.closePath()
          c.fill(); c.stroke()
        } else if (t === 'lowshelf' || t === 'highshelf') {
          // Diamond
          c.beginPath()
          c.moveTo(bx, by - 8)
          c.lineTo(bx + 7, by)
          c.lineTo(bx, by + 8)
          c.lineTo(bx - 7, by)
          c.closePath()
          c.fill(); c.stroke()
        } else {
          // Circle (peaking)
          c.beginPath()
          c.arc(bx, by, 7, 0, Math.PI * 2)
          c.fill(); c.stroke()
        }

        // Freq label below handle
        const freqLabel = band.freq >= 1000 ? `${(band.freq / 1000).toFixed(band.freq % 1000 === 0 ? 0 : 1)}k` : `${band.freq}`
        c.fillStyle = 'rgba(255,255,255,0.7)'
        c.fillText(freqLabel, bx, Math.min(by + 20, h - 2))
        // dB label above handle (only if non-zero)
        if (band.gain !== 0) {
          c.fillStyle = color
          c.fillText(`${band.gain > 0 ? '+' : ''}${band.gain}dB`, bx, Math.max(by - 12, 10))
        }
      }
      c.textAlign = 'start'
    }

    // Noise gate threshold line
    if (liveS.noiseGateEnabled) {
      const ngY = h - (liveS.noiseGateThreshold / 100) * h
      c.strokeStyle = '#e94560'
      c.lineWidth = 2
      c.setLineDash([6, 4])
      c.beginPath()
      c.moveTo(0, ngY)
      c.lineTo(w, ngY)
      c.stroke()
      c.setLineDash([])
      c.fillStyle = '#e94560'
      c.font = '10px Inter, sans-serif'
      c.fillText(`Gate ${liveS.noiseGateThreshold}%`, 4, ngY > 16 ? ngY - 4 : ngY + 14)
    }
  }, [])

  const toggleMicTest = async () => {
    if (micTestStream) {
      micTestStream.getTracks().forEach((t) => t.stop())
      cancelAnimationFrame(micTestAnimRef.current)
      micTestCtxRef.current?.close()
      micTestCtxRef.current = null
      setMicTestStream(null)
      setMicLevel(0)
      return
    }
    try {
      const curSettings = getSettings()
      const constraints: MediaStreamConstraints = {
        audio: {
          noiseSuppression: curSettings.noiseSuppression,
          echoCancellation: false,
          autoGainControl: curSettings.autoGainControl,
          channelCount: curSettings.channelCount,
          ...(curSettings.audioInputDevice ? { deviceId: { exact: curSettings.audioInputDevice } } : {}),
        },
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      setMicTestStream(stream)

      // Set up loopback audio playback
      const ctx = new AudioContext()
      if (ctx.state === 'suspended') await ctx.resume()
      micTestCtxRef.current = ctx
      spectrumSampleRateRef.current = ctx.sampleRate
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.7
      source.connect(analyser)
      spectrumAnalyserRef.current = analyser
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      spectrumDataRef.current = dataArray

      // Loopback: play mic audio back through speakers so user can hear themselves
      // Build filter chain: source → [filters per audioChainOrder] → loopbackGain → destination
      const loopbackGain = ctx.createGain()
      loopbackGain.gain.value = 1

      let lastNode: AudioNode = source
      const eqFilters: BiquadFilterNode[] = []
      for (const nodeId of curSettings.audioChainOrder) {
        if (nodeId === 'eq') {
          for (const band of curSettings.eqBands || []) {
            const eq = ctx.createBiquadFilter()
            eq.type = band.type || 'peaking'
            eq.frequency.value = band.freq
            if (band.type === 'peaking' || !band.type) eq.Q.value = 1.4
            else if (band.type === 'lowshelf' || band.type === 'highshelf') eq.Q.value = 1
            else eq.Q.value = 0.7
            eq.gain.value = band.gain
            lastNode.connect(eq)
            lastNode = eq
            eqFilters.push(eq)
          }
        }
      }
      lastNode.connect(loopbackGain)
      loopbackGain.connect(ctx.destination)
      micTestEqFiltersRef.current = eqFilters

      // Spectrum analyzer animation loop
      const check = () => {
        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]!
        const avg = sum / dataArray.length
        const normalized = Math.min((avg / 60) * 100, 100)
        setMicLevel(normalized)

        drawSpectrum()

        // Live-update EQ filter gains/freqs from current settings
        const liveSettings = getSettings()
        const liveBands = liveSettings.eqBands || []
        for (let i = 0; i < micTestEqFiltersRef.current.length && i < liveBands.length; i++) {
          const f = micTestEqFiltersRef.current[i]!
          const b = liveBands[i]!
          if (f.gain.value !== b.gain) f.gain.setValueAtTime(b.gain, ctx.currentTime)
          if (f.frequency.value !== b.freq) f.frequency.setValueAtTime(b.freq, ctx.currentTime)
          const bType = b.type || 'peaking'
          if (f.type !== bType) f.type = bType
        }

        // Apply noise gate to loopback
        if (liveSettings.noiseGateEnabled) {
          const speaking = normalized > liveSettings.noiseGateThreshold
          loopbackGain.gain.setTargetAtTime(speaking ? 1 : 0, ctx.currentTime, 0.01)
        } else {
          loopbackGain.gain.setTargetAtTime(1, ctx.currentTime, 0.01)
        }

        micTestAnimRef.current = requestAnimationFrame(check)
      }
      check()
    } catch {
      /* mic not available */
    }
  }

  const toggleCameraPreview = async () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop())
      setCameraStream(null)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: settings.videoDevice ? { deviceId: { exact: settings.videoDevice } } : true,
      })
      setCameraStream(stream)
    } catch { /* camera not available */ }
  }

  // Spectrum analyzer canvas mouse handlers for dragging EQ band handles / noise gate
  const spectrumLogParams = () => {
    const sr = spectrumSampleRateRef.current
    const nyquist = sr / 2
    const minF = 20, maxF = Math.min(nyquist, 20000)
    const logMin = Math.log10(minF), logMax = Math.log10(maxF), logRange = logMax - logMin
    return { nyquist, minF, maxF, logMin, logMax, logRange }
  }

  const handleSpectrumMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = spectrumCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height
    const { logMin, logRange, minF } = spectrumLogParams()
    const w = canvas.width, h = canvas.height
    const prox = 16

    // Check EQ band handles
    const bands = settings.eqBands || []
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i]!
      const bx = ((Math.log10(Math.max(band.freq, minF)) - logMin) / logRange) * w
      const by = h / 2 - (band.gain / 12) * (h / 2)
      const dist = Math.sqrt((x - bx) ** 2 + (y - by) ** 2)
      if (dist < prox) { canvasDragRef.current = { type: 'eq', bandIdx: i }; return }
    }
    // Check noise gate threshold line
    if (settings.noiseGateEnabled) {
      const ngY = h - (settings.noiseGateThreshold / 100) * h
      if (Math.abs(y - ngY) < prox) { canvasDragRef.current = { type: 'noisegate' }; return }
    }
  }

  const handleSpectrumMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = canvasDragRef.current
    if (!drag) return
    const canvas = spectrumCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height
    const { logMin, logRange } = spectrumLogParams()

    if (drag.type === 'eq') {
      const freq = Math.pow(10, logMin + (x / canvas.width) * logRange)
      const clampedFreq = Math.round(Math.max(20, Math.min(20000, freq)))
      const gain = Math.round(Math.max(-12, Math.min(12, ((canvas.height / 2 - y) / (canvas.height / 2)) * 12)))
      const bands = [...(settings.eqBands || [])]
      if (bands[drag.bandIdx]) {
        bands[drag.bandIdx] = { ...bands[drag.bandIdx]!, freq: clampedFreq, gain }
        update({ eqBands: bands })
      }
    } else if (drag.type === 'noisegate') {
      const threshold = Math.round(Math.max(0, Math.min(100, (1 - y / canvas.height) * 100)))
      update({ noiseGateThreshold: threshold })
    }
  }

  const handleSpectrumMouseUp = () => { canvasDragRef.current = null }

  const handleSpectrumContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = spectrumCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height
    const { logMin, logRange, minF } = spectrumLogParams()
    const w = canvas.width, h = canvas.height

    const bands = settings.eqBands || []
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i]!
      const bx = ((Math.log10(Math.max(band.freq, minF)) - logMin) / logRange) * w
      const by = h / 2 - (band.gain / 12) * (h / 2)
      if (Math.sqrt((x - bx) ** 2 + (y - by) ** 2) < 16) {
        setEqContextMenu({ x: e.clientX, y: e.clientY, bandIdx: i })
        return
      }
    }
    setEqContextMenu(null)
  }

  const update = (partial: Partial<MediaSettings>) => {
    const next = { ...settings, ...partial }
    setSettings(next)
    saveSettings(next)
  }

  const handleSaveProfile = async () => {
    setProfileSaving(true)
    try {
      const updated = await api.updateMe({
        display_name: displayName,
        custom_status: customStatus,
        name_color: nameColor,
      })
      updateUser(updated)
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 2000)
    } catch { /* ignore */ }
    setProfileSaving(false)
  }

  const handleClose = () => {
    setClosing(true)
    setTimeout(onClose, 200)
  }

  return (
    <div className={`settings-overlay ${closing ? 'closing' : ''}`} onClick={handleClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-sidebar">
          <h2 className="settings-sidebar-title">Settings</h2>
          <nav className="settings-nav">
            <button className={`settings-nav-item ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>
              Profile
            </button>
            <button className={`settings-nav-item ${tab === 'audio-stack' ? 'active' : ''}`} onClick={() => setTab('audio-stack')}>
              Audio
            </button>
            <button className={`settings-nav-item ${tab === 'video' ? 'active' : ''}`} onClick={() => setTab('video')}>
              Video
            </button>
            <button className={`settings-nav-item ${tab === 'theme' ? 'active' : ''}`} onClick={() => setTab('theme')}>
              Theme
            </button>
            <button className={`settings-nav-item ${tab === 'devices' ? 'active' : ''}`} onClick={() => setTab('devices')}>
              Devices{pendingDevices.length > 0 && <span className="pending-badge">{pendingDevices.length}</span>}
            </button>
            <button className={`settings-nav-item ${tab === 'notifications' ? 'active' : ''}`} onClick={() => setTab('notifications')}>
              Notifications
            </button>
          </nav>
          <div className="settings-nav-footer">
            <button className="danger-btn settings-logout-btn" onClick={logout}>Log Out</button>
          </div>
        </div>

        <div className="settings-content">
          <div className="settings-content-header">
            <h2>{tab === 'profile' ? 'Profile' : tab === 'audio-stack' ? 'Audio' : tab === 'video' ? 'Video' : tab === 'theme' ? 'Theme' : tab === 'devices' ? 'Devices' : 'Notifications'}</h2>
            <button className="close-btn" onClick={handleClose}>✕</button>
          </div>

        {tab === 'profile' && (
          <div className="settings-body">
            <div className="profile-preview-card">
              <span className="profile-preview-status-dot online" />
              <div className="profile-preview-info">
                <span className="profile-preview-name" style={{ color: nameColor || 'var(--text-primary)' }}>
                  {displayName || user?.display_name || 'Display Name'}
                </span>
                {customStatus ? (
                  <span className="profile-preview-status">{customStatus}</span>
                ) : (
                  <span className="profile-preview-username">@{user?.username}</span>
                )}
              </div>
            </div>

            <h3 className="settings-section">Display Name</h3>
            <input
              type="text"
              className="settings-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name"
              maxLength={32}
            />

            <h3 className="settings-section">Custom Status</h3>
            <input
              type="text"
              className="settings-input"
              value={customStatus}
              onChange={(e) => setCustomStatus(e.target.value)}
              placeholder="What's on your mind?"
              maxLength={128}
            />

            <h3 className="settings-section">Name Color</h3>
            <div className="color-picker-section">
              <div className="color-presets">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c || 'default'}
                    className={`color-preset ${nameColor === c ? 'selected' : ''}`}
                    style={{ background: c || 'var(--text-primary)' }}
                    onClick={() => setNameColor(c)}
                    title={c || 'Default'}
                  >
                    {nameColor === c && '✓'}
                  </button>
                ))}
              </div>
              <div className="color-custom-row">
                <input
                  type="color"
                  value={nameColor || '#e0e0e0'}
                  onChange={(e) => setNameColor(e.target.value)}
                  className="color-picker-input"
                />
                <span className="color-preview-text" style={{ color: nameColor || 'var(--text-primary)' }}>
                  {displayName || 'Preview'}
                </span>
              </div>
            </div>

            <button
              className="save-btn settings-save-btn"
              onClick={handleSaveProfile}
              disabled={profileSaving}
            >
              {profileSaved ? '✓ Saved!' : profileSaving ? 'Saving...' : 'Save Profile'}
            </button>
          </div>
        )}

        {tab === 'video' && (
          loading ? (
            <p className="settings-loading">Loading devices...</p>
          ) : (
            <div className="settings-body">
              <h3 className="settings-section">Camera</h3>
              <select
                value={settings.videoDevice}
                onChange={(e) => update({ videoDevice: e.target.value })}
              >
                <option value="">Default</option>
                {videoInputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              <button className="settings-preview-btn" onClick={toggleCameraPreview}>
                {cameraStream ? 'Stop Preview' : 'Preview Camera'}
              </button>
              {cameraStream && (
                <video
                  className="settings-camera-preview"
                  autoPlay
                  playsInline
                  muted
                  ref={(el) => { if (el) el.srcObject = cameraStream }}
                />
              )}

              <h3 className="settings-section">Screen Share</h3>
              <label className="settings-slider">
                <span>Resolution</span>
                <select
                  value={settings.screenShareResolution}
                  onChange={(e) => update({ screenShareResolution: Number(e.target.value) })}
                >
                  <option value={0}>Native</option>
                  <option value={360}>360p</option>
                  <option value={480}>480p</option>
                  <option value={720}>720p</option>
                  <option value={1080}>1080p</option>
                  <option value={1440}>2K (1440p)</option>
                </select>
              </label>
              <label className="settings-slider">
                <span>Framerate</span>
                <select
                  value={settings.screenShareFramerate}
                  onChange={(e) => update({ screenShareFramerate: Number(e.target.value) })}
                >
                  <option value={15}>15 fps</option>
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                  <option value={120}>120 fps</option>
                </select>
              </label>
              <label className="settings-slider">
                <span>Max Bitrate</span>
                <select
                  value={settings.screenShareMaxBitrate}
                  onChange={(e) => update({ screenShareMaxBitrate: Number(e.target.value) })}
                >
                  <option value={0}>Auto</option>
                  <option value={1500}>1.5 Mbps (Low)</option>
                  <option value={3000}>3 Mbps</option>
                  <option value={5000}>5 Mbps</option>
                  <option value={8000}>8 Mbps (Default)</option>
                  <option value={12000}>12 Mbps</option>
                  <option value={20000}>20 Mbps (High)</option>
                  <option value={50000}>50 Mbps (Max)</option>
                </select>
              </label>
            </div>
          )
        )}
        {tab === 'theme' && (
          <div className="settings-body">
            <h3 className="settings-section">Theme</h3>
            <div className="theme-grid">
              {THEME_PRESETS.map((theme) => (
                <button
                  key={theme.id}
                  className={`theme-card ${activeTheme === theme.id ? 'selected' : ''}`}
                  onClick={() => {
                    setActiveTheme(theme.id)
                    saveThemeId(theme.id)
                    applyTheme(theme)
                  }}
                >
                  <div className="theme-card-preview">
                    <div className="theme-preview-sidebar" style={{ background: theme.colors['--bg-secondary'] }}>
                      <div className="theme-preview-dot" style={{ background: theme.colors['--accent'] }} />
                      <div className="theme-preview-dot" style={{ background: theme.colors['--text-muted'] }} />
                      <div className="theme-preview-dot" style={{ background: theme.colors['--text-muted'] }} />
                    </div>
                    <div className="theme-preview-main" style={{ background: theme.colors['--bg-primary'] }}>
                      <div className="theme-preview-msg" style={{ background: theme.colors['--bg-secondary'], borderColor: theme.colors['--border'] }} />
                      <div className="theme-preview-msg" style={{ background: theme.colors['--bg-secondary'], borderColor: theme.colors['--border'] }} />
                      <div className="theme-preview-input" style={{ background: theme.colors['--bg-input'], borderColor: theme.colors['--border'] }} />
                    </div>
                  </div>
                  <span className="theme-card-name">{theme.name}</span>
                  {activeTheme === theme.id && <span className="theme-card-check">✓</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === 'devices' && (
          <div className="settings-body">
            <h3 className="settings-section">E2E Devices</h3>
            <p className="settings-hint">Devices are used for end-to-end encryption. New devices require approval from an existing device before they can decrypt messages.</p>
            {!e2eLoaded ? (
              <p className="settings-loading">Loading devices...</p>
            ) : (
              <>
                {pendingDevices.length > 0 && (
                  <div className="device-section">
                    <h4 className="device-section-title">Pending Approval</h4>
                    {pendingDevices.map((d) => (
                      <div key={d.id} className="device-item pending">
                        <div className="device-info">
                          <span className="device-name">{d.name || 'Unnamed device'}</span>
                          <span className="device-id">{d.id.slice(0, 8)}…</span>
                          <span className="device-date">{new Date(d.created_at).toLocaleDateString()}</span>
                        </div>
                        <div className="device-actions">
                          <button className="approve-btn" onClick={async () => {
                            await api.approveDevice(d.id)
                            loadE2eDevices()
                          }}>Approve</button>
                          <button className="reject-btn" onClick={async () => {
                            await api.rejectDevice(d.id)
                            loadE2eDevices()
                          }}>Reject</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="device-section">
                  <h4 className="device-section-title">Approved Devices</h4>
                  {e2eDevices.filter(d => d.approved).map((d) => {
                    const isCurrent = d.id === localStorage.getItem('relay_device_id')
                    return (
                      <div key={d.id} className={`device-item ${isCurrent ? 'current' : ''}`}>
                        <div className="device-info">
                          <span className="device-name">{d.name || 'Unnamed device'}{isCurrent && ' (this device)'}</span>
                          <span className="device-id">{d.id.slice(0, 8)}…</span>
                          <span className="device-date">{new Date(d.created_at).toLocaleDateString()}</span>
                        </div>
                        {!isCurrent && (
                          <div className="device-actions">
                            <button className="reject-btn" onClick={async () => {
                              await api.deleteDevice(d.id)
                              loadE2eDevices()
                            }}>Remove</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'notifications' && (
          <div className="settings-body">
            <h3>Notification Settings</h3>

            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={settings.notifyMessages}
                onChange={(e) => {
                  const next = { ...settings, notifyMessages: e.target.checked }
                  setSettings(next)
                  saveSettings(next)
                }}
              />
              <span>Play sound for new messages</span>
            </label>

            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={settings.notifyMentions}
                onChange={(e) => {
                  const next = { ...settings, notifyMentions: e.target.checked }
                  setSettings(next)
                  saveSettings(next)
                }}
              />
              <span>Play sound for @mentions</span>
            </label>

            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={settings.notifyDMs}
                onChange={(e) => {
                  const next = { ...settings, notifyDMs: e.target.checked }
                  setSettings(next)
                  saveSettings(next)
                }}
              />
              <span>Play sound for direct messages</span>
            </label>

            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={settings.desktopNotifications}
                onChange={async (e) => {
                  let enabled = e.target.checked
                  if (enabled && Notification.permission !== 'granted') {
                    const perm = await Notification.requestPermission()
                    enabled = perm === 'granted'
                  }
                  const next = { ...settings, desktopNotifications: enabled }
                  setSettings(next)
                  saveSettings(next)
                }}
              />
              <span>Desktop notifications</span>
            </label>
          </div>
        )}

        {tab === 'audio-stack' && (
          loading ? (
            <p className="settings-loading">Loading devices...</p>
          ) : (
            <div className="settings-body">
              <h3 className="settings-section">Audio Input (Microphone)</h3>
              <select
                value={settings.audioInputDevice}
                onChange={(e) => update({ audioInputDevice: e.target.value })}
              >
                <option value="">Default</option>
                {audioInputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>

              <label className="settings-slider">
                <span>Input Volume</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={settings.inputVolume}
                  onChange={(e) => update({ inputVolume: Number(e.target.value) })}
                />
                <span className="slider-value">{settings.inputVolume}%</span>
              </label>

              <h3 className="settings-section">Audio Output (Speakers)</h3>
              {audioOutputs.length > 0 ? (
                <select
                  value={settings.audioOutputDevice}
                  onChange={(e) => update({ audioOutputDevice: e.target.value })}
                >
                  <option value="">Default</option>
                  {audioOutputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Speaker ${d.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="settings-note">Output device selection not supported in this browser</p>
              )}

              <label className="settings-slider">
                <span>Output Volume</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={settings.outputVolume}
                  onChange={(e) => update({ outputVolume: Number(e.target.value) })}
                />
                <span className="slider-value">{settings.outputVolume}%</span>
              </label>

              <h3 className="settings-section">Audio Mode</h3>
              <div className="settings-radio-group">
                <label className="settings-toggle">
                  <input
                    type="radio"
                    name="channelCount"
                    checked={settings.channelCount === 1}
                    onChange={() => update({ channelCount: 1 })}
                  />
                  <span>Mono (recommended for voice)</span>
                </label>
                <label className="settings-toggle">
                  <input
                    type="radio"
                    name="channelCount"
                    checked={settings.channelCount === 2}
                    onChange={() => update({ channelCount: 2 })}
                  />
                  <span>Stereo</span>
                </label>
              </div>

              <h3 className="settings-section">Signal Chain</h3>
              <p className="settings-hint">
                Click a node to enable/disable. Drag to reorder. Click ✏️ to expand settings.
              </p>

              <div className="audio-chain-diagram">
                <span className="audio-chain-node">🎤 Mic</span>
                <span className="audio-chain-arrow">→</span>
                {settings.audioChainOrder.filter(n => n === 'eq' || n === 'noisegate').map((nodeId, idx, arr) => {
                  const isActive = nodeId === 'eq' ? (settings.eqBands || []).some(b => b.gain !== 0)
                    : settings.noiseGateEnabled
                  const label = nodeId === 'eq' ? 'EQ' : 'Noise Gate'
                  return (
                    <span key={nodeId} style={{ display: 'contents' }}>
                      <span
                        className={`audio-chain-node interactive ${isActive ? 'active' : 'bypassed'} ${draggedNode === nodeId ? 'dragging' : ''}`}
                        draggable
                        onDragStart={() => setDraggedNode(nodeId)}
                        onDragEnd={() => setDraggedNode(null)}
                        onDragOver={(e) => {
                          e.preventDefault()
                          if (draggedNode && draggedNode !== nodeId) {
                            const order = [...settings.audioChainOrder]
                            const fromIdx = order.indexOf(draggedNode)
                            const toIdx = order.indexOf(nodeId)
                            if (fromIdx !== -1 && toIdx !== -1) {
                              order.splice(fromIdx, 1)
                              order.splice(toIdx, 0, draggedNode)
                              update({ audioChainOrder: order })
                            }
                          }
                        }}
                      >
                        <span
                          className="audio-chain-node-label"
                          onClick={() => {
                            if (nodeId === 'eq') {
                              const allZero = (settings.eqBands || []).every(b => b.gain === 0)
                              if (allZero) {
                                update({ eqBands: (settings.eqBands || []).map((b, i) => ({ ...b, gain: [2, 3, 1, 0, -1, 0, 1, 2, 3, 2][i] || 0 })) })
                              } else {
                                update({ eqBands: (settings.eqBands || []).map(b => ({ ...b, gain: 0 })) })
                              }
                            } else update({ noiseGateEnabled: !settings.noiseGateEnabled })
                          }}
                        >{label}</span>
                        <span
                          className={`audio-chain-node-edit ${expandedNode === nodeId ? 'expanded' : ''}`}
                          onClick={(e) => { e.stopPropagation(); setExpandedNode(expandedNode === nodeId ? null : nodeId) }}
                        >✏️</span>
                      </span>
                      {idx < arr.length - 1 && (
                        <span className="audio-chain-arrow">→</span>
                      )}
                    </span>
                  )
                })}
                <span className="audio-chain-arrow">→</span>
                <span className="audio-chain-node">🔊 Output</span>
              </div>

              {expandedNode === 'eq' && (
                <div className="audio-chain-settings">
                  <h4>Parametric Equalizer</h4>
                  <p className="settings-hint">Drag handles on the spectrum. Right-click a handle to change filter type. ±12 dB per band.</p>
                  <div className="eq-sliders-grid">
                    {(settings.eqBands || []).map((band, i) => {
                      const typeLabels: Record<string, string> = { peaking: 'PK', lowpass: 'LP', highpass: 'HP', lowshelf: 'LS', highshelf: 'HS' }
                      return (
                        <label className="eq-band-slider" key={i}>
                          <span className="eq-band-freq">{band.freq >= 1000 ? `${(band.freq / 1000).toFixed(band.freq % 1000 === 0 ? 0 : 1)}k` : `${band.freq}`}</span>
                          <span className="eq-band-type">{typeLabels[band.type] || 'PK'}</span>
                          <input
                            type="range"
                            min={-12}
                            max={12}
                            step={1}
                            value={band.gain}
                            className="eq-band-range"
                            onChange={(e) => {
                              const bands = [...(settings.eqBands || [])]
                              bands[i] = { ...bands[i]!, gain: Number(e.target.value) }
                              update({ eqBands: bands })
                            }}
                          />
                          <span className="eq-band-db">{band.gain > 0 ? '+' : ''}{band.gain}</span>
                        </label>
                      )
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <button className="settings-preview-btn" onClick={() => update({ eqBands: (settings.eqBands || []).map(b => ({ ...b, gain: 0 })) })}>
                      Flat
                    </button>
                    <button className="settings-preview-btn" onClick={() => update({ eqBands: (settings.eqBands || []).map((b, i) => ({ ...b, gain: [4, 3, 1, 0, -1, -1, 0, 2, 3, 4][i] || 0 })) })}>
                      Bass Boost
                    </button>
                    <button className="settings-preview-btn" onClick={() => update({ eqBands: (settings.eqBands || []).map((b, i) => ({ ...b, gain: [-2, -1, 0, 2, 4, 4, 2, 0, -1, -2][i] || 0 })) })}>
                      Vocal
                    </button>
                    <button className="settings-preview-btn" onClick={() => update({ eqBands: (settings.eqBands || []).map((b, i) => ({ ...b, gain: [0, 0, -1, -2, 0, 2, 4, 5, 4, 3][i] || 0 })) })}>
                      Treble Boost
                    </button>
                  </div>
                </div>
              )}

              {expandedNode === 'noisegate' && (
                <div className="audio-chain-settings">
                  <h4>Noise Gate</h4>
                  <label className="settings-slider">
                    <span>Threshold</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={settings.noiseGateThreshold}
                      onChange={(e) => update({ noiseGateThreshold: Number(e.target.value) })}
                    />
                    <span className="slider-value">{settings.noiseGateThreshold}</span>
                  </label>
                  <label className="settings-slider">
                    <span>Hold</span>
                    <input
                      type="range"
                      min={50}
                      max={1000}
                      step={10}
                      value={settings.noiseGateHold}
                      onChange={(e) => update({ noiseGateHold: Number(e.target.value) })}
                    />
                    <span className="slider-value">{settings.noiseGateHold} ms</span>
                  </label>
                  <label className="settings-slider">
                    <span>Attack</span>
                    <input
                      type="range"
                      min={1}
                      max={100}
                      value={settings.noiseGateAttack}
                      onChange={(e) => update({ noiseGateAttack: Number(e.target.value) })}
                    />
                    <span className="slider-value">{settings.noiseGateAttack} ms</span>
                  </label>
                  <label className="settings-slider">
                    <span>Release</span>
                    <input
                      type="range"
                      min={10}
                      max={500}
                      step={5}
                      value={settings.noiseGateRelease}
                      onChange={(e) => update({ noiseGateRelease: Number(e.target.value) })}
                    />
                    <span className="slider-value">{settings.noiseGateRelease} ms</span>
                  </label>
                </div>
              )}

              <h3 className="settings-section">Browser Processing</h3>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.noiseSuppression}
                  onChange={(e) => update({ noiseSuppression: e.target.checked })}
                />
                <span>Noise Suppression</span>
              </label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.echoCancellation}
                  onChange={(e) => update({ echoCancellation: e.target.checked })}
                />
                <span>Echo Cancellation</span>
              </label>

              <div style={{ position: 'relative', display: 'inline-block' }}>
                <canvas
                  ref={spectrumCanvasRef}
                  className="spectrum-analyzer"
                  width={600}
                  height={140}
                  onMouseDown={(e) => { setEqContextMenu(null); handleSpectrumMouseDown(e) }}
                  onMouseMove={handleSpectrumMouseMove}
                  onMouseUp={handleSpectrumMouseUp}
                  onMouseLeave={handleSpectrumMouseUp}
                  onContextMenu={handleSpectrumContextMenu}
                />
                {eqContextMenu && (() => {
                  const canvasRect = spectrumCanvasRef.current?.getBoundingClientRect()
                  const menuX = canvasRect ? eqContextMenu.x - canvasRect.left : 0
                  const menuY = canvasRect ? eqContextMenu.y - canvasRect.top : 0
                  const band = settings.eqBands?.[eqContextMenu.bandIdx]
                  const types: { label: string; value: 'peaking' | 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf' }[] = [
                    { label: 'Peaking', value: 'peaking' },
                    { label: 'Low Shelf', value: 'lowshelf' },
                    { label: 'High Shelf', value: 'highshelf' },
                    { label: 'Low Pass', value: 'lowpass' },
                    { label: 'High Pass', value: 'highpass' },
                  ]
                  return (
                    <div
                      className="eq-context-menu"
                      style={{ position: 'absolute', left: menuX, top: menuY, zIndex: 100 }}
                      onMouseLeave={() => setEqContextMenu(null)}
                    >
                      <div className="eq-context-label">Band {eqContextMenu.bandIdx + 1} — {Math.round(band?.freq ?? 0)} Hz</div>
                      {types.map(t => (
                        <button
                          key={t.value}
                          className={`eq-context-item${band?.type === t.value ? ' active' : ''}`}
                          onClick={() => {
                            const bands = [...(settings.eqBands || [])]
                            if (bands[eqContextMenu.bandIdx]) {
                              bands[eqContextMenu.bandIdx] = { ...bands[eqContextMenu.bandIdx]!, type: t.value }
                              update({ eqBands: bands })
                            }
                            setEqContextMenu(null)
                          }}
                        >{t.label}</button>
                      ))}
                    </div>
                  )
                })()}
              </div>
              <p className="settings-hint" style={{ marginTop: 4 }}>
                Drag EQ handles to shape your sound. Right-click a handle to change filter type. Drag the gate line to adjust threshold.
              </p>
              <button className="settings-preview-btn" onClick={toggleMicTest}>
                {micTestStream ? '⏹ Stop Mic Test' : '🎤 Test Microphone'}
              </button>
            </div>
          )
        )}

        </div>
      </div>
    </div>
  )
}
