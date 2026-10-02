const http = require('http')

const health = new Map() // key -> { failures, nextAt, requests, lastError }
const agents = new Map() // key -> http.Agent
let now = () => Date.now()

function _setNow(fn) {
  now = fn
}

function healthKey(host, port) {
  return `${host}:${port}`
}

function getAgent(host, port) {
  const key = healthKey(host, port)
  if (!agents.has(key)) {
    agents.set(key, new http.Agent({ keepAlive: true, maxSockets: 1 }))
  }
  return agents.get(key)
}

function recordFailure(h, error) {
  h.failures++
  h.lastError = error
  h.nextAt = now() + Math.min(60000, 2000 * Math.pow(2, h.failures - 1))
}

function unreachable(host, h) {
  const secs = Math.max(1, Math.ceil((h.nextAt - now()) / 1000))
  return new Error(`agent on ${host} unreachable, retrying in ${secs}s: ${h.lastError}`)
}

function exec(hostEntry, entry) {
  const { host, agentPort = 17581, agentToken } = hostEntry
  const { name } = entry
  const key = healthKey(host, agentPort)

  // Initialize health if not present
  if (!health.has(key)) {
    health.set(key, { failures: 0, nextAt: 0, requests: 0, lastError: null })
  }
  const h = health.get(key)

  // Check if no token configured
  if (!agentToken) {
    return Promise.reject(new Error(`no agent token configured for ${host}`))
  }

  // Check backoff
  if (now() < h.nextAt) {
    const backoffSec = Math.round((h.nextAt - now()) / 1000)
    return Promise.reject(new Error(`agent on ${host} unreachable, retrying in ${backoffSec}s: ${h.lastError}`))
  }

  // Make the request
  return new Promise((resolve, reject) => {
    const url = `http://${host}:${agentPort}/v1/run?name=${encodeURIComponent(name)}`
    const agent = getAgent(host, agentPort)

    const req = http.get(url, {
      agent,
      headers: { Authorization: `Bearer ${agentToken}` },
      timeout: 5000,
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        // Handle non-200 status codes
        if (res.statusCode === 401 || res.statusCode === 403) {
          recordFailure(h, `HTTP ${res.statusCode}`)
          return reject(new Error(`agent on ${host} rejected the token`))
        }

        if (res.statusCode !== 200) {
          recordFailure(h, `HTTP ${res.statusCode}`)
          return reject(unreachable(host, h))
        }

        // Parse JSON response
        try {
          const json = JSON.parse(data)
          h.requests++
          h.failures = 0
          h.lastError = null

          const { state, code, out, ageMs } = json
          if (state === 'ok') {
            if (ageMs <= 10000) {
              code === 0 ? resolve(out) : reject(new Error(`Command exited ${code}`))
            } else {
              reject(new Error(`agent sample for ${name} is ${Math.round(ageMs / 1000)}s old`))
            }
          } else if (state === 'pending') {
            reject(new Error(`agent on ${host} is warming up ${name}`))
          } else if (state === 'stuck') {
            reject(new Error(`agent on ${host}: ${name} is stuck on the remote (GPU driver hung?)`))
          } else {
            reject(new Error(`unknown agent state: ${state}`))
          }
        } catch (e) {
          recordFailure(h, `non-JSON response: ${e.message}`)
          reject(unreachable(host, h))
        }
      })
    })

    // destroy() on timeout also emits 'error'; count that failure once.
    let failed = false
    req.on('error', (err) => {
      if (failed) return
      failed = true
      recordFailure(h, err.message)
      reject(unreachable(host, h))
    })

    req.on('timeout', () => {
      if (failed) return
      failed = true
      recordFailure(h, 'timeout')
      req.destroy()
      reject(unreachable(host, h))
    })
  })
}

function closeHost(h) {
  const { host, agentPort = 17581 } = h
  const key = healthKey(host, agentPort)
  const agent = agents.get(key)
  if (agent) {
    agent.destroy()
    agents.delete(key)
  }
  health.delete(key)
}

function closeAll() {
  agents.forEach(agent => agent.destroy())
  agents.clear()
  health.clear()
}

function stats() {
  const result = {}
  health.forEach((h, key) => {
    result[key] = {
      requests: h.requests,
      failures: h.failures,
      backoffMs: Math.max(0, h.nextAt - now()),
      lastError: h.lastError,
    }
  })
  return result
}

module.exports = { exec, closeHost, closeAll, stats, _setNow }
