// Cookie-session Claude login & usage (main-process only).
// Opens a claude.ai/login popup, captures the sessionKey cookie via polling,
// stores it encrypted (safeStorage), and fetches usage through a hidden
// BrowserWindow (plain fetch() gets blocked by Cloudflare).
// Minimal port from tempsLCD-web's claude-web.js for guiTOP's settings dialog.

const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, session, safeStorage } = require('electron')

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

function writeStore(data) {
  fs.writeFileSync(storePath(), JSON.stringify(data))
}

function deleteStore() {
  try {
    fs.unlinkSync(storePath())
  } catch {
    /* already gone */
  }
}

function getSessionKey() {
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

function saveSessionKey(key) {
  const store = readStore() || {}
  delete store.sessionKey
  delete store.sessionKeyEnc
  if (safeStorage.isEncryptionAvailable()) {
    store.sessionKeyEnc = safeStorage.encryptString(key).toString('base64')
  } else {
    store.sessionKey = key
  }
  writeStore(store)
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

    // Listen for cookie-changed events — faster path than polling.
    const onCookieChanged = (_event, cookie, _cause, removed) => {
      if (settled) return
      if (cookie.name !== 'sessionKey' || removed || !cookie.value) return
      if (!cookie.domain || !cookie.domain.includes('claude.ai')) return
      saveSessionKey(cookie.value)
      discoverOrgId()
        .then(() => settle({ success: true }))
        .catch(() => settle({ success: true }))
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
            saveSessionKey(c.value)
            discoverOrgId()
              .then(() => settle({ success: true }))
              .catch(() => settle({ success: true }))
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
  }
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

// ---- usage fetch -----------------------------------------------------------

function pct(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function parseDate(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

async function fetchUsage() {
  if (!getSessionKey()) throw new Error('NotLoggedIn')

  const store = readStore() || {}
  const orgId = store.organizationId || (await discoverOrgId())

  const body = await hiddenFetch(
    `https://claude.ai/api/organizations/${orgId}/usage`
  )

  const sessionResetsAt = parseDate(body?.five_hour?.resets_at)
  const weekResetsAt = parseDate(body?.seven_day?.resets_at)
  if (sessionResetsAt == null && weekResetsAt == null) {
    throw new Error('SchemaMismatch')
  }

  return {
    sessionPct: pct(body?.five_hour?.utilization),
    sessionResetsAt,
    weekPct: pct(body?.seven_day?.utilization),
    weekResetsAt,
    todayTokens: body?.today_tokens ?? null,
  }
}

module.exports = { login, logout, status, fetchUsage }
