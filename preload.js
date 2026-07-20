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
  cswapRefresh: () => ipcRenderer.invoke('cswap-refresh'),
  cswapSetAlias: (number, alias) => ipcRenderer.invoke('cswap-set-alias', number, alias),
  cswapSetEnabled: (number, enabled) => ipcRenderer.invoke('cswap-set-enabled', number, enabled),
  cswapRemoveAccount: (number) => ipcRenderer.invoke('cswap-remove-account', number),
  cswapAddCurrent: (opts) => ipcRenderer.invoke('cswap-add-current', opts),
  cswapAddToken: (opts) => ipcRenderer.invoke('cswap-add-token', opts),
})
