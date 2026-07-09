const os = require('os')
const fs = require('fs')
const path = require('path')

const HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/
const USERNAME_RE = /^[a-zA-Z0-9._-]+$/

function validate(entry, i) {
  const tag = `hosts[${i}]`
  if (!entry || typeof entry !== 'object') throw new Error(`${tag}: not an object`)

  const { label, host, username, port, local } = entry

  if (typeof label !== 'string' || !label.trim()) throw new Error(`${tag}: missing label`)
  if (typeof host !== 'string' || !HOSTNAME_RE.test(host)) {
    throw new Error(`${tag}: invalid host "${host}" — alphanumeric, dots, hyphens, underscores only`)
  }

  if (local) return { label: label.trim(), host, local: true }

  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new Error(`${tag}: invalid username "${username}"`)
  }

  const p = port == null ? 22 : Number(port)
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`${tag}: port out of range (1–65535)`)
  }

  return { label: label.trim(), host, username, port: p }
}

function loadHosts(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('hosts config must be a non-empty array')
  }
  return arr.map(validate)
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

function loadSavedHosts(userDataDir) {
  try {
    const raw = fs.readFileSync(savedHostsPath(userDataDir), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
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
  loadHosts, validate, DEFAULT_HOSTS,
  loadSavedHosts, saveHostList,
  loadKnownHosts, saveKnownHost,
}
