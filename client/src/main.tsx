import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import 'highlight.js/styles/atom-one-dark.css'
import { loadAndApplyTheme, loadAndApplyTextSettings } from './services/settings'

loadAndApplyTheme()
loadAndApplyTextSettings()

const isElectron = typeof window !== 'undefined' && (window as any).electronAPI?.isElectron
const Router = isElectron ? HashRouter : BrowserRouter

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <App />
    </Router>
  </StrictMode>,
)
