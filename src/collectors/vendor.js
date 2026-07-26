// AMD/NVIDIA backend detection. Probes each host ONCE and caches the answer so
// the 1s poll loop never re-probes. All probe commands are fixed constants.

const { execFile } = require('child_process')
const { execRemote } = require('./ssh')
const fs = require('fs')

const PROBE_CMD = 'for c in nvidia-smi amd-smi rocm-smi; do command -v $c >/dev/null 2>&1 && echo $c; done; for u in /sys/class/drm/card[0-9]*/device/uevent; do grep -q "^DRIVER=amdgpu" "$u" 2>/dev/null && { echo amdgpu; break; }; done; true'

const cache = new Map()

const BACKEND_MAP = {
  'nvidia-smi': 'nvidia',
  'amd-smi': 'amd-smi',
  'rocm-smi': 'rocm-smi',
  'amdgpu': 'amd-sysfs'
}

// Every AMD backend that is present is reported, best first -- a tool being
// installed does not mean it works. Real box: rocm-smi present but aborting,
// while sysfs had complete telemetry. The caller falls down this list.
//
// sysfs outranks rocm-smi deliberately: it exposes the same fields we parse,
// costs a file read instead of a python process every second, and does not
// shift its JSON schema between ROCm releases. Neither reports processes.
const AMD_PRIORITY = ['amd-smi', 'amd-sysfs', 'rocm-smi']

function orderBackends(found) {
  const result = []
  if (found.has('nvidia')) result.push('nvidia')
  for (const b of AMD_PRIORITY) {
    if (found.has(b)) result.push(b)
  }
  return result
}

function parseBackends(stdout) {
  const lines = stdout.split('\n')
  const found = new Set()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const backend = BACKEND_MAP[trimmed]
    if (backend) {
      found.add(backend)
    }
  }

  return orderBackends(found)
}

async function probeLocal() {
  const probeBinary = (cmd, args) => {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: 3000 }, (error) => {
        if (!error) {
          resolve(true)
        } else {
          resolve(false)
        }
      })
    })
  }

  const [hasNvidia, hasAmdSmi, hasRocmSmi] = await Promise.all([
    probeBinary('nvidia-smi', ['--version']).catch(() => false),
    probeBinary('amd-smi', ['version']).catch(() => false),
    probeBinary('rocm-smi', ['--version']).catch(() => false)
  ])

  let hasAmdSysfs = false
  if (process.platform === 'linux') {
    try {
      const entries = await fs.promises.readdir('/sys/class/drm')
      for (const e of entries) {
        if (/^card\d+$/.test(e)) {
          try {
            const ueventPath = `/sys/class/drm/${e}/device/uevent`
            const content = await fs.promises.readFile(ueventPath, 'utf8')
            if (content.includes('DRIVER=amdgpu')) {
              hasAmdSysfs = true
              break
            }
          } catch {
            // skip this card on error
          }
        }
      }
    } catch {
      hasAmdSysfs = false
    }
  }

  const found = new Set()
  if (hasNvidia) found.add('nvidia')
  if (hasAmdSmi) found.add('amd-smi')
  if (hasRocmSmi) found.add('rocm-smi')
  if (hasAmdSysfs) found.add('amd-sysfs')

  return orderBackends(found)
}

async function probeRemote(hostEntry) {
  const stdout = await execRemote(hostEntry, PROBE_CMD)
  return parseBackends(stdout)
}

async function detect(hostEntry) {
  if (hostEntry.local) {
    return probeLocal()
  }
  return probeRemote(hostEntry)
}

async function detectCached(hostEntry) {
  const label = hostEntry.label
  if (!label) {
    return detect(hostEntry)
  }

  if (cache.has(label)) {
    return cache.get(label)
  }

  const promise = detect(hostEntry)
  cache.set(label, promise)

  try {
    const result = await promise
    return result
  } catch (err) {
    cache.delete(label)
    throw err
  }
}

function clearCache(label) {
  if (label === undefined) {
    cache.clear()
  } else if (typeof label === 'string' && label.length > 0) {
    cache.delete(label)
  }
}

function backendLabel(backend) {
  switch (backend) {
    case 'nvidia':
      return 'NVIDIA'
    case 'amd-smi':
      return 'AMD (amd-smi)'
    case 'rocm-smi':
      return 'AMD (rocm-smi)'
    case 'amd-sysfs':
      return 'AMD (sysfs)'
    default:
      return 'unknown'
  }
}

module.exports = {
  detect,
  detectCached,
  clearCache,
  PROBE_CMD,
  AMD_PRIORITY,
  backendLabel
}
