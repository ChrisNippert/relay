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
  const [tab, setTab] = useState<'profile' | 'media' | 'theme' | 'devices' | 'notifications'>('profile')
  const [activeTheme, setActiveTheme] = useState(getThemeId)
  const [micTestStream, setMicTestStream] = useState<MediaStream | null>(null)
  const [micLevel, setMicLevel] = useState(0)
  const micTestCtxRef = useRef<AudioContext | null>(null)
  const micTestAnimRef = useRef<number>(0)

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

  // Only load devices when media tab is opened
  useEffect(() => {
    if (tab !== 'media' || devicesLoaded) return
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
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)

      // Loopback: play mic audio back through speakers so user can hear themselves
      const loopbackGain = ctx.createGain()
      loopbackGain.gain.value = 1
      source.connect(loopbackGain)
      loopbackGain.connect(ctx.destination)

      // Level meter animation loop
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const check = () => {
        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]!
        const avg = sum / dataArray.length
        // Normalize to 0-100 range (frequency data averages around 0-60 for speech)
        const normalized = Math.min((avg / 60) * 100, 100)
        setMicLevel(normalized)

        // Apply noise gate to loopback
        const liveSettings = getSettings()
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

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>
            Profile
          </button>
          <button className={`settings-tab ${tab === 'media' ? 'active' : ''}`} onClick={() => setTab('media')}>
            Audio &amp; Video
          </button>
          <button className={`settings-tab ${tab === 'theme' ? 'active' : ''}`} onClick={() => setTab('theme')}>
            Theme
          </button>
          <button className={`settings-tab ${tab === 'devices' ? 'active' : ''}`} onClick={() => setTab('devices')}>
            Devices{pendingDevices.length > 0 && <span className="pending-badge">{pendingDevices.length}</span>}
          </button>
          <button className={`settings-tab ${tab === 'notifications' ? 'active' : ''}`} onClick={() => setTab('notifications')}>
            Notifications
          </button>
        </div>

        {tab === 'profile' && (
          <div className="settings-body">
            <div className="profile-preview-card">
              <div className="profile-preview-avatar">
                {user?.avatar_url ? (
                  <img src={user.avatar_url} alt="" className="profile-preview-avatar-img" />
                ) : (
                  <span className="profile-preview-avatar-fallback">
                    {(displayName || user?.display_name)?.[0]?.toUpperCase() ?? '?'}
                  </span>
                )}
                <span className="profile-preview-status-dot online" />
              </div>
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

        {tab === 'media' && (
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

              <h3 className="settings-section">Voice Processing</h3>
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
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.autoGainControl}
                  onChange={(e) => update({ autoGainControl: e.target.checked })}
                />
                <span>Auto Gain Control</span>
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

              <h3 className="settings-section">Noise Gate</h3>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.noiseGateEnabled}
                  onChange={(e) => update({ noiseGateEnabled: e.target.checked })}
                />
                <span>Enable Noise Gate</span>
              </label>
              {settings.noiseGateEnabled && (
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
              )}

              <div className="mic-level-meter">
                <div className="mic-level-bar" style={{ width: `${Math.min(micLevel, 100)}%` }} />
                {settings.noiseGateEnabled && (
                  <div className="mic-level-threshold" style={{ left: `${settings.noiseGateThreshold}%` }} />
                )}
              </div>
              <button className="settings-preview-btn" onClick={toggleMicTest}>
                {micTestStream ? '⏹ Stop Mic Test' : '🎤 Test Microphone'}
              </button>

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

        <div className="settings-logout-section">
          <button className="danger-btn settings-logout-btn" onClick={logout}>Log Out</button>
        </div>
      </div>
    </div>
  )
}
