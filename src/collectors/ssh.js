const { Client } = require('ssh2')
const crypto = require('crypto')

// One persistent connection per host (keyed by username@host:port).
// A hard timeout per command drops the connection so a hung channel
// never holds a session forever — the next call reconnects cleanly.

let clientFactory = () => new Client()
let defaultExecTimeoutMs = 5000

// key -> { conn, ready: Promise<Client> }
const pool = new Map()

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

  let resolveReady, rejectReady
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
    if (rejectReady) rejectReady(err)
  }

  conn.on('error', onConnError)
  conn.on('close', evict)
  conn.on('end', evict)

  const connectOpts = buildConnectOpts(hostConfig, (err) => {
    evict()
    if (rejectReady) rejectReady(err)
  })

  if (!connectOpts) return ready

  conn.connect(connectOpts)

  // The 'error' listener stays for the life of the connection: a later
  // ECONNRESET must evict the entry, not throw as an unhandled 'error' event.
  conn.on('ready', () => resolveReady(conn))

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
        if (stream && typeof stream.close === 'function') stream.close()
        dropConnection(hostConfig, conn)
        rejectErr(new Error(`Command timed out after ${ms}ms: ${command}`))
      }, ms)

      conn.exec(posixWrap(command), (err, s) => {
        if (err) {
          clearTimeout(timer)
          rejectErr(err)
          return
        }
        stream = s

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
  if (!entry) return Promise.resolve()
  pool.delete(key)
  if (entry.conn && typeof entry.conn.end === 'function') entry.conn.end()
  return Promise.resolve()
}

function closeAll() {
  for (const [key, entry] of pool) {
    pool.delete(key)
    if (entry.conn && typeof entry.conn.end === 'function') entry.conn.end()
  }
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

module.exports = { execRemote, testConnect, fingerprint, posixWrap, closeHost, closeAll,
  _setClientFactory(fn) { clientFactory = fn },
  _setDefaultExecTimeout(ms) { const prev = defaultExecTimeoutMs; defaultExecTimeoutMs = ms; return prev } }
Object.defineProperty(module.exports, 'DEFAULT_EXEC_TIMEOUT_MS', { get: () => defaultExecTimeoutMs, enumerable: true })
