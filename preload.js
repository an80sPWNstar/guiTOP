const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('guiTOP', {
  onData: (cb) => ipcRenderer.on('gpu-data', (_e, data) => cb(data)),
  onClaudeUsage: (cb) => ipcRenderer.on('claude-usage', (_e, data) => cb(data)),
  onClaudeSwap: (cb) => ipcRenderer.on('claude-swap', (_e, data) => cb(data)),
  onHostList: (cb) => ipcRenderer.on('host-list', (_e, hosts) => cb(hosts)),
  getHosts: () => ipcRenderer.invoke('get-hosts'),
  addHost: (config) => ipcRenderer.invoke('add-host', config),
  removeHost: (label) => ipcRenderer.invoke('remove-host', label),
  editHost: (label, config) => ipcRenderer.invoke('edit-host', label, config),
})
