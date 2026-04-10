import { useEffect, useRef, useState, useCallback } from 'react'
import { getSettings, saveSettings, getDevices, defaults as settingsDefaults, type MediaSettings, THEME_PRESETS, getThemeId, saveThemeId, applyTheme, getAllThemes, getCustomThemes, saveCustomThemes, type Theme, type ThemeColors, getTextSettings, saveTextSettings, applyTextSettings, type TextSettings, FONT_OPTIONS, DEFAULT_TEXT_SETTINGS } from '../services/settings'
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
  const [customThemes, setCustomThemes] = useState<Theme[]>(getCustomThemes)
  const [nativeTitlebar, setNativeTitlebar] = useState(false)
  const [editingTheme, setEditingTheme] = useState<Theme | null>(null)
  const [textSettings, setTextSettingsState] = useState<TextSettings>(getTextSettings)
  const [micTestStream, setMicTestStream] = useState<MediaStream | null>(null)
  const [, setMicLevel] = useState(0)
  const [expandedNode, setExpandedNode] = useState<string | null>(null)
  const [draggedNode, setDraggedNode] = useState<string | null>(null)
  const [eqContextMenu, setEqContextMenu] = useState<{ x: number; y: number; bandIdx: number } | null>(null)
  const eqLongPressRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [cameraCapabilities, setCameraCapabilities] = useState<Record<string, unknown> | null>(null)
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
    // Load native titlebar preference in Electron
    if ((window as any).electronAPI?.getNativeTitlebar) {
      (window as any).electronAPI.getNativeTitlebar().then(setNativeTitlebar)
    }
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
        let stream: MediaStream
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              noiseSuppression: curSettings.noiseSuppression,
              echoCancellation: false,
              autoGainControl: curSettings.autoGainControl,
              ...(curSettings.audioInputDevice ? { deviceId: { exact: curSettings.audioInputDevice } } : {}),
            },
          })
        } catch {
          // Fallback: retry with basic constraints if specific ones are rejected
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: curSettings.audioInputDevice ? { deviceId: { ideal: curSettings.audioInputDevice } } : true,
            })
          } catch {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          }
        }
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

    // Sync canvas backing store to CSS display size × devicePixelRatio for crisp text
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const displayW = Math.round(rect.width * dpr)
    const displayH = Math.round(rect.height * dpr)
    if (canvas.width !== displayW || canvas.height !== displayH) {
      canvas.width = displayW
      canvas.height = displayH
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0) // scale all drawing by dpr

    // Use CSS pixel dimensions for all drawing math
    const w = rect.width, h = rect.height
    const liveS = getSettings()
    const sr = spectrumSampleRateRef.current
    const nyquist = sr / 2
    const minF = 20, maxF = Math.min(nyquist, 20000)
    const logMin = Math.log10(minF), logMax = Math.log10(maxF), logRange = logMax - logMin

    // Layout: leave 30px left margin for dB labels, 14px bottom margin for freq labels
    const mL = 30, mB = 14, mT = 4
    const plotW = w - mL, plotH = h - mB - mT

    // dB range: +24 at top, -60 at bottom (-inf). Linear from +24 to -24 in 90% of height, -24 to -60 compressed in bottom 10%
    const maxDb = 24, minDb = -60, linearDb = -24
    const linearPct = 0.9 // top 90% is +24..-24 linear
    const dbToY = (db: number): number => {
      let py: number
      if (db >= linearDb) {
        py = (1 - (db - linearDb) / (maxDb - linearDb)) * linearPct * plotH
      } else {
        py = (linearPct + (1 - linearPct) * (1 - (db - minDb) / (linearDb - minDb))) * plotH
      }
      return mT + py
    }

    c.clearRect(0, 0, w, h)
    c.fillStyle = '#141419'
    c.fillRect(0, 0, w, h)

    // Band colors for per-band fills (ReaEQ style)
    const bandColors = [
      '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9',
      '#4dabf7', '#748ffc', '#9775fa', '#da77f2', '#f783ac',
    ]

    // Per-band gain calculation
    const bandGainAt = (band: { freq: number; gain: number; type?: string }, freq: number): number => {
      const t = band.type || 'peaking'
      if (t === 'peaking') {
        const octaveDist = Math.log2(freq / band.freq)
        return band.gain * Math.exp(-0.5 * Math.pow(octaveDist / 0.75, 2))
      } else if (t === 'lowshelf') {
        return band.gain / (1 + Math.pow(freq / band.freq, 2))
      } else if (t === 'highshelf') {
        return band.gain / (1 + Math.pow(band.freq / freq, 2))
      } else if (t === 'lowpass') {
        const ratio = freq / band.freq
        return ratio > 1 ? -(12 * Math.log2(ratio) * Math.abs(band.gain) / 12) : 0
      } else if (t === 'highpass') {
        const ratio = band.freq / freq
        return ratio > 1 ? -(12 * Math.log2(ratio) * Math.abs(band.gain) / 12) : 0
      }
      return 0
    }

    const zeroY = dbToY(0)

    // Draw dB grid lines
    c.font = '10px Inter, system-ui, sans-serif'
    c.textBaseline = 'middle'
    c.textAlign = 'right'
    const dbLines = [24, 18, 12, 6, 0, -6, -12, -18, -24]
    for (const db of dbLines) {
      const gy = dbToY(db)
      c.strokeStyle = db === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)'
      c.lineWidth = db === 0 ? 1 : 0.5
      c.beginPath()
      c.moveTo(mL, gy)
      c.lineTo(w, gy)
      c.stroke()
      c.fillStyle = db === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.25)'
      const label = db === 0 ? '0' : `${db > 0 ? '+' : ''}${db}`
      c.fillText(label, mL - 4, gy)
    }
    c.fillStyle = 'rgba(255,255,255,0.15)'
    c.fillText('-∞', mL - 4, mT + plotH - 2)

    // Frequency grid lines
    c.textAlign = 'center'
    c.textBaseline = 'top'
    const freqLines = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
    for (const f of freqLines) {
      if (f > maxF) continue
      const fx = mL + ((Math.log10(f) - logMin) / logRange) * plotW
      c.strokeStyle = 'rgba(255,255,255,0.05)'
      c.lineWidth = 0.5
      c.beginPath()
      c.moveTo(fx, mT)
      c.lineTo(fx, mT + plotH)
      c.stroke()
      const label = f >= 1000 ? `${f / 1000}k` : `${f}`
      c.fillStyle = 'rgba(255,255,255,0.25)'
      c.fillText(label, fx, mT + plotH + 2)
    }

    // Spectrum analyzer - smooth filled area with gradient
    c.beginPath()
    c.moveTo(mL, mT + plotH)
    for (let px = 0; px < plotW; px++) {
      const f0 = Math.pow(10, logMin + (px / plotW) * logRange)
      const f1 = Math.pow(10, logMin + ((px + 1) / plotW) * logRange)
      const bin0 = Math.floor((f0 / nyquist) * dataArray.length)
      const bin1 = Math.ceil((f1 / nyquist) * dataArray.length)
      let maxAmp = 0
      for (let b = Math.max(0, bin0); b <= Math.min(dataArray.length - 1, bin1); b++) {
        if (dataArray[b]! > maxAmp) maxAmp = dataArray[b]!
      }
      c.lineTo(mL + px, mT + plotH - (maxAmp / 255) * plotH)
    }
    c.lineTo(mL + plotW, mT + plotH)
    c.closePath()
    const specGrad = c.createLinearGradient(0, mT, 0, mT + plotH)
    specGrad.addColorStop(0, 'rgba(78, 205, 196, 0.18)')
    specGrad.addColorStop(1, 'rgba(78, 205, 196, 0.02)')
    c.fillStyle = specGrad
    c.fill()

    // Per-band colored fill regions + composite curve + handles
    const bands = liveS.eqBands || []
    if (bands.length > 0) {
      // Individual band fills (colored regions between curve and 0dB)
      for (let i = 0; i < bands.length; i++) {
        const band = bands[i]!
        if (Math.abs(band.gain) < 0.5) continue
        const color = bandColors[i % bandColors.length]!

        // Fill region
        c.beginPath()
        c.moveTo(mL, zeroY)
        for (let px = 0; px <= plotW; px += 2) {
          const freq = Math.pow(10, logMin + (px / plotW) * logRange)
          c.lineTo(mL + px, dbToY(Math.max(minDb, Math.min(maxDb, bandGainAt(band, freq)))))
        }
        c.lineTo(mL + plotW, zeroY)
        c.closePath()
        c.fillStyle = color + '15'
        c.fill()

        // Subtle individual curve line
        c.beginPath()
        for (let px = 0; px <= plotW; px += 2) {
          const freq = Math.pow(10, logMin + (px / plotW) * logRange)
          const y = dbToY(Math.max(minDb, Math.min(maxDb, bandGainAt(band, freq))))
          if (px === 0) c.moveTo(mL, y)
          else c.lineTo(mL + px, y)
        }
        c.strokeStyle = color + '35'
        c.lineWidth = 1
        c.stroke()
      }

      // Composite curve fill (subtle white gradient between curve and 0dB)
      c.beginPath()
      c.moveTo(mL, zeroY)
      for (let px = 0; px <= plotW; px++) {
        const freq = Math.pow(10, logMin + (px / plotW) * logRange)
        let g = 0
        for (const band of bands) g += bandGainAt(band, freq)
        c.lineTo(mL + px, dbToY(Math.max(minDb, Math.min(maxDb, g))))
      }
      c.lineTo(mL + plotW, zeroY)
      c.closePath()
      const compGrad = c.createLinearGradient(0, mT, 0, mT + plotH)
      compGrad.addColorStop(0, 'rgba(255,255,255,0.06)')
      compGrad.addColorStop(0.5, 'rgba(255,255,255,0.02)')
      compGrad.addColorStop(1, 'rgba(255,255,255,0.0)')
      c.fillStyle = compGrad
      c.fill()

      // Composite EQ curve (thick white line with glow)
      c.save()
      c.beginPath()
      for (let px = 0; px <= plotW; px++) {
        const freq = Math.pow(10, logMin + (px / plotW) * logRange)
        let g = 0
        for (const band of bands) g += bandGainAt(band, freq)
        const y = dbToY(Math.max(minDb, Math.min(maxDb, g)))
        if (px === 0) c.moveTo(mL, y)
        else c.lineTo(mL + px, y)
      }
      c.strokeStyle = 'rgba(255,255,255,0.9)'
      c.lineWidth = 2
      c.shadowColor = 'rgba(255,255,255,0.3)'
      c.shadowBlur = 6
      c.stroke()
      c.restore()

      // Band handles - numbered circles (ReaEQ style)
      for (let i = 0; i < bands.length; i++) {
        const band = bands[i]!
        const bx = mL + ((Math.log10(Math.max(band.freq, minF)) - logMin) / logRange) * plotW
        const by = dbToY(band.gain)
        const color = bandColors[i % bandColors.length]!
        const active = Math.abs(band.gain) >= 0.5

        c.save()
        if (active) { c.shadowColor = color; c.shadowBlur = 8 }
        c.beginPath()
        c.arc(bx, by, 8, 0, Math.PI * 2)
        c.fillStyle = active ? color : '#333'
        c.fill()
        c.strokeStyle = active ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.2)'
        c.lineWidth = 1.5
        c.stroke()
        c.restore()

        c.fillStyle = active ? '#fff' : '#777'
        c.font = 'bold 9px Inter, system-ui, sans-serif'
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText(`${i + 1}`, bx, by)
      }
      c.textAlign = 'start'
    }

    // Noise gate threshold line
    if (liveS.noiseGateEnabled) {
      const ngY = mT + plotH - (liveS.noiseGateThreshold / 100) * plotH
      c.strokeStyle = '#e94560'
      c.lineWidth = 2
      c.setLineDash([6, 4])
      c.beginPath()
      c.moveTo(mL, ngY)
      c.lineTo(w, ngY)
      c.stroke()
      c.setLineDash([])
      c.fillStyle = '#e94560'
      c.font = '10px Inter, sans-serif'
      c.fillText(`Gate ${liveS.noiseGateThreshold}%`, mL + 4, ngY > mT + 16 ? ngY - 4 : ngY + 14)
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
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
      } catch {
        // Fallback: some browsers/devices reject specific constraints — retry with basic audio
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: curSettings.audioInputDevice ? { deviceId: { ideal: curSettings.audioInputDevice } } : true,
          })
        } catch {
          // Final fallback: most basic request
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        }
      }
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
      setCameraCapabilities(null)
      return
    }
    try {
      const camSettings = settings.cameraSettings || {}
      const videoConstraints: MediaTrackConstraints = settings.videoDevice
        ? { deviceId: { exact: settings.videoDevice } }
        : {}
      // Apply stored resolution
      if (camSettings.resolution && camSettings.resolution !== 'default') {
        const [rw, rh] = camSettings.resolution.split('x').map(Number)
        if (rw && rh) { videoConstraints.width = { ideal: rw }; videoConstraints.height = { ideal: rh } }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: Object.keys(videoConstraints).length > 0 ? videoConstraints : true })
      setCameraStream(stream)
      // Detect capabilities
      const track = stream.getVideoTracks()[0]
      if (track) {
        try {
          const caps = track.getCapabilities?.() as Record<string, unknown> | undefined
          if (caps) setCameraCapabilities(caps)
        } catch { /* getCapabilities not supported */ }
        // Apply stored camera settings
        const advanced: Record<string, unknown> = {}
        if (camSettings.whiteBalanceMode) advanced.whiteBalanceMode = camSettings.whiteBalanceMode
        if (camSettings.exposureMode) advanced.exposureMode = camSettings.exposureMode
        if (camSettings.focusMode) advanced.focusMode = camSettings.focusMode
        if (camSettings.exposureCompensation != null) advanced.exposureCompensation = camSettings.exposureCompensation
        if (camSettings.exposureTime != null) advanced.exposureTime = camSettings.exposureTime
        if (camSettings.iso != null) advanced.iso = camSettings.iso
        if (camSettings.brightness != null) advanced.brightness = camSettings.brightness
        if (camSettings.contrast != null) advanced.contrast = camSettings.contrast
        if (camSettings.saturation != null) advanced.saturation = camSettings.saturation
        if (camSettings.colorTemperature != null) advanced.colorTemperature = camSettings.colorTemperature
        if (camSettings.sharpness != null) advanced.sharpness = camSettings.sharpness
        if (Object.keys(advanced).length > 0) {
          try { await track.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints) } catch { /* unsupported */ }
        }
      }
    } catch { /* camera not available */ }
  }

  const resetCameraToAuto = async () => {
    const autoSettings: typeof settings.cameraSettings = {
      resolution: 'default',
      whiteBalanceMode: 'continuous',
      exposureMode: 'continuous',
      focusMode: 'continuous',
    }
    update({ cameraSettings: autoSettings })
    const track = cameraStream?.getVideoTracks()[0]
    if (track) {
      // Restart stream at default resolution
      cameraStream?.getTracks().forEach((t) => t.stop())
      try {
        const videoConstraints: MediaTrackConstraints = settings.videoDevice
          ? { deviceId: { exact: settings.videoDevice } }
          : {}
        const stream = await navigator.mediaDevices.getUserMedia({ video: Object.keys(videoConstraints).length > 0 ? videoConstraints : true })
        setCameraStream(stream)
        const newTrack = stream.getVideoTracks()[0]
        if (newTrack) {
          try {
            const caps = newTrack.getCapabilities?.() as Record<string, unknown> | undefined
            if (caps) setCameraCapabilities(caps)
          } catch { /* */ }
          try {
            await newTrack.applyConstraints({ advanced: [{
              whiteBalanceMode: 'continuous',
              exposureMode: 'continuous',
              focusMode: 'continuous',
            }] } as unknown as MediaTrackConstraints)
          } catch { /* */ }
        }
      } catch { /* camera not available */ }
    }
  }

  const applyCameraSetting = async (key: string, value: unknown) => {
    const camSettings = { ...(settings.cameraSettings || {}), [key]: value }
    update({ cameraSettings: camSettings })
    if (key === 'resolution' && cameraStream) {
      // Resolution changes need a stream restart
      cameraStream.getTracks().forEach((t) => t.stop())
      try {
        const videoConstraints: MediaTrackConstraints = settings.videoDevice
          ? { deviceId: { exact: settings.videoDevice } }
          : {}
        if (value && value !== 'default') {
          const [rw, rh] = (value as string).split('x').map(Number)
          if (rw && rh) { videoConstraints.width = { ideal: rw }; videoConstraints.height = { ideal: rh } }
        }
        const stream = await navigator.mediaDevices.getUserMedia({ video: Object.keys(videoConstraints).length > 0 ? videoConstraints : true })
        setCameraStream(stream)
        // Re-apply other camera settings to new track
        const track = stream.getVideoTracks()[0]
        if (track) {
          const advanced: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(camSettings)) {
            if (k !== 'resolution' && v != null) advanced[k] = v
          }
          if (Object.keys(advanced).length > 0) {
            try { await track.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints) } catch { /* unsupported */ }
          }
        }
      } catch { /* camera not available */ }
      return
    }
    const track = cameraStream?.getVideoTracks()[0]
    if (track) {
      try { await track.applyConstraints({ advanced: [{ [key]: value }] } as MediaTrackConstraints) } catch { /* unsupported */ }
    }
  }

  // Spectrum analyzer canvas mouse handlers for dragging EQ band handles / noise gate
  const spectrumLogParams = () => {
    const sr = spectrumSampleRateRef.current
    const nyquist = sr / 2
    const minF = 20, maxF = Math.min(nyquist, 20000)
    const logMin = Math.log10(minF), logMax = Math.log10(maxF), logRange = logMax - logMin
    return { nyquist, minF, maxF, logMin, logMax, logRange }
  }

  // dB <-> Y coordinate mapping (must match drawSpectrum margins: mL=30, mB=14, mT=4)
  const spectrumMargins = { mL: 30, mB: 14, mT: 4 }
  const spectrumDbToY = (db: number, h: number): number => {
    const { mT, mB } = spectrumMargins
    const plotH = h - mB - mT
    const maxDb = 24, minDb = -60, linearDb = -24, linearPct = 0.9
    let py: number
    if (db >= linearDb) py = (1 - (db - linearDb) / (maxDb - linearDb)) * linearPct * plotH
    else py = (linearPct + (1 - linearPct) * (1 - (db - minDb) / (linearDb - minDb))) * plotH
    return mT + py
  }
  const spectrumYToDb = (y: number, h: number): number => {
    const { mT, mB } = spectrumMargins
    const plotH = h - mB - mT
    const maxDb = 24, minDb = -60, linearDb = -24, linearPct = 0.9
    const pct = (y - mT) / plotH
    if (pct <= linearPct) return linearDb + (1 - pct / linearPct) * (maxDb - linearDb)
    return minDb + (1 - (pct - linearPct) / (1 - linearPct)) * (linearDb - minDb)
  }
  const spectrumXToFreq = (x: number, w: number): number => {
    const { mL } = spectrumMargins
    const plotW = w - mL
    const { logMin, logRange } = spectrumLogParams()
    return Math.pow(10, logMin + ((x - mL) / plotW) * logRange)
  }
  const spectrumFreqToX = (freq: number, w: number): number => {
    const { mL } = spectrumMargins
    const plotW = w - mL
    const { logMin, logRange, minF } = spectrumLogParams()
    return mL + ((Math.log10(Math.max(freq, minF)) - logMin) / logRange) * plotW
  }

  const handleSpectrumMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = spectrumCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const w = rect.width, h = rect.height
    const prox = 16

    // Check EQ band handles
    const bands = settings.eqBands || []
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i]!
      const bx = spectrumFreqToX(band.freq, w)
      const by = spectrumDbToY(band.gain, h)
      const dist = Math.sqrt((x - bx) ** 2 + (y - by) ** 2)
      if (dist < prox) { canvasDragRef.current = { type: 'eq', bandIdx: i }; return }
    }
    // Check noise gate threshold line
    if (settings.noiseGateEnabled) {
      const { mT, mB } = spectrumMargins
      const plotH = h - mB - mT
      const ngY = mT + plotH - (settings.noiseGateThreshold / 100) * plotH
      if (Math.abs(y - ngY) < prox) { canvasDragRef.current = { type: 'noisegate' }; return }
    }
  }

  const handleSpectrumMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = canvasDragRef.current
    if (!drag) return
    const canvas = spectrumCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    if (drag.type === 'eq') {
      const freq = spectrumXToFreq(x, rect.width)
      const clampedFreq = Math.round(Math.max(20, Math.min(20000, freq)))
      const gain = Math.round(Math.max(-60, Math.min(24, spectrumYToDb(y, rect.height))))
      const bands = [...(settings.eqBands || [])]
      if (bands[drag.bandIdx]) {
        bands[drag.bandIdx] = { ...bands[drag.bandIdx]!, freq: clampedFreq, gain }
        update({ eqBands: bands })
      }
    } else if (drag.type === 'noisegate') {
      const { mT, mB } = spectrumMargins
      const plotH = rect.height - mB - mT
      const threshold = Math.round(Math.max(0, Math.min(100, (1 - (y - mT) / plotH) * 100)))
      update({ noiseGateThreshold: threshold })
    }
  }

  const handleSpectrumMouseUp = () => { canvasDragRef.current = null }

  const handleSpectrumContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = spectrumCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const w = rect.width, h = rect.height

    const bands = settings.eqBands || []
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i]!
      const bx = spectrumFreqToX(band.freq, w)
      const by = spectrumDbToY(band.gain, h)
      if (Math.sqrt((x - bx) ** 2 + (y - by) ** 2) < 16) {
        setEqContextMenu({ x: e.clientX, y: e.clientY, bandIdx: i })
        return
      }
    }
    setEqContextMenu(null)
  }

  const handleSpectrumTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = spectrumCanvasRef.current
    if (!canvas) return
    const touch = e.touches[0]
    if (!touch) return
    const rect = canvas.getBoundingClientRect()
    const x = touch.clientX - rect.left
    const y = touch.clientY - rect.top
    const w = rect.width, h = rect.height
    const bands = settings.eqBands || []
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i]!
      const bx = spectrumFreqToX(band.freq, w)
      const by = spectrumDbToY(band.gain, h)
      if (Math.sqrt((x - bx) ** 2 + (y - by) ** 2) < 24) {
        const cx = touch!.clientX, cy = touch!.clientY
        eqLongPressRef.current = setTimeout(() => {
          setEqContextMenu({ x: cx, y: cy, bandIdx: i })
        }, 500)
        return
      }
    }
  }

  // EQ Export (EqualizerAPO format)
  const handleEqExport = () => {
    const bands = settings.eqBands || []
    const typeMap: Record<string, string> = { peaking: 'PK', lowpass: 'LP', highpass: 'HP', lowshelf: 'LSC', highshelf: 'HSC' }
    const lines = bands.map((b, i) => {
      const ft = typeMap[b.type] || 'PK'
      return `Filter ${i + 1}: ON ${ft} Fc ${b.freq} Hz Gain ${b.gain.toFixed(1)} dB Q 1.400`
    })
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'eq-preset.txt'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // EQ Import (EqualizerAPO format)
  const handleEqImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.txt,.text'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const text = reader.result as string
        const typeMap: Record<string, 'peaking' | 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf'> = {
          PK: 'peaking', LP: 'lowpass', HP: 'highpass', LSC: 'lowshelf', HSC: 'highshelf',
        }
        const parsed: { freq: number; gain: number; type: 'peaking' | 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf' }[] = []
        for (const line of text.split('\n')) {
          const m = line.match(/^Filter\s+\d+:\s+ON\s+(\w+)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([-\d.]+)\s+dB/)
          if (m) {
            parsed.push({
              freq: Math.round(parseFloat(m[2]!)),
              gain: Math.round(parseFloat(m[3]!)),
              type: typeMap[m[1]!] || 'peaking',
            })
          }
        }
        if (parsed.length > 0) {
          // Map imported bands onto existing slots, or use imported count
          const bands = parsed.slice(0, 10).map((p) => ({
            freq: Math.max(20, Math.min(20000, p.freq)),
            gain: Math.max(-60, Math.min(24, p.gain)),
            type: p.type,
          }))
          // If fewer than 10, fill remaining with defaults
          while (bands.length < 10) {
            const def = settingsDefaults.eqBands[bands.length]
            bands.push(def ? { ...def } : { freq: 1000, gain: 0, type: 'peaking' })
          }
          update({ eqBands: bands })
        }
      }
      reader.readAsText(file)
    }
    input.click()
  }

  // EQ Reset to defaults
  const handleEqReset = () => {
    update({ eqBands: settingsDefaults.eqBands.map(b => ({ ...b })) })
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
                <>
                  <video
                    className={`settings-camera-preview${settings.cameraMirror ? ' mirrored' : ''}`}
                    autoPlay
                    playsInline
                    muted
                    ref={(el) => { if (el && el.srcObject !== cameraStream) el.srcObject = cameraStream }}
                    key={cameraStream.id}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <label className="settings-toggle" style={{ flex: 1 }}>
                      <span>Mirror</span>
                      <input type="checkbox" checked={settings.cameraMirror} onChange={(e) => update({ cameraMirror: e.target.checked })} />
                    </label>
                  </div>
                </>
              )}

              {cameraStream && cameraCapabilities && (() => {
                const caps = cameraCapabilities
                const cam = settings.cameraSettings || {}
                type RangeCap = { min: number; max: number; step: number }
                const hasRange = (k: string): RangeCap | null => {
                  const v = caps[k] as RangeCap | undefined
                  return v && typeof v.min === 'number' && typeof v.max === 'number' ? v : null
                }
                const hasModes = (k: string): string[] | null => {
                  const v = caps[k] as string[] | undefined
                  return Array.isArray(v) && v.length > 0 ? v : null
                }
                const resolutions = caps.width && caps.height
                  ? (() => {
                    const w = caps.width as RangeCap, h = caps.height as RangeCap
                    if (!w?.max || !h?.max) return null
                    const presets = [
                      { label: 'Default', value: 'default' },
                      ...[
                        [640, 480, '480p'], [1280, 720, '720p'], [1920, 1080, '1080p'],
                        [2560, 1440, '1440p'], [3840, 2160, '4K'],
                      ].filter(([rw, rh]) => (rw as number) <= w.max && (rh as number) <= h.max)
                        .map(([rw, rh, label]) => ({ label: label as string, value: `${rw}x${rh}` })),
                    ]
                    return presets.length > 1 ? presets : null
                  })()
                  : null

                const wbModes = hasModes('whiteBalanceMode')
                const expModes = hasModes('exposureMode')
                const focusModes = hasModes('focusMode')
                const expComp = hasRange('exposureCompensation')
                const expTime = hasRange('exposureTime')
                const isoRange = hasRange('iso')
                const bright = hasRange('brightness')
                const contrastRange = hasRange('contrast')
                const satRange = hasRange('saturation')
                const tempRange = hasRange('colorTemperature')
                const sharpRange = hasRange('sharpness')

                const anyAdvanced = resolutions || wbModes || expModes || focusModes || expComp || expTime || isoRange || bright || contrastRange || satRange || tempRange || sharpRange

                if (!anyAdvanced) return <p className="settings-hint" style={{ marginTop: 8 }}>No advanced camera controls available for this device.</p>

                return (
                  <div className="camera-settings-grid">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <h3 className="settings-section" style={{ margin: 0 }}>Camera Settings</h3>
                      <button className="settings-preview-btn" style={{ margin: 0, padding: '4px 12px', fontSize: 12 }} onClick={resetCameraToAuto}>Auto</button>
                    </div>
                    <p className="settings-hint">Adjust camera hardware settings. Availability depends on your camera and browser.</p>

                    {resolutions && (
                      <label className="settings-slider">
                        <span>Resolution</span>
                        <select value={cam.resolution || 'default'} onChange={(e) => applyCameraSetting('resolution', e.target.value)}>
                          {resolutions.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </label>
                    )}

                    {wbModes && (
                      <label className="settings-slider">
                        <span>White Balance</span>
                        <select value={cam.whiteBalanceMode || 'continuous'} onChange={(e) => applyCameraSetting('whiteBalanceMode', e.target.value)}>
                          {wbModes.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
                        </select>
                      </label>
                    )}

                    {expModes && (
                      <label className="settings-slider">
                        <span>Exposure Mode</span>
                        <select value={cam.exposureMode || 'continuous'} onChange={(e) => applyCameraSetting('exposureMode', e.target.value)}>
                          {expModes.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
                        </select>
                      </label>
                    )}

                    {focusModes && (
                      <label className="settings-slider">
                        <span>Focus Mode</span>
                        <select value={cam.focusMode || 'continuous'} onChange={(e) => applyCameraSetting('focusMode', e.target.value)}>
                          {focusModes.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
                        </select>
                      </label>
                    )}

                    {expComp && (
                      <label className="settings-slider">
                        <span>Exposure Compensation</span>
                        <input type="range" min={expComp.min} max={expComp.max} step={expComp.step}
                          value={cam.exposureCompensation ?? 0} onChange={(e) => applyCameraSetting('exposureCompensation', Number(e.target.value))} />
                        <span className="slider-value">{cam.exposureCompensation ?? 0}</span>
                      </label>
                    )}

                    {expTime && (
                      <label className="settings-slider">
                        <span>Shutter Speed</span>
                        <input type="range" min={expTime.min} max={Math.min(expTime.max, 100000)} step={expTime.step}
                          value={cam.exposureTime ?? expTime.min} onChange={(e) => applyCameraSetting('exposureTime', Number(e.target.value))} />
                        <span className="slider-value">{cam.exposureTime != null ? (cam.exposureTime >= 1000 ? `${(cam.exposureTime / 1000).toFixed(1)}ms` : `${cam.exposureTime}µs`) : 'auto'}</span>
                      </label>
                    )}

                    {isoRange && (
                      <label className="settings-slider">
                        <span>ISO</span>
                        <input type="range" min={isoRange.min} max={isoRange.max} step={isoRange.step}
                          value={cam.iso ?? isoRange.min} onChange={(e) => applyCameraSetting('iso', Number(e.target.value))} />
                        <span className="slider-value">{cam.iso ?? 'auto'}</span>
                      </label>
                    )}

                    {bright && (
                      <label className="settings-slider">
                        <span>Brightness</span>
                        <input type="range" min={bright.min} max={bright.max} step={bright.step}
                          value={cam.brightness ?? Math.round((bright.min + bright.max) / 2)} onChange={(e) => applyCameraSetting('brightness', Number(e.target.value))} />
                        <span className="slider-value">{cam.brightness ?? Math.round((bright.min + bright.max) / 2)}</span>
                      </label>
                    )}

                    {contrastRange && (
                      <label className="settings-slider">
                        <span>Contrast</span>
                        <input type="range" min={contrastRange.min} max={contrastRange.max} step={contrastRange.step}
                          value={cam.contrast ?? Math.round((contrastRange.min + contrastRange.max) / 2)} onChange={(e) => applyCameraSetting('contrast', Number(e.target.value))} />
                        <span className="slider-value">{cam.contrast ?? Math.round((contrastRange.min + contrastRange.max) / 2)}</span>
                      </label>
                    )}

                    {satRange && (
                      <label className="settings-slider">
                        <span>Saturation</span>
                        <input type="range" min={satRange.min} max={satRange.max} step={satRange.step}
                          value={cam.saturation ?? Math.round((satRange.min + satRange.max) / 2)} onChange={(e) => applyCameraSetting('saturation', Number(e.target.value))} />
                        <span className="slider-value">{cam.saturation ?? Math.round((satRange.min + satRange.max) / 2)}</span>
                      </label>
                    )}

                    {tempRange && (
                      <label className="settings-slider">
                        <span>Color Temperature</span>
                        <input type="range" min={tempRange.min} max={tempRange.max} step={tempRange.step}
                          value={cam.colorTemperature ?? Math.round((tempRange.min + tempRange.max) / 2)} onChange={(e) => applyCameraSetting('colorTemperature', Number(e.target.value))} />
                        <span className="slider-value">{cam.colorTemperature ?? Math.round((tempRange.min + tempRange.max) / 2)}K</span>
                      </label>
                    )}

                    {sharpRange && (
                      <label className="settings-slider">
                        <span>Sharpness</span>
                        <input type="range" min={sharpRange.min} max={sharpRange.max} step={sharpRange.step}
                          value={cam.sharpness ?? Math.round((sharpRange.min + sharpRange.max) / 2)} onChange={(e) => applyCameraSetting('sharpness', Number(e.target.value))} />
                        <span className="slider-value">{cam.sharpness ?? Math.round((sharpRange.min + sharpRange.max) / 2)}</span>
                      </label>
                    )}
                  </div>
                )
              })()}

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
            {(window as any).electronAPI?.isElectron && (
              <>
                <h3 className="settings-section">Window</h3>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={!!nativeTitlebar}
                    onChange={async (e) => {
                      const val = e.target.checked
                      setNativeTitlebar(val)
                      await (window as any).electronAPI.setNativeTitlebar(val)
                      alert('Restart the app for the titlebar change to take effect.')
                    }}
                  />
                  Use native (OS) titlebar
                </label>
              </>
            )}
            <h3 className="settings-section">Themes</h3>
            <div className="theme-grid">
              {getAllThemes().map((theme) => (
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
                    <div className="theme-preview-main" style={{ background: theme.gradient || theme.colors['--bg-primary'] }}>
                      <div className="theme-preview-msg" style={{ background: theme.colors['--bg-secondary'], borderColor: theme.colors['--border'] }} />
                      <div className="theme-preview-msg" style={{ background: theme.colors['--bg-secondary'], borderColor: theme.colors['--border'] }} />
                      <div className="theme-preview-input" style={{ background: theme.colors['--bg-input'], borderColor: theme.colors['--border'] }} />
                    </div>
                  </div>
                  <span className="theme-card-name">{theme.name}</span>
                  {activeTheme === theme.id && <span className="theme-card-check">✓</span>}
                  {customThemes.some((c) => c.id === theme.id) && (
                    <span className="theme-card-actions">
                      <button className="theme-action-btn" title="Edit" onClick={(e) => { e.stopPropagation(); setEditingTheme({ ...theme, colors: { ...theme.colors } }) }}>✎</button>
                      <button className="theme-action-btn theme-action-delete" title="Delete" onClick={(e) => {
                        e.stopPropagation()
                        const next = customThemes.filter((c) => c.id !== theme.id)
                        setCustomThemes(next)
                        saveCustomThemes(next)
                        if (activeTheme === theme.id) {
                          setActiveTheme('default')
                          saveThemeId('default')
                          applyTheme(THEME_PRESETS[0]!)
                        }
                      }}>✕</button>
                    </span>
                  )}
                </button>
              ))}
            </div>

            <h3 className="settings-section" style={{ marginTop: 24 }}>
              {editingTheme ? (editingTheme.id.startsWith('custom-') && !customThemes.some((c) => c.id === editingTheme.id) ? 'Create Theme' : 'Edit Theme') : 'Create Theme'}
            </h3>
            {!editingTheme ? (
              <button className="theme-create-btn" onClick={() => {
                const base = getAllThemes().find((t) => t.id === activeTheme) || THEME_PRESETS[0]!
                setEditingTheme({
                  id: `custom-${Date.now()}`,
                  name: 'My Theme',
                  gradient: base.gradient,
                  colors: { ...base.colors },
                })
              }}>+ New Theme from Current</button>
            ) : (
              <div className="theme-editor">
                <div className="theme-editor-row">
                  <label>Name</label>
                  <input
                    type="text"
                    value={editingTheme.name}
                    onChange={(e) => setEditingTheme({ ...editingTheme, name: e.target.value })}
                    className="theme-editor-input"
                    maxLength={30}
                  />
                </div>
                <div className="theme-editor-row">
                  <label>Gradient Background</label>
                  <input
                    type="text"
                    value={editingTheme.gradient || ''}
                    onChange={(e) => setEditingTheme({ ...editingTheme, gradient: e.target.value || undefined })}
                    className="theme-editor-input"
                    placeholder="e.g. linear-gradient(135deg, #0a0a1a, #1a1a2e)"
                  />
                  {editingTheme.gradient && (
                    <div className="theme-editor-gradient-preview" style={{ background: editingTheme.gradient }} />
                  )}
                </div>
                <div className="theme-editor-colors">
                  {(Object.keys(editingTheme.colors) as (keyof ThemeColors)[]).map((key) => (
                    <div className="theme-color-field" key={key}>
                      <input
                        type="color"
                        value={editingTheme.colors[key]}
                        onChange={(e) => {
                          const updated = { ...editingTheme, colors: { ...editingTheme.colors, [key]: e.target.value } }
                          setEditingTheme(updated)
                          applyTheme(updated)
                        }}
                      />
                      <span className="theme-color-label">{key.replace('--', '').replace(/-/g, ' ')}</span>
                    </div>
                  ))}
                </div>
                <div className="theme-editor-actions">
                  <button className="theme-save-btn" onClick={() => {
                    const existing = customThemes.findIndex((c) => c.id === editingTheme.id)
                    let next: Theme[]
                    if (existing >= 0) {
                      next = [...customThemes]
                      next[existing] = editingTheme
                    } else {
                      next = [...customThemes, editingTheme]
                    }
                    setCustomThemes(next)
                    saveCustomThemes(next)
                    setActiveTheme(editingTheme.id)
                    saveThemeId(editingTheme.id)
                    applyTheme(editingTheme)
                    setEditingTheme(null)
                  }}>Save</button>
                  <button className="theme-cancel-btn" onClick={() => {
                    setEditingTheme(null)
                    const t = getAllThemes().find((t) => t.id === activeTheme) || THEME_PRESETS[0]!
                    applyTheme(t)
                  }}>Cancel</button>
                </div>
              </div>
            )}

            <h3 className="settings-section" style={{ marginTop: 24 }}>Text</h3>
            <div className="text-settings">
              <div className="text-setting-row">
                <label>Font</label>
                <select
                  value={textSettings.fontFamily}
                  onChange={(e) => {
                    const next = { ...textSettings, fontFamily: e.target.value }
                    setTextSettingsState(next)
                    saveTextSettings(next)
                    applyTextSettings(next)
                  }}
                  className="text-setting-select"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div className="text-setting-row">
                <label>Font Size ({textSettings.fontSize}px)</label>
                <input
                  type="range" min={10} max={22} step={1}
                  value={textSettings.fontSize}
                  onChange={(e) => {
                    const next = { ...textSettings, fontSize: Number(e.target.value) }
                    setTextSettingsState(next)
                    saveTextSettings(next)
                    applyTextSettings(next)
                  }}
                />
              </div>
              <div className="text-setting-row">
                <label>Line Height ({textSettings.lineHeight.toFixed(1)})</label>
                <input
                  type="range" min={1} max={2.5} step={0.1}
                  value={textSettings.lineHeight}
                  onChange={(e) => {
                    const next = { ...textSettings, lineHeight: Number(e.target.value) }
                    setTextSettingsState(next)
                    saveTextSettings(next)
                    applyTextSettings(next)
                  }}
                />
              </div>
              <div className="text-setting-row">
                <label>Letter Spacing ({textSettings.letterSpacing}px)</label>
                <input
                  type="range" min={-1} max={5} step={0.5}
                  value={textSettings.letterSpacing}
                  onChange={(e) => {
                    const next = { ...textSettings, letterSpacing: Number(e.target.value) }
                    setTextSettingsState(next)
                    saveTextSettings(next)
                    applyTextSettings(next)
                  }}
                />
              </div>
              <button className="text-setting-reset" onClick={() => {
                setTextSettingsState({ ...DEFAULT_TEXT_SETTINGS })
                saveTextSettings({ ...DEFAULT_TEXT_SETTINGS })
                applyTextSettings({ ...DEFAULT_TEXT_SETTINGS })
              }}>Reset to Default</button>
            </div>

            <h3 className="settings-section" style={{ marginTop: 24 }}>Preview</h3>
            <div className="theme-live-preview" style={{
              fontFamily: textSettings.fontFamily + ", 'Noto Color Emoji'",
              fontSize: textSettings.fontSize,
              lineHeight: textSettings.lineHeight,
              letterSpacing: textSettings.letterSpacing,
            }}>
              <div className="preview-sidebar" style={{ background: 'var(--bg-secondary)' }}>
                <div className="preview-server-icon" style={{ background: 'var(--accent)' }}>R</div>
                <div className="preview-channel" style={{ color: 'var(--text-muted)' }}># general</div>
                <div className="preview-channel active" style={{ color: 'var(--text-primary)', background: 'var(--bg-tertiary)' }}># random</div>
                <div className="preview-channel" style={{ color: 'var(--text-muted)' }}># off-topic</div>
              </div>
              <div className="preview-chat" style={{ background: 'var(--bg-primary)' }}>
                <div className="preview-header" style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}># random</div>
                <div className="preview-messages">
                  <div className="preview-msg">
                    <span className="preview-msg-author" style={{ color: 'var(--accent)' }}>Alice</span>
                    <span className="preview-msg-text" style={{ color: 'var(--text-primary)' }}>Hey everyone! 👋</span>
                    <span className="preview-msg-time" style={{ color: 'var(--text-muted)' }}>2:30 PM</span>
                  </div>
                  <div className="preview-msg">
                    <span className="preview-msg-author" style={{ color: 'var(--success)' }}>Bob</span>
                    <span className="preview-msg-text" style={{ color: 'var(--text-primary)' }}>What's up? Working on anything cool?</span>
                    <span className="preview-msg-time" style={{ color: 'var(--text-muted)' }}>2:31 PM</span>
                  </div>
                  <div className="preview-msg">
                    <span className="preview-msg-author" style={{ color: 'var(--accent-hover)' }}>Charlie</span>
                    <span className="preview-msg-text" style={{ color: 'var(--text-secondary)' }}>Just shipped a new feature 🚀</span>
                    <span className="preview-msg-time" style={{ color: 'var(--text-muted)' }}>2:32 PM</span>
                  </div>
                </div>
                <div className="preview-input" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                  Message #random
                </div>
              </div>
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

              <h3 className="settings-section">Audio Bitrate</h3>
              <label className="settings-slider">
                <span>Voice Bitrate</span>
                <select
                  value={settings.audioBitrate}
                  onChange={(e) => update({ audioBitrate: Number(e.target.value) })}
                >
                  <option value={0}>Auto</option>
                  <option value={32}>32 kbps (Low)</option>
                  <option value={64}>64 kbps</option>
                  <option value={96}>96 kbps</option>
                  <option value={128}>128 kbps</option>
                  <option value={256}>256 kbps (High)</option>
                  <option value={510}>510 kbps (Max / Opus)</option>
                </select>
              </label>

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
                  <p className="settings-hint">Drag handles on the spectrum. Right-click a handle to change filter type. -∞ to +24 dB per band.</p>
                  <div className="eq-sliders-grid">
                    {(settings.eqBands || []).map((band, i) => {
                      const typeLabels: Record<string, string> = { peaking: 'PK', lowpass: 'LP', highpass: 'HP', lowshelf: 'LS', highshelf: 'HS' }
                      return (
                        <label className="eq-band-slider" key={i}>
                          <span className="eq-band-freq">{band.freq >= 1000 ? `${(band.freq / 1000).toFixed(band.freq % 1000 === 0 ? 0 : 1)}k` : `${band.freq}`}</span>
                          <span className="eq-band-type">{typeLabels[band.type] || 'PK'}</span>
                          <input
                            type="range"
                            min={-60}
                            max={24}
                            step={1}
                            value={band.gain}
                            className="eq-band-range"
                            onChange={(e) => {
                              const bands = [...(settings.eqBands || [])]
                              bands[i] = { ...bands[i]!, gain: Number(e.target.value) }
                              update({ eqBands: bands })
                            }}
                          />
                          <span className="eq-band-db">{band.gain <= -60 ? '-∞' : `${band.gain > 0 ? '+' : ''}${band.gain}`}</span>
                        </label>
                      )
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
                    <span style={{ borderLeft: '1px solid var(--border)', height: 20, margin: '0 4px' }} />
                    <button className="settings-preview-btn" onClick={handleEqReset} title="Reset frequencies, gains, and types to defaults">
                      ↺ Reset
                    </button>
                    <button className="settings-preview-btn" onClick={handleEqExport} title="Export as EqualizerAPO format (.txt)">
                      ↓ Export
                    </button>
                    <button className="settings-preview-btn" onClick={handleEqImport} title="Import EqualizerAPO format (.txt)">
                      ↑ Import
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
                  onMouseDown={(e) => { setEqContextMenu(null); handleSpectrumMouseDown(e) }}
                  onMouseMove={handleSpectrumMouseMove}
                  onMouseUp={handleSpectrumMouseUp}
                  onMouseLeave={handleSpectrumMouseUp}
                  onContextMenu={handleSpectrumContextMenu}
                  onTouchStart={handleSpectrumTouchStart}
                  onTouchEnd={() => clearTimeout(eqLongPressRef.current)}
                  onTouchMove={() => clearTimeout(eqLongPressRef.current)}
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
                    <>
                      <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setEqContextMenu(null)} />
                      <div
                        className="eq-context-menu"
                        style={{ position: 'absolute', left: menuX, top: menuY, zIndex: 100 }}
                        onMouseLeave={() => setEqContextMenu(null)}
                        onClick={(e) => e.stopPropagation()}
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
                    </>
                  )
                })()}
              </div>
              <p className="settings-hint" style={{ marginTop: 4 }}>
                Drag EQ handles to shape your sound. Right-click (or long-press) a handle to change filter type. Drag the gate line to adjust threshold.
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
