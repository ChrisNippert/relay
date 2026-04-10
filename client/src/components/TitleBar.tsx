import { useEffect, useState } from 'react'

const api = (window as any).electronAPI

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!api) return
    // Set CSS variable so fixed overlays can offset below titlebar
    document.documentElement.style.setProperty('--titlebar-height', '32px')
    api.isMaximized().then(setMaximized)
    const cleanup = api.onMaximizedChange(setMaximized)
    return () => {
      cleanup()
      document.documentElement.style.setProperty('--titlebar-height', '0px')
    }
  }, [])

  if (!api) return null

  return (
    <div className="electron-titlebar">
      <div className="titlebar-drag">
        <span className="titlebar-title">Relay</span>
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-btn titlebar-minimize" onClick={() => api.minimize()} aria-label="Minimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
        </button>
        <button className="titlebar-btn titlebar-maximize" onClick={() => api.maximize()} aria-label="Maximize">
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M2 0v2H0v8h8V8h2V0H2zm6 8H1V3h7v5zM9 7V1H3v1h5v5h1z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0" y="0" width="10" height="10" rx="0" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button className="titlebar-btn titlebar-close" onClick={() => api.close()} aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  )
}
