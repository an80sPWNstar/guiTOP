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

  const result = []
  if (found.has('nvidia')) {
    result.push('nvidia')
  }

  if (found.has('amd-smi')) {
    result.push('amd-smi')
  } else if (found.has('rocm-smi')) {
    result.push('rocm-smi')
  } else if (found.has('amd-sysfs')) {
    result.push('amd-sysfs')
  }

  return result
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

  const result = []
  if (hasNvidia) {
    result.push('nvidia')
  }

  if (hasAmdSmi) {
    result.push('amd-smi')
  } else if (hasRocmSmi) {
    result.push('rocm-smi')
  } else if (hasAmdSysfs) {
    result.push('amd-sysfs')
  }

  return result
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
  backendLabel
}
