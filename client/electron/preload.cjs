const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  isMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  onMaximizedChange: (cb) => {
    const handler = (_e, val) => cb(val)
    ipcRenderer.on('win-maximized', handler)
    return () => ipcRenderer.removeListener('win-maximized', handler)
  },
  getNativeTitlebar: () => ipcRenderer.invoke('get-native-titlebar'),
  setNativeTitlebar: (val) => ipcRenderer.invoke('set-native-titlebar', val),
  // Screen picker for Linux
  onDesktopSources: (cb) => {
    const handler = (_e, sources) => cb(sources)
    ipcRenderer.on('desktop-sources', handler)
    return () => ipcRenderer.removeListener('desktop-sources', handler)
  },
  selectDesktopSource: (id) => ipcRenderer.send('desktop-source-selected', id),
  cancelDesktopSource: () => ipcRenderer.send('desktop-source-cancel'),
})
