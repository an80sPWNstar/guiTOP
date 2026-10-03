const os = require('os')
const fs = require('fs')
const path = require('path')

const HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/
const USERNAME_RE = /^[a-zA-Z0-9._-]+$/

function validate(entry, i) {
  const tag = `hosts[${i}]`
  if (!entry || typeof entry !== 'object') throw new Error(`${tag}: not an object`)

  const { label, host, username, port, local, transport, agentPort } = entry

  if (typeof label !== 'string' || !label.trim()) throw new Error(`${tag}: missing label`)
  if (typeof host !== 'string' || !HOSTNAME_RE.test(host)) {
    throw new Error(`${tag}: invalid host "${host}" — alphanumeric, dots, hyphens, underscores only`)
  }

  if (local) return { label: label.trim(), host, local: true }

  // The agent speaks HTTP with a token and never logs in, so it needs no username.
  // Requiring one crashed startup on the config the agent README documents.
  const needsUser = transport !== 'agent' || username != null
  if (needsUser && (typeof username !== 'string' || !USERNAME_RE.test(username))) {
    throw new Error(`${tag}: invalid username "${username}"`)
  }

  const p = port == null ? 22 : Number(port)
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`${tag}: port out of range (1–65535)`)
  }

  const result = { label: label.trim(), host, username, port: p }

  // Validate transport if provided
  if (transport != null) {
    if (!['stream', 'exec', 'agent'].includes(transport)) {
      throw new Error(`${tag}: transport must be stream, exec or agent`)
    }
    result.transport = transport
  }

  // Validate agentPort if provided
  if (agentPort != null) {
    const ap = Number(agentPort)
    if (!Number.isInteger(ap) || ap < 1 || ap > 65535) {
      throw new Error(`${tag}: agentPort out of range (1–65535)`)
    }
    result.agentPort = ap
  }

  return result
}

// A hand-edited hosts.json can hold an entry validate() rejects. Throwing here used to
// abort startup with a modal error box that blocks the main thread, so a bad entry is
// set aside and reported instead, and the rest still load.
function partitionHosts(arr) {
  if (!Array.isArray(arr)) {
    return { hosts: [], invalid: [{ index: -1, raw: arr, error: 'hosts config must be an array' }] }
  }
  const hosts = []
  const invalid = []
  for (let i = 0; i < arr.length; i++) {
    try {
      hosts.push(validate(arr[i], i))
    } catch (err) {
      invalid.push({ index: i, raw: arr[i], error: err.message })
    }
  }
  return { hosts, invalid }
}

const DEFAULT_HOSTS = [
  { label: os.hostname(), host: '127.0.0.1', local: true },
]

function savedHostsPath(userDataDir) {
  return path.join(userDataDir, 'hosts.json')
}

function knownHostsPath(userDataDir) {
  return path.join(userDataDir, 'known_hosts.json')
}

// A missing file is normal (first run). A file that exists but cannot be used is not:
// startup falls back to the local host, and the next save would overwrite the user's
// hand-edited list, so a copy is kept beside it before anything else happens.
function loadSavedHosts(userDataDir) {
  const file = savedHostsPath(userDataDir)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { entries: null, error: null }
    }
    return { entries: null, error: `hosts.json could not be read (${err.message})` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    const problem = `hosts.json is not valid JSON (${err.message})`
    try { fs.copyFileSync(file, file + '.bad') } catch (_) {}
    return { entries: null, error: `${problem}; a copy was kept as hosts.json.bad` }
  }
  if (!Array.isArray(parsed)) {
    const problem = 'hosts.json is not a list of hosts'
    try { fs.copyFileSync(file, file + '.bad') } catch (_) {}
    return { entries: null, error: `${problem}; a copy was kept as hosts.json.bad` }
  }
  return { entries: parsed, error: null }
}

function saveHostList(userDataDir, rawEntries) {
  fs.writeFileSync(savedHostsPath(userDataDir), JSON.stringify(rawEntries, null, 2), 'utf8')
}

function loadKnownHosts(userDataDir) {
  try {
    const raw = fs.readFileSync(knownHostsPath(userDataDir), 'utf8')
    return JSON.parse(raw)
  } catch { return {} }
}

function saveKnownHost(userDataDir, hostKey, fingerprint) {
  const known = loadKnownHosts(userDataDir)
  known[hostKey] = fingerprint
  fs.writeFileSync(knownHostsPath(userDataDir), JSON.stringify(known, null, 2), 'utf8')
}

module.exports = {
  partitionHosts, validate, DEFAULT_HOSTS,
  loadSavedHosts, saveHostList,
  loadKnownHosts, saveKnownHost,
}
