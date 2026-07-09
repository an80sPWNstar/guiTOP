const { app, BrowserWindow, ipcMain, safeStorage } = require('electron')
const os = require('os')
const http = require('http')
const fs = require('fs')
const path = require('path')
const {
  loadHosts, validate, DEFAULT_HOSTS,
  loadSavedHosts, saveHostList,
  loadKnownHosts, saveKnownHost,
} = require('./src/config/hosts')
const { startHost } = require('./src/collectors/service')
const { testConnect, execRemote } = require('./src/collectors/ssh')

const isDev = process.argv.includes('--dev')
const useMock = process.argv.includes('--mock')
const PRELOAD = path.join(__dirname, 'preload.js')

let win = null
const activeHosts = []     // validated host entries
const rawHosts = []        // raw configs (for persistence — no passwords)
const hostHandles = {}     // { label: stopHandle }
const hostPasswords = {}   // { label: password } — in memory only, never persisted

function broadcastHostList() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('host-list', activeHosts.map(h => h.label))
  }
}

function startCollector(hostEntry) {
  const enriched = { ...hostEntry }
  // Attach in-memory password + known host key for SSH
  if (!enriched.local) {
    if (hostPasswords[enriched.label]) enriched.password = hostPasswords[enriched.label]
    const known = loadKnownHosts(app.getPath('userData'))
    const hk = `${enriched.host}:${enriched.port || 22}`
    if (known[hk]) enriched.knownHostKey = known[hk]
  }
  hostHandles[hostEntry.label] = startHost(enriched, (payload) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('gpu-data', payload)
    }
  }, { useMock })
}

function createWindow() {
  win = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 640,
    minHeight: 400,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile('renderer/index.html')
  if (isDev) win.webContents.openDevTools({ mode: 'detach' })

  win.webContents.once('did-finish-load', () => {
    const saved = loadSavedHosts(app.getPath('userData'))
    const initial = (saved && saved.length > 0) ? saved : DEFAULT_HOSTS

    // Always refresh local host label to current hostname
    const currentHostname = os.hostname()
    for (const entry of initial) {
      if (entry.local) entry.label = currentHostname
    }

    const hosts = loadHosts(initial)

    rawHosts.push(...initial)
    activeHosts.push(...hosts)

    // Restore encrypted passwords from saved host entries
    if (safeStorage.isEncryptionAvailable()) {
      for (const raw of rawHosts) {
        if (raw.encryptedPassword) {
          try {
            hostPasswords[raw.label] = safeStorage.decryptString(
              Buffer.from(raw.encryptedPassword, 'base64')
            )
          } catch (_) { /* decryption failed — user will be prompted */ }
        }
      }
    }

    for (const h of hosts) startCollector(h)
    broadcastHostList()
  })
}

ipcMain.handle('get-hosts', () => activeHosts.map(h => h.label))

ipcMain.handle('add-host', async (_e, config) => {
  const { password, acceptFingerprint, _fingerprint, ...hostData } = config
  const idx = activeHosts.length

  let entry
  try {
    entry = validate(hostData, idx)
  } catch (err) {
    return { ok: false, error: err.message }
  }

  // For remote hosts, test the connection first
  if (!entry.local) {
    const hk = `${entry.host}:${entry.port || 22}`
    const known = loadKnownHosts(app.getPath('userData'))
    const knownHostKey = known[hk] || null

    const testConfig = {
      ...entry,
      password,
      knownHostKey: acceptFingerprint ? _fingerprint : knownHostKey,
    }

    try {
      const result = await testConnect(testConfig)
      if (result.fingerprint && !known[hk]) {
        saveKnownHost(app.getPath('userData'), hk, result.fingerprint)
      }
    } catch (err) {
      if (err && err.needsAccept) {
        return { ok: false, needsAccept: true, fingerprint: err.fingerprint }
      }
      return { ok: false, error: err.message || String(err) }
    }

    if (acceptFingerprint && _fingerprint) {
      saveKnownHost(app.getPath('userData'), hk, _fingerprint)
    }

    // Resolve actual hostname if label matches the IP (auto-discover)
    if (entry.label === entry.host) {
      try {
        const resolveConfig = { ...entry, password }
        const knownAll = loadKnownHosts(app.getPath('userData'))
        if (knownAll[hk]) resolveConfig.knownHostKey = knownAll[hk]
        const name = await execRemote(resolveConfig, 'hostname')
        if (name && name.trim()) {
          entry.label = name.trim()
          hostData.label = entry.label
        }
      } catch (_) { /* keep IP as label */ }
    }
  }

  if (activeHosts.some(h => h.label === entry.label)) {
    return { ok: false, error: `Host "${entry.label}" already exists` }
  }

  if (password) {
    hostPasswords[entry.label] = password
    if (safeStorage.isEncryptionAvailable()) {
      hostData.encryptedPassword = safeStorage.encryptString(password).toString('base64')
    }
  }

  rawHosts.push(hostData)
  activeHosts.push(entry)
  startCollector(entry)
  saveHostList(app.getPath('userData'), rawHosts)
  broadcastHostList()
  return { ok: true, label: entry.label }
})

ipcMain.handle('edit-host', async (_e, label, config) => {
  const idx = activeHosts.findIndex(h => h.label === label)
  if (idx === -1) return { ok: false, error: `Host "${label}" not found` }

  const entry = activeHosts[idx]
  const { password } = config

  // Update password in memory and persist encrypted copy
  if (password) {
    hostPasswords[entry.label] = password
    if (safeStorage.isEncryptionAvailable()) {
      const rawIdx = rawHosts.findIndex(r => r.label === label)
      if (rawIdx !== -1) {
        rawHosts[rawIdx].encryptedPassword = safeStorage.encryptString(password).toString('base64')
        saveHostList(app.getPath('userData'), rawHosts)
      }
    }
  }

  // Restart collector with new credentials
  if (hostHandles[label]) {
    hostHandles[label].stop()
    delete hostHandles[label]
  }
  startCollector(entry)
  return { ok: true }
})

ipcMain.handle('remove-host', (_e, label) => {
  const idx = activeHosts.findIndex(h => h.label === label)
  if (idx === -1) return { ok: false, error: `Host "${label}" not found` }

  if (hostHandles[label]) {
    hostHandles[label].stop()
    delete hostHandles[label]
  }
  delete hostPasswords[label]

  activeHosts.splice(idx, 1)
  rawHosts.splice(idx, 1)
  saveHostList(app.getPath('userData'), rawHosts)
  broadcastHostList()
  return { ok: true }
})

app.whenReady().then(() => {
  createWindow()

  // Dev screenshot server — GET http://localhost:17580/screenshot → saves PNG, returns path
  const SCREENSHOT_PORT = 17580
  const SCREENSHOT_PATH = path.join(app.getPath('temp'), 'guitop-screenshot.png')
  http.createServer(async (req, res) => {
    if ((req.url === '/tab/single' || req.url === '/tab/multi') && win && !win.isDestroyed()) {
      const tab = req.url === '/tab/multi' ? 'multi' : 'single'
      try {
        await win.webContents.executeJavaScript(
          `document.querySelector('.tab-btn[data-tab="${tab}"]').click()`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, tab }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
    } else if (req.url === '/screenshot' && win && !win.isDestroyed()) {
      try {
        const img = await win.webContents.capturePage()
        fs.writeFileSync(SCREENSHOT_PATH, img.toPNG())
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: SCREENSHOT_PATH }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
    } else {
      res.writeHead(404); res.end('not found')
    }
  }).listen(SCREENSHOT_PORT)
})

app.on('window-all-closed', () => app.quit())

app.on('before-quit', () => {
  for (const h of Object.values(hostHandles)) h.stop()
})
