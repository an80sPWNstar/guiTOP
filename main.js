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
    minWidth: 320,
    minHeight: 200,
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
    } else if (req.url.startsWith('/host/') && win && !win.isDestroyed()) {
      const idx = parseInt(req.url.split('/')[2], 10)
      if (!Number.isInteger(idx) || idx < 0 || idx > 99) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'bad index' }))
      } else {
        try {
          await win.webContents.executeJavaScript(
            `(() => { const s = document.getElementById('host-select'); s.selectedIndex = ${idx}; s.dispatchEvent(new Event('change')); return s.value })()`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, index: idx }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      }
    } else if (req.url === '/procs/toggle' && win && !win.isDestroyed()) {
      try {
        await win.webContents.executeJavaScript(
          `document.getElementById('single-proc-toggle').click()`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
    } else if ((req.url === '/skin/gauges' || req.url === '/skin/bars' || req.url === '/skin/corvette') && win && !win.isDestroyed()) {
      const skin = req.url.split('/')[2]
      try {
        await win.webContents.executeJavaScript(
          `(() => { const s = document.getElementById('skin-select'); s.value = '${skin}'; s.dispatchEvent(new Event('change')); })()`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, skin }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
    } else if (req.url === '/debug/gauges' && win && !win.isDestroyed()) {
      try {
        const info = await win.webContents.executeJavaScript(
          `(() => Array.from(document.querySelectorAll('.gauge-util')).map(c => ({
            visible: !!c.offsetParent, cw: c.clientWidth, ch: c.clientHeight,
            bw: c.width, bh: c.height, dpr: window.devicePixelRatio
          })))()`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, info }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
    } else if (req.url === '/debug/corvette' && win && !win.isDestroyed()) {
      try {
        const info = await win.webContents.executeJavaScript(
          `(() => {
            const cards = document.querySelectorAll('.corvette-card');
            const result = [];
            cards.forEach((card, i) => {
              const wedge = card.querySelector('.cv-wedge');
              const scale = card.querySelector('.cv-scale');
              const body = card.querySelector('.cv-body');
              const left = card.querySelector('.cv-left');
              const grid = card.closest('.gpu-grid');
              const panel = card.closest('.tab-panel');
              const wedgeBars = card.querySelectorAll('[data-role="wedge-bar"]');
              const tempSegs = card.querySelectorAll('[data-role="temp-seg"]');
              const fuelSegs = card.querySelectorAll('[data-role="fuel-seg"]');
              const litWedge = Array.from(wedgeBars).filter(b => !b.style.background.includes('rgba(255,255,255,0.07)') && !b.style.background.includes('rgba(74,')).length;
              const litTemp = Array.from(tempSegs).filter(b => !b.style.background.includes('rgba(255,255,255,0.07)')).length;
              const litFuel = Array.from(fuelSegs).filter(b => !b.style.background.includes('rgba(255,255,255,0.07)')).length;
              result.push({
                idx: i,
                cardW: card.offsetWidth, cardH: card.offsetHeight,
                gridW: grid ? grid.offsetWidth : 0, gridH: grid ? grid.offsetHeight : 0,
                panelW: panel ? panel.offsetWidth : 0, panelH: panel ? panel.offsetHeight : 0,
                wedgeW: wedge ? wedge.offsetWidth : 0, wedgeH: wedge ? wedge.offsetHeight : 0,
                scaleH: scale ? scale.offsetHeight : 0,
                bodyH: body ? body.offsetHeight : 0,
                leftW: left ? left.offsetWidth : 0,
                wedgeBars: wedgeBars.length, litWedge,
                tempSegs: tempSegs.length, litTemp,
                fuelSegs: fuelSegs.length, litFuel,
                wedgeFlex: wedge ? getComputedStyle(wedge).flex : '',
                wedgeMinH: wedge ? getComputedStyle(wedge).minHeight : '',
                wedgeCSH: wedge ? getComputedStyle(wedge).height : '',
              });
            });
            return result;
          })()`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, info }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
    } else if (req.url.startsWith('/resize') && win && !win.isDestroyed()) {
      const params = new URL(req.url, 'http://localhost').searchParams
      const w = parseInt(params.get('w')) || 500
      const h = parseInt(params.get('h')) || 400
      win.setSize(w, h)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, width: w, height: h }))
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
