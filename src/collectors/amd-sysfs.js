// AMD GPU stats straight from the Linux amdgpu driver sysfs interface, so AMD
// hosts work with no ROCm installed. Local path reads the files directly; remote
// path parses the stdout of SYSFS_CMD (one fixed command, one SSH round trip).
//
// Cards are only reported when their uevent says DRIVER=amdgpu -- NVIDIA and Intel
// drivers also create /sys/class/drm/cardN entries.

const fs = require('fs')
const path = require('path')

const SYSFS_CMD = 'grep -H . /sys/class/drm/card*/device/gpu_busy_percent /sys/class/drm/card*/device/mem_busy_percent /sys/class/drm/card*/device/mem_info_vram_used /sys/class/drm/card*/device/mem_info_vram_total /sys/class/drm/card*/device/product_name /sys/class/drm/card*/device/hwmon/hwmon*/temp1_input /sys/class/drm/card*/device/hwmon/hwmon*/temp1_label /sys/class/drm/card*/device/hwmon/hwmon*/power1_average /sys/class/drm/card*/device/hwmon/hwmon*/power1_input /sys/class/drm/card*/device/hwmon/hwmon*/power1_cap /sys/class/drm/card*/device/hwmon/hwmon*/pwm1 /sys/class/drm/card*/device/hwmon/hwmon*/pwm1_max /sys/class/drm/card*/device/hwmon/hwmon*/fan1_input /sys/class/drm/card*/device/hwmon/hwmon*/fan1_max /sys/class/drm/card*/device/hwmon/hwmon*/freq1_input /sys/class/drm/card*/device/uevent 2>/dev/null; for d in /sys/class/drm/card*/device; do for f in pp_dpm_sclk; do [ -f "$d/$f" ] && sed "s|^|$d/$f:|" "$d/$f"; done; done 2>/dev/null; true'

function parseBytesToMiB(val) {
  if (val === null || val === undefined) return null
  const bytes = parseInt(val, 10)
  if (isNaN(bytes)) return null
  return Math.round(bytes / 1048576)
}

function parseMilliCelsius(val) {
  if (val === null || val === undefined) return null
  const milli = parseInt(val, 10)
  if (isNaN(milli)) return null
  return Math.round((milli / 1000) * 10) / 10
}

function parseMicrowattsToWatts(val) {
  if (val === null || val === undefined) return null
  const uw = parseInt(val, 10)
  if (isNaN(uw)) return null
  return Math.round((uw / 1000000) * 10) / 10
}

function parseMicrowattsToWattsInt(val) {
  if (val === null || val === undefined) return null
  const uw = parseInt(val, 10)
  if (isNaN(uw)) return null
  return Math.round(uw / 1000000)
}

function parseHertzToMHz(val) {
  if (val === null || val === undefined) return null
  const hz = parseInt(val, 10)
  if (isNaN(hz)) return null
  const mhz = hz / 1000000
  if (mhz < 10 || mhz > 5000) return null
  return Math.round(mhz)
}

function parseFanPercent(inputStr, maxStr) {
  if (inputStr === null || inputStr === undefined) return null
  const rpm = parseInt(inputStr, 10)
  if (isNaN(rpm)) return null
  if (maxStr === null || maxStr === undefined) return null
  const max = parseInt(maxStr, 10)
  if (isNaN(max) || max <= 0) return null
  return Math.round((rpm / max) * 100)
}

// Two different fan percentages exist on the same card. fan1_input/fan1_max is a
// ratio of tachometer RPM against the highest RPM the driver will command; pwm1
// is the duty cycle actually being driven. On a real RX 9070 XT those read 31%
// and 35% at the same instant, and rocm-smi's own "Fan Level" was byte-identical
// to pwm1 (89), so PWM is what every other AMD tool shows. Prefer it.
//
// pwm1_max is read rather than assumed to be 255: guessing a divisor is how a fan
// meter ends up reading 200%. When it is absent the PWM basis is unknown, so the
// RPM ratio is used instead -- a slightly-off number beats a wrong one.
//
// Deliberately NOT gated on pwm1_enable: that file does not exist on the very card
// this path targets, so requiring it would fall back to RPM exactly where the fix
// is needed.
function fanPercent(raw) {
  const pwm = parseFanPercent(raw.pwm1, raw.pwm1_max)
  if (pwm !== null) return pwm
  return parseFanPercent(raw.fan1_input, raw.fan1_max)
}

function extractCardIndex(filePath) {
  const match = filePath.match(/\/sys\/class\/drm\/card(\d+)\//)
  if (!match) return null
  return parseInt(match[1], 10)
}

function isAmdgpu(ueventText) {
  if (!ueventText) return false
  const lines = ueventText.split('\n')
  for (const line of lines) {
    if (line.trim() === 'DRIVER=amdgpu') {
      return true
    }
  }
  return false
}

function parsePpDpmSclk(lines) {
  let activeMhz = null
  for (const line of lines) {
    if (line.trim().endsWith('*')) {
      const match = line.match(/(\d+)\s*Mhz/i)
      if (match) {
        activeMhz = parseInt(match[1], 10)
      }
    }
  }
  return activeMhz
}

function parseUevent(text) {
  const pciId = {}
  const pciSlot = {}
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.startsWith('PCI_ID=')) {
      pciId.raw = line.substring(7)
    }
    if (line.startsWith('PCI_SLOT_NAME=')) {
      pciSlot.raw = line.substring(14)
    }
  }
  return { pciId, pciSlot }
}

function parseSysfs(text) {
  if (!text) return []

  const cards = {}
  const lines = text.split('\n')

  for (const line of lines) {
    if (!line.trim()) continue

    const firstColonIndex = line.indexOf(':')
    if (firstColonIndex === -1) continue

    const filePath = line.substring(0, firstColonIndex)
    const value = line.substring(firstColonIndex + 1)

    const index = extractCardIndex(filePath)
    if (index === null) continue

    if (!cards[index]) {
      cards[index] = {
        index,
        uuid: null,
        name: null,
        utilization: null,
        memoryUsed: null,
        memoryTotal: null,
        temperature: null,
        powerDraw: null,
        powerLimit: null,
        fanSpeed: null,
        clockSm: null,
        vendor: 'amd',
        _raw: {}
      }
    }

    const card = cards[index]

    if (filePath.endsWith('gpu_busy_percent')) {
      const val = parseInt(value, 10)
      if (!isNaN(val)) card.utilization = val
    }
    else if (filePath.endsWith('mem_info_vram_used')) {
      card.memoryUsed = parseBytesToMiB(value)
    }
    else if (filePath.endsWith('mem_info_vram_total')) {
      card.memoryTotal = parseBytesToMiB(value)
    }
    else if (filePath.endsWith('temp1_input')) {
      card.temperature = parseMilliCelsius(value)
    }
    else if (filePath.endsWith('power1_average')) {
      card._raw.power1_average = value
    }
    else if (filePath.endsWith('power1_input')) {
      card._raw.power1_input = value
    }
    else if (filePath.endsWith('power1_cap')) {
      card.powerLimit = parseMicrowattsToWattsInt(value)
    }
    else if (filePath.endsWith('fan1_input')) {
      card._raw.fan1_input = value
    }
    else if (filePath.endsWith('fan1_max')) {
      card._raw.fan1_max = value
    }
    // pwm1_max must be tested first: endsWith('pwm1') would never match it, but
    // the reverse order is the kind of thing a later edit gets wrong silently.
    else if (filePath.endsWith('pwm1_max')) {
      card._raw.pwm1_max = value
    }
    else if (filePath.endsWith('pwm1')) {
      card._raw.pwm1 = value
    }
    else if (filePath.endsWith('freq1_input')) {
      card._raw.freq1_input = value
    }
    else if (filePath.endsWith('product_name')) {
      const name = value.trim()
      if (name) card.name = name
    }
    else if (filePath.endsWith('uevent')) {
      if (!card._raw.uevent_lines) {
        card._raw.uevent_lines = []
      }
      card._raw.uevent_lines.push(value)
    }
    else if (filePath.endsWith('pp_dpm_sclk')) {
      if (!card._raw.pp_dpm_sclk_lines) {
        card._raw.pp_dpm_sclk_lines = []
      }
      card._raw.pp_dpm_sclk_lines.push(value)
    }
  }

  const result = []

  for (const index of Object.keys(cards).map(Number).sort((a, b) => a - b)) {
    const card = cards[index]
    const raw = card._raw

    // Filter non-AMD GPUs
    if (raw.uevent_lines && raw.uevent_lines.length > 0) {
      const ueventText = raw.uevent_lines.join('\n')
      if (!isAmdgpu(ueventText)) {
        continue
      }
    }

    // Power draw logic
    let powerDraw = null
    if (raw.power1_average) {
      const avg = parseMicrowattsToWatts(raw.power1_average)
      if (avg !== null && avg > 0) {
        powerDraw = avg
      }
    }
    if (powerDraw === null && raw.power1_input) {
      powerDraw = parseMicrowattsToWatts(raw.power1_input)
    }
    card.powerDraw = powerDraw

    // Fan speed logic
    card.fanSpeed = fanPercent(raw)

    // Clock logic
    let clockSm = null
    if (raw.freq1_input) {
      clockSm = parseHertzToMHz(raw.freq1_input)
    }
    if (clockSm === null && raw.pp_dpm_sclk_lines) {
      clockSm = parsePpDpmSclk(raw.pp_dpm_sclk_lines)
    }
    card.clockSm = clockSm

    // Name and UUID logic
    if (raw.uevent_lines) {
      const ueventText = raw.uevent_lines.join('\n')
      const ueventData = parseUevent(ueventText)
      if (ueventData.pciSlot.raw) {
        card.uuid = 'AMD-' + ueventData.pciSlot.raw
      }
      if (!card.name && ueventData.pciId.raw) {
        const parts = ueventData.pciId.raw.split(':')
        if (parts.length > 1) {
          card.name = 'AMD GPU ' + parts[1]
        } else {
          card.name = 'AMD GPU'
        }
      }
    }

    if (!card.uuid) {
      card.uuid = 'AMD-card' + index
    }

    if (!card.name) {
      card.name = 'AMD GPU'
    }

    // DRM numbering is not dense and does not have to start at 0 -- a real capture
    // had a lone GPU at card1. Renumber the cards we keep so they read 0..N-1 and
    // the mixed-vendor merge cannot leave a phantom slot. Real number kept for debug.
    card.drmCard = index
    card.index = result.length

    // Clean up internal raw data
    delete card._raw

    result.push(card)
  }

  return result
}

async function fetchLocal() {
  const gpus = []

  try {
    const drmDir = '/sys/class/drm'
    const entries = await fs.promises.readdir(drmDir)
    const cardEntries = entries.filter(e => /^card\d+$/.test(e)).sort((a, b) => {
      const idxA = parseInt(a.replace('card', ''), 10)
      const idxB = parseInt(b.replace('card', ''), 10)
      return idxA - idxB
    })

    for (const cardName of cardEntries) {
      const index = parseInt(cardName.replace('card', ''), 10)
      const devicePath = path.join(drmDir, cardName, 'device')

      // Helper to read file safely
      const readFile = async (filePath) => {
        try {
          return (await fs.promises.readFile(filePath, 'utf-8')).trim()
        } catch (e) {
          return null
        }
      }

      // Check uevent first to ensure it's an AMD GPU
      const uevent = await readFile(path.join(devicePath, 'uevent'))
      if (!uevent || !isAmdgpu(uevent)) {
        continue
      }

      const gpu = {
        index,
        uuid: null,
        name: null,
        utilization: null,
        memoryUsed: null,
        memoryTotal: null,
        temperature: null,
        powerDraw: null,
        powerLimit: null,
        fanSpeed: null,
        clockSm: null,
        vendor: 'amd'
      }

      // Read device-level files in parallel
      const [busy, memUsed, memTotal, productName, ppDpmSclk] = await Promise.all([
        readFile(path.join(devicePath, 'gpu_busy_percent')),
        readFile(path.join(devicePath, 'mem_info_vram_used')),
        readFile(path.join(devicePath, 'mem_info_vram_total')),
        readFile(path.join(devicePath, 'product_name')),
        readFile(path.join(devicePath, 'pp_dpm_sclk'))
      ])

      // Utilization
      if (busy !== null) {
        const val = parseInt(busy, 10)
        if (!isNaN(val)) gpu.utilization = val
      }

      // Memory
      gpu.memoryUsed = parseBytesToMiB(memUsed)
      gpu.memoryTotal = parseBytesToMiB(memTotal)

      // Name
      if (productName) gpu.name = productName

      // Hwmon
      let hwmonPath = null
      try {
        const hwmonDir = path.join(devicePath, 'hwmon')
        const hwmonEntries = await fs.promises.readdir(hwmonDir)
        const hwmonMatch = hwmonEntries.find(e => /^hwmon\d+$/.test(e))
        if (hwmonMatch) {
          hwmonPath = path.join(hwmonDir, hwmonMatch)
        }
      } catch (e) {
        // ignore
      }

      if (hwmonPath) {
        // Read hwmon-level files in parallel
        const [tempInput, powerAvg, powerInput, powerCap, fanInput, fanMax, pwm, pwmMax, freqInput] = await Promise.all([
          readFile(path.join(hwmonPath, 'temp1_input')),
          readFile(path.join(hwmonPath, 'power1_average')),
          readFile(path.join(hwmonPath, 'power1_input')),
          readFile(path.join(hwmonPath, 'power1_cap')),
          readFile(path.join(hwmonPath, 'fan1_input')),
          readFile(path.join(hwmonPath, 'fan1_max')),
          readFile(path.join(hwmonPath, 'pwm1')),
          readFile(path.join(hwmonPath, 'pwm1_max')),
          readFile(path.join(hwmonPath, 'freq1_input'))
        ])

        // Temperature
        gpu.temperature = parseMilliCelsius(tempInput)

        // Power
        gpu.powerLimit = parseMicrowattsToWattsInt(powerCap)

        let powerDraw = null
        if (powerAvg) {
          const avg = parseMicrowattsToWatts(powerAvg)
          if (avg !== null && avg > 0) {
            powerDraw = avg
          }
        }
        if (powerDraw === null && powerInput) {
          powerDraw = parseMicrowattsToWatts(powerInput)
        }
        gpu.powerDraw = powerDraw

        // Fan
        gpu.fanSpeed = fanPercent({ pwm1: pwm, pwm1_max: pwmMax, fan1_input: fanInput, fan1_max: fanMax })

        // Clock (freq1_input)
        gpu.clockSm = parseHertzToMHz(freqInput)
      }

      // Fallback Clock (pp_dpm_sclk)
      if (gpu.clockSm === null && ppDpmSclk) {
        const lines = ppDpmSclk.split('\n')
        gpu.clockSm = parsePpDpmSclk(lines)
      }

      // UUID and Name fallback from uevent
      if (uevent) {
        const ueventData = parseUevent(uevent)
        if (ueventData.pciSlot.raw) {
          gpu.uuid = 'AMD-' + ueventData.pciSlot.raw
        }
        if (!gpu.name && ueventData.pciId.raw) {
          const parts = ueventData.pciId.raw.split(':')
          if (parts.length > 1) {
            gpu.name = 'AMD GPU ' + parts[1]
          } else {
            gpu.name = 'AMD GPU'
          }
        }
      }

      if (!gpu.uuid) {
        gpu.uuid = 'AMD-card' + index
      }

      if (!gpu.name) {
        gpu.name = 'AMD GPU'
      }

      // Dense 0..N-1 display index; see the same note in parseSysfs.
      gpu.drmCard = index
      gpu.index = gpus.length

      gpus.push(gpu)
    }
  } catch (e) {
    // If /sys/class/drm doesn't exist or other errors, return empty
  }

  return { gpus, processes: [] }
}

module.exports = {
  SYSFS_CMD,
  parseSysfs,
  fetchLocal
}
