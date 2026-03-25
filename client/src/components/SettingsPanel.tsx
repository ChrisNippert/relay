import { useEffect, useState } from 'react'
import { getSettings, saveSettings, getDevices, type MediaSettings } from '../services/settings'

interface Props {
  onClose: () => void
}

export default function SettingsPanel({ onClose }: Props) {
  const [settings, setSettings] = useState<MediaSettings>(getSettings)
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getDevices().then((d) => {
      setAudioInputs(d.audioInputs)
      setAudioOutputs(d.audioOutputs)
      setVideoInputs(d.videoInputs)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const update = (partial: Partial<MediaSettings>) => {
    const next = { ...settings, ...partial }
    setSettings(next)
    saveSettings(next)
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        {loading ? (
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
          </div>
        )}
      </div>
    </div>
  )
}
