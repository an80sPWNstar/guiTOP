const { Client } = require('ssh2')
const crypto = require('crypto')

// One persistent connection per host (keyed by username@host:port).
// A hard timeout per command drops the connection so a hung channel
// never holds a session forever — the next call reconnects cleanly.

let clientFactory = () => new Client()
let defaultExecTimeoutMs = 5000
let now = () => Date.now()

const LOGIN_BUDGET = 6
const LOGIN_WINDOW_MS = 600000  // 10 minutes

// key -> { conn, ready: Promise<Client> }
const pool = new Map()

// Health tracking: key -> { failures, nextAt, attempts: [ms timestamps], lastError, counters }
const health = new Map()

function getHealth(key) {
  if (!health.has(key)) {
    health.set(key, {
      failures: 0,
      nextAt: 0,
      attempts: [],
      lastError: null,
      counters: {
        connects: 0,
        readies: 0,
        connectFailures: 0,
        channels: 0,
        commandTimeouts: 0,
        openTimeouts: 0
      }
    })
  }
  return health.get(key)
}

function resetHealth(key) {
  const h = getHealth(key)
  h.failures = 0
  h.nextAt = 0
  h.attempts = []
  h.lastError = null
}

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64')
}

// Our remote commands are POSIX sh, but ssh runs them under the remote user's
// LOGIN shell. fish/csh/tcsh cannot parse `for ...; do ...; done` and reject the
// string at parse time -- exit 127, nothing runs, and the host reports as down.
// Both PROBE_CMD and SYSFS_CMD contain such a loop, so both are affected.
// Wrapping makes the shell we wrote for the shell that runs.
//
// Escaping single quotes is the only quoting a POSIX single-quoted string needs;
// everything else, including $ and \, is literal inside it. Callers still pass
// fixed constants only -- this does not open an interpolation path.
function posixWrap(command) {
  return `sh -c '${command.replace(/'/g, "'\\''")}'`
}

function poolKey({ host, port = 22, username }) { return `${username}@${host}:${port}` }

function buildConnectOpts(hostConfig, reject) {
  const { host, port = 22, username, password, knownHostKey, onUnknownKey } = hostConfig

  const agent = process.env.SSH_AUTH_SOCK
  if (!agent && !password) {
    reject(new Error('No SSH agent or password available'))
    return null
  }

  const connectOpts = { host, port, username, readyTimeout: 10000, keepaliveInterval: 15000, keepaliveCountMax: 3 }
  if (agent) connectOpts.agent = agent
  if (password) connectOpts.password = password

  connectOpts.hostVerifier = (key, cb) => {
    const fp = fingerprint(key)
    if (knownHostKey && knownHostKey === fp) return cb(true)
    if (knownHostKey && knownHostKey !== fp) {
      reject(new Error(`HOST KEY MISMATCH for ${host} — expected ${knownHostKey}, got ${fp}. Possible MITM attack.`))
      return cb(false)
    }
    if (onUnknownKey) {
      onUnknownKey(fp)
      reject(new Error(`UNKNOWN_HOST_KEY:${fp}`))
      return cb(false)
    }
    cb(true)
  }

  return connectOpts
}

function getConnection(hostConfig) {
  const key = poolKey(hostConfig)
  const existing = pool.get(key)
  if (existing) return existing.ready

  // No credentials is a caller error, refused before any client exists.
  if (!process.env.SSH_AUTH_SOCK && !hostConfig.password) {
    return Promise.reject(new Error('No SSH agent or password available'))
  }

  // Check backoff and login budget before building a client
  const h = getHealth(key)
  const currentNow = now()

  if (currentNow < h.nextAt) {
    const waitSec = Math.ceil((h.nextAt - currentNow) / 1000)
    const err = new Error(`backing off ${hostConfig.host} for ${waitSec}s after: ${h.lastError}`)
    err.code = 'BACKOFF'
    return Promise.reject(err)
  }

  // Drop attempts older than LOGIN_WINDOW_MS (10 min)
  const cutoff = currentNow - LOGIN_WINDOW_MS
  h.attempts = h.attempts.filter(t => t > cutoff)

  if (h.attempts.length >= LOGIN_BUDGET) {
    const err = new Error(`login budget reached for ${hostConfig.host}: ${LOGIN_BUDGET} attempts in 10 min`)
    err.code = 'LOGIN_BUDGET'
    return Promise.reject(err)
  }

  // Record this login attempt
  h.attempts.push(currentNow)
  h.counters.connects++

  let resolveReady, rejectReady
  let isReady = false
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const conn = clientFactory()

  const entry = { conn, ready }
  pool.set(key, entry)

  function evict() {
    const cur = pool.get(key)
    if (cur && cur.conn === conn) {
      pool.delete(key)
    }
  }

  function onConnError(err) {
    evict()
    // Only apply backoff for errors before the connection is ready
    if (!isReady) {
      h.failures++
      h.lastError = err.message
      h.nextAt = now() + Math.min(60000, 2000 * Math.pow(2, h.failures - 1))
      h.counters.connectFailures++
    }
    if (rejectReady) rejectReady(err)
  }

  conn.on('error', onConnError)
  conn.on('close', evict)
  conn.on('end', evict)

  const connectOpts = buildConnectOpts(hostConfig, (err) => {
    evict()
    // Only apply backoff for errors before the connection is ready
    if (!isReady) {
      h.failures++
      h.lastError = err.message
      h.nextAt = now() + Math.min(60000, 2000 * Math.pow(2, h.failures - 1))
      h.counters.connectFailures++
    }
    if (rejectReady) rejectReady(err)
  })

  if (!connectOpts) return ready

  conn.connect(connectOpts)

  // The 'error' listener stays for the life of the connection: a later
  // ECONNRESET must evict the entry, not throw as an unhandled 'error' event.
  conn.on('ready', () => {
    isReady = true
    h.failures = 0
    h.nextAt = 0
    h.counters.readies++
    resolveReady(conn)
  })

  return ready
}

function dropConnection(hostConfig, conn) {
  const key = poolKey(hostConfig)
  const entry = pool.get(key)
  if (!entry) return
  if (conn !== undefined && entry.conn !== conn) return
  pool.delete(key)
  if (conn && typeof conn.end === 'function') conn.end()
}

function execRemote(hostConfig, command, opts = {}) {
  const ms = opts.timeoutMs ?? defaultExecTimeoutMs
  const key = poolKey(hostConfig)

  return getConnection(hostConfig).then((conn) => {
    return new Promise((resolve, reject) => {
      let settled = false
      let callbackFired = false

      function settle(val) {
        if (settled) return
        settled = true
        resolve(val)
      }

      function rejectErr(err) {
        if (settled) return
        settled = true
        reject(err)
      }

      // The timer starts BEFORE the channel is requested. A frozen or wedged
      // far end never completes the channel open, so a timer armed inside the
      // exec callback would never exist and the command would hang forever.
      let stream = null
      const timer = setTimeout(() => {
        if (callbackFired) {
          // Timer fired after stream callback delivered a stream: close stream only, keep connection
          if (stream && typeof stream.close === 'function') stream.close()
          getHealth(key).counters.commandTimeouts++
        } else {
          // Timer fired before stream callback: drop connection
          dropConnection(hostConfig, conn)
          getHealth(key).counters.openTimeouts++
        }
        rejectErr(new Error(`Command timed out after ${ms}ms: ${command}`))
      }, ms)

      conn.exec(posixWrap(command), (err, s) => {
        callbackFired = true
        if (err) {
          clearTimeout(timer)
          rejectErr(err)
          return
        }
        stream = s
        getHealth(key).counters.channels++

        let stdout = ''
        let stderr = ''

        stream.on('data', (data) => { stdout += data.toString() })
        stream.stderr.on('data', (data) => { stderr += data.toString() })

        stream.on('close', (code) => {
          clearTimeout(timer)
          if (code !== 0) {
            const msg = stderr
              ? `Command exited ${code}: ${stderr.trim()}`
              : `Command exited ${code}`
            rejectErr(new Error(msg))
          } else {
            settle(stdout)
          }
        })

        stream.on('error', (err) => {
          clearTimeout(timer)
          rejectErr(err)
        })
      })
    })
  })
}

function closeHost(hostConfig) {
  const key = poolKey(hostConfig)
  const entry = pool.get(key)
  if (entry) {
    pool.delete(key)
    if (entry.conn && typeof entry.conn.end === 'function') entry.conn.end()
  }
  resetHealth(key)
  return Promise.resolve()
}

function closeAll() {
  for (const [key, entry] of pool) {
    pool.delete(key)
    if (entry.conn && typeof entry.conn.end === 'function') entry.conn.end()
  }
  for (const key of health.keys()) {
    resetHealth(key)
  }
}

function openStream(hostConfig, command, opts = {}) {
  const openTimeoutMs = opts.openTimeoutMs ?? 10000
  const { onLine, onClose } = opts

  return getConnection(hostConfig).then((conn) => {
    return new Promise((resolve, reject) => {
      let timedOut = false
      let callbackFired = false
      let closeCalled = false
      let onCloseFired = false

      const key = poolKey(hostConfig)

      function fireOnClose(code, err) {
        if (onCloseFired) return
        onCloseFired = true
        if (onClose) onClose(code, err)
      }

      const timer = setTimeout(() => {
        timedOut = true
        if (!callbackFired) {
          // Drop connection if callback hasn't fired
          dropConnection(hostConfig, conn)
          getHealth(key).counters.openTimeouts++
          reject(new Error(`Stream open timed out after ${openTimeoutMs}ms: ${command}`))
        }
      }, openTimeoutMs)

      conn.exec(posixWrap(command), (err, stream) => {
        callbackFired = true
        clearTimeout(timer)

        if (err) {
          reject(err)
          return
        }

        if (timedOut) {
          if (stream && typeof stream.close === 'function') stream.close()
          return
        }

        getHealth(key).counters.channels++

        let lineBuffer = ''
        let streamClosed = false

        stream.on('data', (data) => {
          lineBuffer += data.toString()
          const lines = lineBuffer.split('\n')
          // Process all complete lines except the last chunk (which might be incomplete)
          for (let i = 0; i < lines.length - 1; i++) {
            let line = lines[i]
            if (line.endsWith('\r')) {
              line = line.slice(0, -1)
            }
            if (onLine) onLine(line)
          }
          // Keep the incomplete last chunk for next data event
          lineBuffer = lines[lines.length - 1]
        })

        stream.stderr.on('data', () => {
          // drain and ignore stderr
        })

        stream.on('close', (code) => {
          if (streamClosed) return
          streamClosed = true
          // Don't flush incomplete last line; just discard it
          fireOnClose(code)
        })

        stream.on('error', (err) => {
          if (streamClosed) return
          streamClosed = true
          fireOnClose(null, err)
        })

        resolve({
          close() {
            if (closeCalled) return
            closeCalled = true
            if (stream && typeof stream.close === 'function') {
              stream.close()
            }
            // If onClose hasn't fired yet, fire it after close
            setImmediate(() => fireOnClose(null))
          }
        })
      })
    })
  })
}

function stats() {
  const result = {}
  for (const [key, h] of health) {
    if (!h || (pool.get(key) === undefined && h.attempts.length === 0 && h.failures === 0)) {
      continue
    }
    const connected = pool.has(key)
    const loginsLast10m = h.attempts.length
    result[key] = {
      connected,
      connects: h.counters.connects,
      readies: h.counters.readies,
      connectFailures: h.counters.connectFailures,
      channels: h.counters.channels,
      commandTimeouts: h.counters.commandTimeouts,
      openTimeouts: h.counters.openTimeouts,
      loginsLast10m,
      backoffMs: Math.max(0, h.nextAt - now()),
      lastError: h.lastError
    }
  }
  return result
}

function testConnect(hostConfig) {
  return new Promise((resolve, reject) => {
    const { host, port = 22, username, password, knownHostKey } = hostConfig
    const conn = clientFactory()
    let reportedFp = null

    conn.on('error', (err) => {
      if (reportedFp && err.message && err.message.startsWith('UNKNOWN_HOST_KEY:')) {
        return reject({ needsAccept: true, fingerprint: reportedFp })
      }
      reject(err)
    })

    conn.on('ready', () => {
      conn.end()
      resolve({ ok: true, fingerprint: reportedFp })
    })

    const connectOpts = { host, port, username, readyTimeout: 10000 }
    const agent = process.env.SSH_AUTH_SOCK
    if (agent) connectOpts.agent = agent
    if (password) connectOpts.password = password
    if (!agent && !password) {
      return reject(new Error('No SSH agent or password available'))
    }

    connectOpts.hostVerifier = (key, cb) => {
      const fp = fingerprint(key)
      reportedFp = fp
      if (knownHostKey && knownHostKey === fp) return cb(true)
      if (knownHostKey && knownHostKey !== fp) {
        reject(new Error(`HOST KEY CHANGED for ${host} — possible MITM attack`))
        return cb(false)
      }
      // Unknown — reject to surface fingerprint
      reject({ needsAccept: true, fingerprint: fp })
      return cb(false)
    }

    conn.connect(connectOpts)
  })
}

module.exports = { execRemote, testConnect, fingerprint, posixWrap, closeHost, closeAll, openStream, stats,
  _setClientFactory(fn) { clientFactory = fn },
  _setDefaultExecTimeout(ms) { const prev = defaultExecTimeoutMs; defaultExecTimeoutMs = ms; return prev },
  _setNow(fn) { now = fn },
  LOGIN_BUDGET,
  LOGIN_WINDOW_MS }
Object.defineProperty(module.exports, 'DEFAULT_EXEC_TIMEOUT_MS', { get: () => defaultExecTimeoutMs, enumerable: true })
