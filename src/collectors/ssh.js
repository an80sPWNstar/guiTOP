const { Client } = require('ssh2')
const crypto = require('crypto')

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64')
}

function execRemote(hostConfig, command) {
  return new Promise((resolve, reject) => {
    const { host, port = 22, username, password, knownHostKey, onUnknownKey } = hostConfig
    const conn = new Client()

    conn.on('error', (err) => reject(err))

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err) }

        let stdout = ''
        let stderr = ''

        stream.on('data', (data) => { stdout += data.toString() })
        stream.stderr.on('data', (data) => { stderr += data.toString() })

        stream.on('close', (code) => {
          conn.end()
          if (code !== 0) {
            const msg = stderr
              ? `Command exited ${code}: ${stderr.trim()}`
              : `Command exited ${code}`
            return reject(new Error(msg))
          }
          resolve(stdout)
        })

        stream.on('error', (err) => { conn.end(); reject(err) })
      })
    })

    const connectOpts = { host, port, username, readyTimeout: 10000 }

    // Auth: try agent first, fall back to password
    const agent = process.env.SSH_AUTH_SOCK
    if (agent) connectOpts.agent = agent
    if (password) connectOpts.password = password
    if (!agent && !password) {
      return reject(new Error('No SSH agent or password available'))
    }

    // Host key verification
    connectOpts.hostVerifier = (key, cb) => {
      const fp = fingerprint(key)
      if (knownHostKey && knownHostKey === fp) return cb(true)
      if (knownHostKey && knownHostKey !== fp) {
        reject(new Error(`HOST KEY MISMATCH for ${host} — expected ${knownHostKey}, got ${fp}. Possible MITM attack.`))
        return cb(false)
      }
      // Unknown key — report it
      if (onUnknownKey) {
        onUnknownKey(fp)
        reject(new Error(`UNKNOWN_HOST_KEY:${fp}`))
        return cb(false)
      }
      cb(true)
    }

    conn.connect(connectOpts)
  })
}

// Test-only connection (validates auth + host key, runs no command)
function testConnect(hostConfig) {
  return new Promise((resolve, reject) => {
    const { host, port = 22, username, password, knownHostKey } = hostConfig
    const conn = new Client()
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

module.exports = { execRemote, testConnect, fingerprint }
