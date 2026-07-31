// Cookie-session Claude login (main-process only).
// Opens a claude.ai/login popup, captures the sessionKey cookie via polling,
// stores it encrypted (safeStorage), and discovers the organization id through
// a hidden BrowserWindow (plain fetch() gets blocked by Cloudflare).
// Minimal port from tempsLCD-web's claude-web.js for guiTOP's settings dialog.

const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, dialog, session, safeStorage } = require('electron')

// The live key, so a session that the user declined to persist still works for
// as long as the app is running.
let memoryKey = null

const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let _cachedUA = null

// Real Chromium UA minus "Electron" and "guiTOP" tokens — a stale hardcoded
// Chrome version is prime Cloudflare bot-bait.
function realisticUA() {
  if (_cachedUA) return _cachedUA
  const raw = app.userAgentFallback
  if (!raw) {
    _cachedUA = FALLBACK_UA
    return _cachedUA
  }
  let ua = raw.replace(/(electron|guitop)[^ ]*\/?[^\s]*\s?/gi, '')
  ua = ua.replace(/\s{2,}/g, ' ').trim()
  _cachedUA = ua
  return _cachedUA
}

// ---- store: { sessionKeyEnc | sessionKey, organizationId } ----------------

function storePath() {
  return path.join(app.getPath('userData'), 'claude-web.json')
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'))
  } catch {
    return null
  }
}

// 0600, always: this file holds a full claude.ai account credential, and the
// default mode would leave it readable by every local account. mode on write
// only applies when the file is created, so an existing file is chmod'ed too
// (a no-op on Windows, where the ACL inherited from userData already applies).
function writeStore(data) {
  const p = storePath()
  fs.writeFileSync(p, JSON.stringify(data), { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* not POSIX */ }
}

function deleteStore() {
  try {
    fs.unlinkSync(storePath())
  } catch {
    /* already gone */
  }
}

function getSessionKey() {
  if (memoryKey) return memoryKey
  const store = readStore()
  if (!store) return null
  if (store.sessionKeyEnc) {
    try {
      return safeStorage.decryptString(
        Buffer.from(store.sessionKeyEnc, 'base64')
      )
    } catch {
      return null
    }
  }
  return store.sessionKey || null
}

// Asked once per login when there is nowhere safe to put the key. Declining is
// not an error: the key stays in memory and the next launch asks for a login.
async function confirmPlaintext() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'No keyring available',
    message: 'guiTOP cannot encrypt your claude.ai session key on this machine.',
    detail: 'No OS keyring is available, so the key can only be saved as plain text in claude-web.json. '
      + 'The file is written readable by your user account only, but anyone with your login or your backups can read it.\n\n'
      + 'Keeping it in memory means logging in again the next time guiTOP starts.',
    buttons: ['Keep in memory only', 'Save unencrypted'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return response === 1
}

async function saveSessionKey(key) {
  memoryKey = key

  const store = readStore() || {}
  const hadPlaintext = !!store.sessionKey
  delete store.sessionKey
  delete store.sessionKeyEnc

  if (safeStorage.isEncryptionAvailable()) {
    store.sessionKeyEnc = safeStorage.encryptString(key).toString('base64')
    writeStore(store)
    return { persisted: true, encrypted: true }
  }

  // An existing plaintext key means this was already agreed to; don't re-ask.
  if (hadPlaintext || await confirmPlaintext()) {
    store.sessionKey = key
    writeStore(store)
    return { persisted: true, encrypted: false }
  }

  // Declined — drop whatever was on disk rather than leaving a stale key.
  writeStore(store)
  return { persisted: false, encrypted: false }
}

// ---- cookies ---------------------------------------------------------------

async function removeClaudeCookies() {
  const cookies = await session.defaultSession.cookies.get({
    name: 'sessionKey',
  })
  for (const c of cookies) {
    if (!c.domain || !c.domain.includes('claude.ai')) continue
    const url = `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`
    try {
      await session.defaultSession.cookies.remove(url, 'sessionKey')
    } catch {
      /* best effort */
    }
  }
}

// ---- public API ------------------------------------------------------------

async function login() {
  // Clear any leftover sessionKey cookies before opening the login page.
  await removeClaudeCookies().catch(() => {})

  const POLL_INTERVAL = 500
  const POLL_TIMEOUT = 5 * 60 * 1000 // 5 minutes

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  win.webContents.setUserAgent(realisticUA())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  return new Promise((resolve) => {
    let settled = false
    let pollTimer = null
    const startTime = Date.now()

    function settle(result) {
      if (settled) return
      settled = true
      if (pollTimer) clearInterval(pollTimer)
      session.defaultSession.cookies.removeListener('changed', onCookieChanged)
      if (!win.isDestroyed()) win.close()
      resolve(result)
    }

    // The cookie event and the poll can both see the same key, and saving it may
    // put a modal consent dialog on screen, so capture happens exactly once.
    let capturing = false

    function onCaptured(value) {
      if (settled || capturing) return
      capturing = true
      saveSessionKey(value)
        .catch(() => {})
        .then(() => discoverOrgId())
        .then(() => settle({ success: true }))
        .catch(() => settle({ success: true }))
    }

    // Listen for cookie-changed events — faster path than polling.
    const onCookieChanged = (_event, cookie, _cause, removed) => {
      if (settled) return
      if (cookie.name !== 'sessionKey' || removed || !cookie.value) return
      if (!cookie.domain || !cookie.domain.includes('claude.ai')) return
      onCaptured(cookie.value)
    }
    session.defaultSession.cookies.on('changed', onCookieChanged)

    // Fallback polling loop (catches cases the event misses).
    async function poll() {
      if (settled) return
      if (Date.now() - startTime > POLL_TIMEOUT) {
        settle({ success: false, error: 'Login timed out' })
        return
      }
      try {
        const cookies = await session.defaultSession.cookies.get({
          name: 'sessionKey',
          domain: 'claude.ai',
        })
        for (const c of cookies) {
          if (c.name === 'sessionKey' && c.value && !settled) {
            onCaptured(c.value)
            return
          }
        }
      } catch {
        /* retry on next tick */
      }
    }

    pollTimer = setInterval(poll, POLL_INTERVAL)

    win.on('closed', () => {
      if (settled) return
      settle({ success: false, error: 'Login window closed' })
    })

    win.loadURL('https://claude.ai/login')
  })
}

async function logout() {
  memoryKey = null
  deleteStore()
  await removeClaudeCookies().catch(() => {})
  try {
    await session.defaultSession.clearStorageData({
      origin: 'https://claude.ai',
      storages: ['localstorage', 'sessionstorage', 'cachestorage'],
    })
  } catch {
    /* best effort */
  }
}

function status() {
  const store = readStore()
  return {
    loggedIn: !!getSessionKey(),
    organizationId: store ? store.organizationId || null : null,
    // Lets the settings UI say where the key lives: 'memory' means this login
    // does not survive a restart because the user declined plaintext storage.
    keyStorage: keyStorage(store),
  }
}

function keyStorage(store) {
  if (store && store.sessionKeyEnc) return 'encrypted'
  if (store && store.sessionKey) return 'plaintext'
  if (memoryKey) return 'memory'
  return 'none'
}

// ---- internal: hidden BrowserWindow fetch + org discovery -----------------

async function discoverOrgId() {
  const key = getSessionKey()
  if (!key) throw new Error('NotLoggedIn')

  const orgs = await hiddenFetch('https://claude.ai/api/organizations')
  if (!Array.isArray(orgs) || !orgs.length) throw new Error('NoOrganization')
  const chat = orgs.filter(
    (o) =>
      o && Array.isArray(o.capabilities) && o.capabilities.includes('chat')
  )
  const pick = chat.find((o) => o.raven_type === 'team') || chat[0] || orgs[0]
  const id = pick && (pick.uuid || pick.id)
  if (!id) throw new Error('NoOrganization')

  const store = readStore() || {}
  store.organizationId = id
  writeStore(store)
  return id
}

async function hiddenFetch(url) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  try {
    win.webContents.setUserAgent(realisticUA())

    // Re-plant the stored cookie so the fetch works even if Electron's session
    // cookies were cleared while our stored key is still valid.
    const key = getSessionKey()
    if (key) {
      await session.defaultSession.cookies.set({
        url: 'https://claude.ai',
        name: 'sessionKey',
        value: key,
        domain: '.claude.ai',
        path: '/',
        secure: true,
        httpOnly: true,
      })
    }

    const body = await new Promise((resolve, reject) => {
      const FETCH_TIMEOUT = 30 * 1000
      const timer = setTimeout(() => reject(new Error('Timeout')), FETCH_TIMEOUT)
      win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
        if (!isMainFrame || code === -3) return
        clearTimeout(timer)
        reject(new Error(`LoadFailed: ${desc || code}`))
      })
      win.webContents.on('did-finish-load', () => {
        win.webContents
          .executeJavaScript('document.body.innerText || document.body.textContent')
          .then((text) => { clearTimeout(timer); resolve(text || '') })
          .catch((err) => { clearTimeout(timer); reject(err) })
      })
      win.loadURL(url).catch(() => {})
    })

    if (body.includes('Just a moment')) throw new Error('CloudflareBlocked')
    if (body.includes('Enable JavaScript and cookies to continue'))
      throw new Error('CloudflareChallenge')
    const trimmed = body.trim()
    if (trimmed.startsWith('<html') || trimmed.startsWith('<!'))
      throw new Error('UnexpectedHTML')
    try {
      return JSON.parse(trimmed)
    } catch {
      throw new Error(`InvalidJSON: ${trimmed.slice(0, 200)}`)
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

// saveSessionKey/getSessionKey are exported for test/claude-web.test.js — the
// login flow they sit behind cannot be driven headlessly.
module.exports = { login, logout, status, saveSessionKey, getSessionKey }
