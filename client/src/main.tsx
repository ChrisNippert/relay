import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import 'highlight.js/styles/atom-one-dark.css'
import { loadAndApplyTheme, loadAndApplyTextSettings } from './services/settings'

loadAndApplyTheme()
loadAndApplyTextSettings()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
