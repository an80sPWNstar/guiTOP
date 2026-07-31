const { app, BrowserWindow, ipcMain, safeStorage, Menu, Tray, screen } = require('electron')
const os = require('os')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')
const {
  loadHosts, validate, DEFAULT_HOSTS,
  loadSavedHosts, saveHostList,
  loadKnownHosts, saveKnownHost,
} = require('./src/config/hosts')
const { startHost } = require('./src/collectors/service')
const { startClaudeUsage } = require('./src/collectors/claude-usage')
const { startClaudeUsageOAuth } = require('./src/collectors/claude-usage-oauth')
const { startClaudeSwap } = require('./src/collectors/claude-swap')
const { testConnect, execRemote } = require('./src/collectors/ssh')
const { cswapCmd } = require('./src/collectors/cswap-cmd')
const winPsHost = process.platform === 'win32' ? require('./src/collectors/win-ps-host') : null

// cswap account-management: fixed argv arrays only, never shell-interpolated.
// Same validation rules cswap itself enforces (see `cswap alias --help`).
const CSWAP_NUM_RE = /^[0-9]+$/
const CSWAP_ALIAS_RE = /^(?!\d+$)[a-zA-Z0-9._-]+$/
const CSWAP_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function runCswapCmd(args, timeout, cb) {
  const { file, args: argv } = cswapCmd(args)
  execFile(file, argv, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, cb)
}

const isDev = process.argv.includes('--dev')
// --mock-amd renders AMD-shaped mock data (deliberate gaps: no fan%, no power cap
// on some cards) so the widgets can be checked against sparse AMD telemetry.
const mockVendor = process.argv.includes('--mock-amd') ? 'amd' : 'nvidia'
const useMock = process.argv.includes('--mock') || mockVendor === 'amd'
const PRELOAD = path.join(__dirname, 'preload.js')
// .ico carries every size Windows asks for; Electron on Linux does not read .ico
// at all, so that platform gets the 256px PNG unpacked from the same source art.
const APP_ICON = path.join(__dirname, 'assets', 'images',
  process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png')

let win = null
let tray = null
let isQuitting = false
const activeHosts = []     // validated host entries
const rawHosts = []        // raw configs (for persistence — no passwords)
const hostHandles = {}     // { label: stopHandle }
const hostPasswords = {}   // { label: password } — in memory only, never persisted
const lastPayloads = {}    // { label: latest payload } — powers /gpu/backends
let claudeUsageHandle = null
let claudeSwapHandle = null
let claudeOAuthHandle = null

let useOAuthClaude = false

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }
  catch { return { launchAtStartup: false, useOAuthClaude: false, minimizeToTray: false } }
}

// Ticking the checkbox is the ONLY thing that writes a startup entry.
//
// Electron registers whichever executable is currently running, so anything
// that calls this on the app's behalf silently repoints the entry at whatever
// copy happens to be running — a dist folder, or node_modules/electron. That
// is not hypothetical: it is how a stray entry for the dev binary appeared.
// The launch path therefore reads the OS state instead of writing it.
function setLoginItem(openAtLogin) {
  if (!app.isPackaged) return // a dev run must never claim the entry
  app.setLoginItemSettings({ openAtLogin })
}

// The registry is the truth, not settings.json: the entry can be removed from
// Task Manager or by an uninstall without this app ever hearing about it. Sync
// the stored value so the checkbox shows what is actually configured.
function syncLoginItemSetting() {
  if (!app.isPackaged) return
  const s = loadSettings()
  const actual = app.getLoginItemSettings().openAtLogin
  if (!!s.launchAtStartup !== actual) {
    s.launchAtStartup = actual
    saveSettings(s)
  }
}

function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)) } catch {}
}

const DEFAULT_BOUNDS = { width: 960, height: 680 }

// Window geometry is only honoured if it still lands on a display that exists —
// unplugging the monitor a window was last closed on must not park it off-screen.
function savedBounds() {
  const b = loadSettings().windowBounds
  if (!b || typeof b !== 'object') return DEFAULT_BOUNDS
  const { width, height, x, y } = b
  if (!Number.isInteger(width) || !Number.isInteger(height)) return DEFAULT_BOUNDS
  if (width < 320 || height < 200) return DEFAULT_BOUNDS
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { width, height }
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + height > a.y
  })
  return onScreen ? { width, height, x, y } : { width, height }
}

let saveBoundsTimer = null

function saveBoundsSoon() {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer)
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null
    if (!win || win.isDestroyed()) return
    const s = loadSettings()
    // getNormalBounds is the restored size, so a maximized window still
    // remembers something sane to un-maximize back to.
    s.windowBounds = win.getNormalBounds()
    s.windowMaximized = win.isMaximized()
    saveSettings(s)
  }, 500)
}

function broadcastHostList() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('host-list', activeHosts.map(h => h.label))
  }
}

function createTray() {
  tray = new Tray(APP_ICON)
  tray.setToolTip('guiTOP')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show',   click: () => { if (win && !win.isDestroyed()) win.show() } },
    { label: 'Hide',   click: () => { if (win && !win.isDestroyed()) win.hide() } },
    { type: 'separator' },
    { label: 'Settings', click: () => { if (win && !win.isDestroyed()) win.webContents.send('open-settings') } },
    { type: 'separator' },
    { label: 'Quit',   click: () => app.quit() },
  ]))
  tray.on('double-click', () => {
    if (!win || win.isDestroyed()) return
    win.isVisible() ? win.hide() : win.show()
  })
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
    lastPayloads[payload.host] = payload
    if (win && !win.isDestroyed()) {
      win.webContents.send('gpu-data', payload)
    }
  }, { useMock, mockVendor })
}

function createWindow() {
  const settings = loadSettings()

  win = new BrowserWindow({
    ...savedBounds(),
    minWidth: 320,
    minHeight: 200,
    icon: APP_ICON,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (settings.windowMaximized) win.maximize()

  win.on('resize', saveBoundsSoon)
  win.on('move', saveBoundsSoon)
  win.on('maximize', saveBoundsSoon)
  win.on('unmaximize', saveBoundsSoon)

  win.loadFile('renderer/index.html')
  if (isDev) win.webContents.openDevTools({ mode: 'detach' })

  buildMenu()

  win.on('close', (e) => {
    if (isQuitting) return
    const settings = loadSettings()
    if (settings.minimizeToTray && tray) {
      e.preventDefault()
      win.hide()
    }
  })

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

    // Apply saved settings before starting collectors
    const settings = loadSettings()
    useOAuthClaude = settings.useOAuthClaude || false

    if (useOAuthClaude) {
      claudeOAuthHandle = startClaudeUsageOAuth((payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('claude-usage', payload)
      })
    } else {
      claudeUsageHandle = startClaudeUsage((payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('claude-usage', payload)
      })
    }
    claudeSwapHandle = startClaudeSwap((payload) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('claude-swap', payload)
      }
    })
  })
}

ipcMain.handle('cswap-refresh', () => {
  if (claudeSwapHandle) claudeSwapHandle.refresh()
})

ipcMain.handle('cswap-set-alias', (_e, number, alias) => new Promise((resolve) => {
  if (!CSWAP_NUM_RE.test(String(number))) return resolve({ ok: false, error: 'invalid account number' })
  if (!CSWAP_ALIAS_RE.test(String(alias))) return resolve({ ok: false, error: 'invalid alias' })
  runCswapCmd(['alias', String(number), String(alias)], 15000, (err, stdout, stderr) => {
    resolve(err ? { ok: false, error: (stderr || err.message).trim() } : { ok: true })
  })
}))

ipcMain.handle('cswap-set-enabled', (_e, number, enabled) => new Promise((resolve) => {
  if (!CSWAP_NUM_RE.test(String(number))) return resolve({ ok: false, error: 'invalid account number' })
  runCswapCmd([enabled ? 'enable' : 'disable', String(number)], 15000, (err, stdout, stderr) => {
    resolve(err ? { ok: false, error: (stderr || err.message).trim() } : { ok: true })
  })
}))

ipcMain.handle('cswap-remove-account', (_e, number) => new Promise((resolve) => {
  if (!CSWAP_NUM_RE.test(String(number))) return resolve({ ok: false, error: 'invalid account number' })
  runCswapCmd(['remove', String(number)], 15000, (err, stdout, stderr) => {
    resolve(err ? { ok: false, error: (stderr || err.message).trim() } : { ok: true })
  })
}))

ipcMain.handle('cswap-add-current', (_e, { alias, slot } = {}) => new Promise((resolve) => {
  const args = ['add']
  if (alias) {
    if (!CSWAP_ALIAS_RE.test(String(alias))) return resolve({ ok: false, error: 'invalid alias' })
    args.push('--alias', String(alias))
  }
  if (slot) {
    if (!CSWAP_NUM_RE.test(String(slot))) return resolve({ ok: false, error: 'invalid slot' })
    args.push('--slot', String(slot))
  }
  runCswapCmd(args, 20000, (err, stdout, stderr) => {
    resolve(err ? { ok: false, error: (stderr || err.message).trim() } : { ok: true })
  })
}))

// Token/API key goes over stdin ('-'), never argv or logs — cswap reads it
// itself and persists it in its own store; guiTOP never sees it again.
ipcMain.handle('cswap-add-token', (_e, { token, email, alias, slot } = {}) => new Promise((resolve) => {
  if (typeof token !== 'string' || !token.trim()) return resolve({ ok: false, error: 'token required' })
  if (email && !CSWAP_EMAIL_RE.test(String(email))) return resolve({ ok: false, error: 'invalid email' })
  if (alias && !CSWAP_ALIAS_RE.test(String(alias))) return resolve({ ok: false, error: 'invalid alias' })
  if (slot && !CSWAP_NUM_RE.test(String(slot))) return resolve({ ok: false, error: 'invalid slot' })

  const cswapArgs = ['add-token', '-']
  if (email) cswapArgs.push('--email', String(email))
  if (alias) cswapArgs.push('--alias', String(alias))
  if (slot) cswapArgs.push('--slot', String(slot))

  const { file, args } = cswapCmd(cswapArgs)
  const child = spawn(file, args, { windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  child.on('error', (err) => resolve({ ok: false, error: err.message }))
  child.on('close', (code) => {
    resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` })
  })
  child.stdin.write(token.trim() + '\n')
  child.stdin.end()
}))

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

// ── Settings IPC ────────────────────────────────
ipcMain.handle('get-settings', () => loadSettings())

ipcMain.handle('set-setting', (_e, key, value) => {
  const s = loadSettings()
  s[key] = value
  saveSettings(s)
  if (key === 'launchAtStartup') {
    setLoginItem(!!value)
  }
  if (key === 'useOAuthClaude') {
    useOAuthClaude = !!value
    // Restart Claude usage source
    if (claudeUsageHandle) { claudeUsageHandle.stop(); claudeUsageHandle = null }
    if (claudeOAuthHandle) { claudeOAuthHandle.stop(); claudeOAuthHandle = null }
    if (useOAuthClaude) {
      claudeOAuthHandle = startClaudeUsageOAuth((payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('claude-usage', payload)
      })
    } else {
      claudeUsageHandle = startClaudeUsage((payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('claude-usage', payload)
      })
    }
  }
  return { ok: true }
})

ipcMain.handle('claude-oauth-status', () => {
  if (claudeOAuthHandle) {
    return { ...claudeOAuthHandle.status(), active: useOAuthClaude }
  }
  return { tokenPresent: false, lastOk: false, failCount: 0, active: false }
})

// ── Claude Web login IPC ────────────────────────
ipcMain.handle('claude:login', async () => {
  try {
    const cw = require('./src/collectors/claude-web')
    const result = await cw.login()
    return result
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('claude:logout', async () => {
  try {
    const cw = require('./src/collectors/claude-web')
    await cw.logout()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('claude:status', () => {
  try {
    const cw = require('./src/collectors/claude-web')
    return cw.status()
  } catch {
    return { loggedIn: false, organizationId: null }
  }
})

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click() { if (win && !win.isDestroyed()) win.webContents.send('open-settings') },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  createWindow()
  createTray()

  // Read the startup entry rather than re-writing it; see setLoginItem.
  syncLoginItemSetting()

  // Apply saved settings
  const settings = loadSettings()
  useOAuthClaude = settings.useOAuthClaude || false

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
    } else if (req.url === '/claude/toggle' && win && !win.isDestroyed()) {
      try {
        await win.webContents.executeJavaScript(
          `document.getElementById('claude-toggle').click()`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
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
    } else if (req.url === '/gpu/backends') {
      // Which collector backend each host resolved to, plus what it produced.
      // First stop when an AMD host shows nothing: tells you whether detection
      // picked amd-smi, rocm-smi or bare sysfs (sysfs has no process list).
      const hosts = Object.entries(lastPayloads).map(([label, p]) => ({
        host: label,
        ok: p.ok,
        error: p.error,
        warning: p.warning || null,
        backends: p.backends || [],
        gpus: p.gpus.map(g => ({
          index: g.index, nativeIndex: g.nativeIndex, vendor: g.vendor, name: g.name,
          nulls: ['utilization', 'memoryUsed', 'memoryTotal', 'temperature', 'powerDraw', 'powerLimit', 'fanSpeed', 'clockSm'].filter(k => g[k] == null),
        })),
        processCount: p.processes.length,
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, hosts }, null, 2))
    } else if (req.url === '/debug/claude-config' && win && !win.isDestroyed()) {
      const info = await win.webContents.executeJavaScript(`(() => {
        try {
          document.getElementById('claude-config-btn').click()
          return { display: document.getElementById('claude-config-modal').style.display, rows: document.getElementById('cc-list').children.length }
        } catch (e) { return { error: e.message + '\\n' + e.stack } }
      })()`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, info }))
    } else if (req.url === '/debug/strip' && win && !win.isDestroyed()) {
      // Geometry check for the Claude usage strip: reports any pair of leaf
      // elements whose boxes actually intersect. Text that is shrunk below its
      // content width overflows and collides — this catches it numerically.
      const info = await win.webContents.executeJavaScript(`(() => {
        // A strip exists in both the top and bottom dock; only one is visible.
        const strips = Array.from(document.querySelectorAll('.cu-strip'))
        const strip = strips.find(el => el.getBoundingClientRect().width > 0)
        if (!strip) return { error: 'no visible .cu-strip', stripsInDom: strips.length }
        const leaves = Array.from(strip.querySelectorAll('*')).filter(el => {
          if (el.children.length > 0) return false
          if (!el.offsetParent && el.offsetWidth === 0) return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })
        const desc = (el) => (el.className || el.tagName) + (el.dataset.role ? '[' + el.dataset.role + ']' : '') + (el.textContent ? ' "' + el.textContent.trim().slice(0, 14) + '"' : '')
        const overlaps = []
        for (let i = 0; i < leaves.length; i++) {
          for (let j = i + 1; j < leaves.length; j++) {
            const a = leaves[i].getBoundingClientRect(), b = leaves[j].getBoundingClientRect()
            if (leaves[i].contains(leaves[j]) || leaves[j].contains(leaves[i])) continue
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
            if (ox > 1 && oy > 1) overlaps.push({ a: desc(leaves[i]), b: desc(leaves[j]), ox: Math.round(ox), oy: Math.round(oy) })
          }
        }
        const sr = strip.getBoundingClientRect()
        return {
          stripWidth: Math.round(sr.width), stripHeight: Math.round(sr.height),
          innerWidth: window.innerWidth, leaves: leaves.length,
          overflowsRight: leaves.filter(el => el.getBoundingClientRect().right > sr.right + 1).map(desc),
          overlapCount: overlaps.length, overlaps: overlaps.slice(0, 12),
        }
      })()`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, info }, null, 2))
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

app.on('window-all-closed', () => {
  const s = loadSettings()
  if (!s.minimizeToTray || !tray) app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  for (const h of Object.values(hostHandles)) h.stop()
  if (claudeUsageHandle) claudeUsageHandle.stop()
  if (claudeSwapHandle) claudeSwapHandle.stop()
  if (claudeOAuthHandle) claudeOAuthHandle.stop()
  if (winPsHost) winPsHost.stop()
})
