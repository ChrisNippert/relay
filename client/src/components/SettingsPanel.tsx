import { useEffect, useState } from 'react'
import { getSettings, saveSettings, getDevices, type MediaSettings, THEME_PRESETS, getThemeId, saveThemeId, applyTheme } from '../services/settings'
import { useAuth } from '../context/AuthContext'
import * as api from '../services/api'

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
  const [tab, setTab] = useState<'profile' | 'media' | 'theme'>('profile')
  const [activeTheme, setActiveTheme] = useState(getThemeId)

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

        <div className="settings-logout-section">
          <button className="danger-btn settings-logout-btn" onClick={logout}>Log Out</button>
        </div>
      </div>
    </div>
  )
}
