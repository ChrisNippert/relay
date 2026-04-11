const { app, BrowserWindow, shell, ipcMain, desktopCapturer, session } = require('electron')
const path = require('path')
const fs = require('fs')

const isDev = !app.isPackaged

// Persist titlebar preference
const settingsPath = path.join(app.getPath('userData'), 'relay-prefs.json')
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { return {} }
}
function savePrefs(prefs) {
  fs.writeFileSync(settingsPath, JSON.stringify(prefs))
}

function createWindow() {
  const prefs = loadPrefs()
  const useNativeTitlebar = prefs.nativeTitlebar ?? false

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Relay',
    autoHideMenuBar: true,
    frame: useNativeTitlebar,
    titleBarStyle: useNativeTitlebar ? 'default' : 'hidden',
    ...(process.platform === 'linux' && !useNativeTitlebar ? { titleBarStyle: 'default', frame: false } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Window control IPC
  ipcMain.on('win-minimize', () => win.minimize())
  ipcMain.on('win-maximize', () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('win-close', () => win.close())
  ipcMain.handle('win-is-maximized', () => win.isMaximized())
  ipcMain.handle('get-native-titlebar', () => useNativeTitlebar)
  ipcMain.handle('set-native-titlebar', (_e, value) => {
    const p = loadPrefs()
    p.nativeTitlebar = value
    savePrefs(p)
    // Requires restart to take effect
    return true
  })

  win.on('maximize', () => win.webContents.send('win-maximized', true))
  win.on('unmaximize', () => win.webContents.send('win-maximized', false))

  // Open external links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Electron doesn't have a native screen picker for getDisplayMedia,
  // so intercept the request and show a custom source picker via IPC.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
        })
        win.webContents.send('desktop-sources', sources.map(s => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.toDataURL(),
        })))

        const selectedId = await new Promise((resolve) => {
          const onSelect = (_e, sourceId) => {
            ipcMain.removeListener('desktop-source-cancel', onCancel)
            resolve(sourceId)
          }
          const onCancel = () => {
            ipcMain.removeListener('desktop-source-selected', onSelect)
            resolve(null)
          }
          ipcMain.once('desktop-source-selected', onSelect)
          ipcMain.once('desktop-source-cancel', onCancel)
        })

        if (selectedId) {
          const source = sources.find(s => s.id === selectedId)
          if (source) {
            callback({ video: source, audio: 'loopback' })
            return
          }
        }
        callback()
      } catch (err) {
        console.error('Failed to get desktop sources:', err)
        callback()
      }
    })

  if (isDev) {
    const devUrl = process.env.ELECTRON_DEV_URL || 'http://localhost:5173'
    win.loadURL(devUrl)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
