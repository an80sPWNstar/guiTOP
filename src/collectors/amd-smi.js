// AMD GPU collector: amd-smi (ROCm 6+) with a legacy rocm-smi fallback.
//
// SECURITY: query strings are fixed and hard-coded; execFile is called with an
// ARGUMENT ARRAY, never a shell string. The SSH transport runs the same fixed
// command strings remotely.
//
// The amd-smi JSON schema is NOT stable across ROCm versions and field coverage
// differs consumer-vs-Instinct, so every lookup goes through the defensive
// findVal/findScalar helpers and a malformed payload yields [] rather than throwing.
// Capture real output with tools/gpu-probe.js before trusting a new field.

const { execFile } = require('child_process')

const STATIC_CMD = 'amd-smi static --json'
const METRIC_CMD = 'amd-smi metric --json'
const PROC_CMD = 'amd-smi process --json'
// --showallinfo also pulls the overdrive clock/voltage table, and on ROCm 7.2 that
// aborts the whole process (assertion in get_od_clk_volt_info). We parse nothing
// from that table, so ask only for the fields parseRocmSmi actually reads.
const ROCM_FLAGS = ['--showproductname', '--showuniqueid', '--showuse', '--showmeminfo', 'vram', '--showtemp', '--showpower', '--showmaxpower', '--showfan', '--showclocks']
const ROCM_CMD = `rocm-smi ${ROCM_FLAGS.join(' ')} --json`
// Marketing names never change, so amd-names.js asks for them once per host and
// caches. Deliberately narrower than ROCM_FLAGS: the fewer tables rocm-smi has to
// build, the fewer ways this can hit an abort like the --showallinfo one above.
const ROCM_NAME_FLAGS = ['--showproductname', '--showbus']
const ROCM_NAME_CMD = `rocm-smi ${ROCM_NAME_FLAGS.join(' ')} --json`

function staticArgs() {
  return ['static', '--json']
}

function metricArgs() {
  return ['metric', '--json']
}

function procArgs() {
  return ['process', '--json']
}

function rocmArgs() {
  return [...ROCM_FLAGS, '--json']
}

function rocmNameArgs() {
  return [...ROCM_NAME_FLAGS, '--json']
}

function execLocal(args) {
  return new Promise((resolve, reject) => {
    execFile('amd-smi', args, { timeout: 8000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout)
    })
  })
}

function execLocalRocm(args) {
  return new Promise((resolve, reject) => {
    execFile('rocm-smi', args, { timeout: 8000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout)
    })
  })
}

// --- Helpers ---

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s_-]+/g, '')
}

function findVal(obj, keyCandidates) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const candidate of keyCandidates) {
    const target = normalizeKey(candidate)
    for (const key of Object.keys(obj)) {
      if (target === normalizeKey(key)) return obj[key]
    }
    for (const key of Object.keys(obj)) {
      const val = obj[key]
      if (val && typeof val === 'object') {
        const found = findVal(val, [candidate])
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}

function isUsableScalar(val) {
  if (val === null || val === undefined) return false
  if (Array.isArray(val)) return false
  if (typeof val === 'object') {
    if (!('value' in val)) return false
  }
  return true
}

function findScalar(obj, keyCandidates) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const candidate of keyCandidates) {
    const target = normalizeKey(candidate)
    for (const key of Object.keys(obj)) {
      if (target === normalizeKey(key)) {
        const val = obj[key]
        if (isUsableScalar(val)) return val
      }
    }
    for (const key of Object.keys(obj)) {
      const val = obj[key]
      if (val && typeof val === 'object') {
        const found = findScalar(val, [candidate])
        if (found !== undefined && isUsableScalar(found)) return found
      }
    }
  }
  return undefined
}

function unwrapUnit(val) {
  if (val === null || val === undefined) return null
  if (typeof val === 'number') return val
  if (typeof val === 'object') {
    const v = val.value
    if (v === null || v === undefined) return null
    if (typeof v === 'number') return v
    if (typeof v === 'string') {
      if (/^(n\/a|na|null)$/.test(v.toLowerCase())) return null
      const num = Number(v)
      return isNaN(num) ? null : num
    }
    return null
  }
  if (typeof val === 'string') {
    if (/^(n\/a|na|null)$/.test(val.toLowerCase())) return null
    const num = Number(val)
    return isNaN(num) ? null : num
  }
  return null
}

function toMib(val, unitStr) {
  const num = unwrapUnit(val)
  if (num === null) return null
  if (unitStr) {
    const u = unitStr.toLowerCase().trim()
    if (u.includes('gib') || u.includes('gb')) return Math.round(num * 1024)
    if (u.includes('mib') || u.includes('mb')) return Math.round(num)
    if (u.includes('kib') || u.includes('kb')) return Math.round(num / 1024)
    if (u === 'b' || u === 'byte' || u === 'bytes') return Math.round(num / 1048576)
  }
  if (num > 1000000) return Math.round(num / 1048576)
  return Math.round(num)
}

function normalizeArray(data) {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    if (Array.isArray(data.gpu)) return data.gpu
    if (Array.isArray(data.gpus)) return data.gpus
  }
  return []
}

function pickGfxClock(entry) {
  let val = findScalar(entry, ['sclk', 'gfx_clk', 'gfx_0_clk', 'clocks_current_sm', 'current_sclk'])
  if (val !== undefined) return unwrapUnit(val)

  function search(obj) {
    if (!obj || typeof obj !== 'object') return null
    for (const key of Object.keys(obj)) {
      const nk = normalizeKey(key)
      if (nk.startsWith('gfx')) {
        const sub = obj[key]
        if (sub && typeof sub === 'object') {
          for (const k of Object.keys(sub)) {
            const nk2 = normalizeKey(k)
            if (nk2 === 'clk') return unwrapUnit(sub[k])
            if (nk2 === 'currentclk') return unwrapUnit(sub[k])
            if (nk2 === 'freq') return unwrapUnit(sub[k])
          }
        }
      }
    }
    for (const key of Object.keys(obj)) {
      const sub = obj[key]
      if (sub && typeof sub === 'object') {
        const found = search(sub)
        if (found !== null) return found
      }
    }
    return null
  }

  return search(entry)
}

function pickTemp(entry) {
  function search(obj) {
    if (!obj || typeof obj !== 'object') return null
    for (const key of Object.keys(obj)) {
      const nk = normalizeKey(key)
      if (nk === 'temperature') {
        const sub = obj[key]
        if (sub && typeof sub === 'object') {
          for (const k of Object.keys(sub)) {
            const nk2 = normalizeKey(k)
            if (nk2 === 'edge') return unwrapUnit(sub[k])
            if (nk2 === 'hotspot') return unwrapUnit(sub[k])
            if (nk2 === 'junction') return unwrapUnit(sub[k])
          }
        }
      }
    }
    for (const key of Object.keys(obj)) {
      const sub = obj[key]
      if (sub && typeof sub === 'object') {
        const found = search(sub)
        if (found !== null) return found
      }
    }
    return null
  }

  let val = search(entry)
  if (val !== null) return val

  val = findScalar(entry, ['temperaturesensoredge', 'edgetemperature', 'edge', 'hotspot', 'junction'])
  if (val !== undefined) return unwrapUnit(val)

  return null
}

function pickFan(entry) {
  // a) findScalar for ['fan_speed_percent', 'fan_usage', 'usage']
  let val = findScalar(entry, ['fan_speed_percent', 'fan_usage', 'usage'])
  if (val !== undefined) {
    const num = unwrapUnit(val)
    if (num !== null && num >= 0 && num <= 100) return num
  }

  // b) findScalar for ['fan_speed', 'fan_rpm', 'speed'] and ['fan_max', 'max_fan_rpm', 'max']
  let speedVal = findScalar(entry, ['fan_speed', 'fan_rpm', 'speed'])
  let maxVal = findScalar(entry, ['fan_max', 'max_fan_rpm', 'max'])
  if (speedVal !== undefined && maxVal !== undefined) {
    const speed = unwrapUnit(speedVal)
    const max = unwrapUnit(maxVal)
    if (speed !== null && max !== null && max > 0) {
      return Math.round(speed / max * 100)
    }
  }

  // c) findScalar for ['fan_speed'] alone
  val = findScalar(entry, ['fan_speed'])
  if (val !== undefined) {
    const num = unwrapUnit(val)
    if (num !== null && num >= 0 && num <= 100) return num
  }

  // d) otherwise return null
  return null
}

// --- Parsers ---

function parseAmdSmi(staticJsonText, metricJsonText) {
  try {
    let staticData = []
    let metricData = []
    try {
      staticData = normalizeArray(JSON.parse(staticJsonText))
    } catch (e) { /* ignore */ }
    try {
      metricData = normalizeArray(JSON.parse(metricJsonText))
    } catch (e) { /* ignore */ }

    const count = Math.max(staticData.length, metricData.length)
    const gpus = []
    for (let i = 0; i < count; i++) {
      const s = staticData[i] || {}
      const m = metricData[i] || {}
      const combined = { ...s, ...m }

      const idx = unwrapUnit(findVal(combined, ['gpu_index', 'index', 'id']))
      const gpuIndex = (idx !== null && idx !== undefined) ? idx : i

      const name = findVal(combined, ['market_name', 'product_name', 'device_name', 'asic_serial_name', 'card_series', 'card_model', 'name'])
      const uuidRaw = findVal(combined, ['uuid', 'gpu_uuid', 'serial_number', 'bdf', 'pci_bus_id', 'gpu_unique_id'])
      const uuid = (uuidRaw && String(uuidRaw).trim()) ? String(uuidRaw) : `AMD-${gpuIndex}`

      const utilRaw = findScalar(combined, ['gfx_activity', 'graphics_activity', 'gpu_activity', 'utilization_gpu', 'gpu_use_percent'])
      const utilization = unwrapUnit(utilRaw)

      const memUsedRaw = findScalar(combined, ['vram_used', 'used_vram', 'vram_mem', 'memory_used', 'vram_total_used'])
      const memUsedUnit = findVal(combined, ['vram_used_unit', 'used_vram_unit', 'vram_mem_unit', 'memory_used_unit', 'vram_total_used_unit'])
      const memoryUsed = toMib(memUsedRaw, memUsedUnit)

      const memTotalRaw = findScalar(combined, ['vram_total', 'total_vram', 'memory_total', 'vram_size'])
      const memTotalUnit = findVal(combined, ['vram_total_unit', 'total_vram_unit', 'memory_total_unit', 'vram_size_unit'])
      const memoryTotal = toMib(memTotalRaw, memTotalUnit)

      const temperature = pickTemp(combined)

      const powerDrawRaw = findScalar(combined, ['socket_power', 'current_socket_power', 'average_socket_power', 'power_draw', 'gfx_power'])
      const powerDraw = unwrapUnit(powerDrawRaw)

      const powerLimitRaw = findScalar(combined, ['power_limit', 'power_cap', 'max_power_limit', 'max_power', 'socket_power_limit', 'cap'])
      const powerLimit = unwrapUnit(powerLimitRaw)

      const fanSpeed = pickFan(combined)

      const clockSm = pickGfxClock(combined)

      gpus.push({
        index: gpuIndex,
        uuid,
        name: name || 'Unknown',
        utilization,
        memoryUsed,
        memoryTotal,
        temperature,
        powerDraw,
        powerLimit,
        fanSpeed,
        clockSm,
        vendor: 'amd'
      })
    }
    return gpus
  } catch (e) {
    return []
  }
}

function parseAmdSmiProcesses(procJsonText, uuidToIndex) {
  try {
    let data = []
    try {
      const parsed = JSON.parse(procJsonText)
      if (Array.isArray(parsed)) data = parsed
      else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.process)) data = parsed.process
        else if (Array.isArray(parsed.processes)) data = parsed.processes
      }
    } catch (e) { /* ignore */ }

    const processes = []
    for (const entry of data) {
      let gpuIndexFromEntry = null
      let processRecords = []

      if (entry && typeof entry === 'object') {
        let foundProcessList = false
        for (const key of Object.keys(entry)) {
          const nk = normalizeKey(key)
          if (nk === 'processlist' || nk === 'processes') {
            if (Array.isArray(entry[key])) {
              processRecords = entry[key]
              foundProcessList = true
              break
            }
          }
        }

        if (foundProcessList) {
          const gpuIdxRaw = findScalar(entry, ['gpu', 'gpuindex'])
          if (gpuIdxRaw !== undefined) {
            gpuIndexFromEntry = unwrapUnit(gpuIdxRaw)
          }
        } else {
          processRecords = [entry]
          const gpuIdxRaw = findScalar(entry, ['gpu', 'gpuindex'])
          if (gpuIdxRaw !== undefined) {
            gpuIndexFromEntry = unwrapUnit(gpuIdxRaw)
          }
        }
      } else {
        processRecords = [entry]
      }

      for (const p of processRecords) {
        let procObj = p
        if (procObj && typeof procObj === 'object' && 'process_info' in procObj) {
          procObj = procObj.process_info
        }

        const pid = unwrapUnit(findScalar(procObj, ['pid', 'processid']))
        const name = findVal(procObj, ['name', 'process_name', 'command'])
        
        let gpuUuid = null
        const uuidRaw = findVal(procObj, ['gpu_uuid', 'uuid'])
        if (uuidRaw) gpuUuid = String(uuidRaw)

        let gpuIdx = gpuIndexFromEntry
        if (gpuIdx === null && gpuUuid) {
          if (uuidToIndex.hasOwnProperty(gpuUuid)) {
            gpuIdx = uuidToIndex[gpuUuid]
          }
        }

        const memRaw = findScalar(procObj, ['vram_mem', 'used_vram', 'vram_used', 'memory_used'])
        let memUnit = null
        if (memRaw && typeof memRaw === 'object' && 'unit' in memRaw) {
          memUnit = memRaw.unit
        } else {
          memUnit = findVal(procObj, ['used_vram_unit', 'vram_used_unit', 'memory_used_unit', 'vram_mem_unit'])
        }
        const usedMemory = toMib(memRaw, memUnit)

        processes.push({
          gpuUuid: gpuUuid || null,
          gpuIndex: gpuIdx,
          pid,
          processName: name || 'Unknown',
          usedMemory,
          user: null,
          cpuPercent: null,
          memPercent: null,
          elapsedSecs: null
        })
      }
    }
    return processes
  } catch (e) {
    return []
  }
}

function parseRocmSmi(jsonText) {
  try {
    const data = JSON.parse(jsonText)
    if (!data || typeof data !== 'object') return []

    const gpus = []
    for (const cardKey of Object.keys(data)) {
      const card = data[cardKey]
      const match = cardKey.match(/(\d+)$/)
      const index = match ? parseInt(match[1], 10) : 0

      let name = null
      let uuid = null
      let pciBus = null
      let utilization = null
      let memoryUsed = null
      let memoryTotal = null
      let temperature = null
      let powerDraw = null
      let powerLimit = null
      let fanSpeed = null
      let fanLevel = null
      let clockSm = null

      for (const key of Object.keys(card)) {
        const val = card[key]
        const k = key.toLowerCase()

        if (k.includes('card vendor')) {
          continue
        } else if (k.includes('card series')) {
          name = val
        } else if (k.includes('card model') && name === null) {
          name = val
        } else if (k.includes('unique id')) {
          uuid = val
        } else if (k.includes('serial number') && uuid === null) {
          uuid = val
        } else if (k.includes('pci bus')) {
          // Kept so a caller can join these cards to another backend's by bus
          // address. The cardN key cannot do that job -- see amd-names.js.
          pciBus = val
        } else if (k.includes('gpu use')) {
          utilization = unwrapUnit(val)
        } else if (k.includes('vram total used memory')) {
          memoryUsed = toMib(val, 'bytes')
        } else if (k.includes('vram total memory')) {
          memoryTotal = toMib(val, 'bytes')
        } else if (k.includes('sensor edge')) {
          temperature = unwrapUnit(val)
        } else if (k.includes('average graphics package power') || k.includes('current socket graphics package power')) {
          powerDraw = unwrapUnit(val)
        } else if (k.includes('power limit')) {
          powerLimit = unwrapUnit(val)
        } else if (k.includes('max graphics package power') && powerLimit === null) {
          powerLimit = unwrapUnit(val)
        } else if (k.includes('fan speed') && k.includes('%')) {
          // A real card reports BOTH "Fan speed (level)" (raw PWM, 0-255) and
          // "Fan speed (%)". Match the percent key first so key order cannot
          // leave a 0-255 level sitting in a field the UI draws as a percent.
          fanSpeed = unwrapUnit(val)
        } else if (k.includes('fan speed') && k.includes('level')) {
          fanLevel = unwrapUnit(val)
        } else if (k.includes('fan speed')) {
          if (fanSpeed === null) fanSpeed = unwrapUnit(val)
        } else if (k.includes('sclk clock speed')) {
          const m = String(val).match(/(\d+)/)
          if (m) clockSm = parseInt(m[1], 10)
        }
      }

      if (fanSpeed === null && fanLevel !== null) {
        fanSpeed = Math.round(fanLevel / 255 * 100)
      }

      gpus.push({
        index,
        uuid: uuid || `AMD-${index}`,
        pciBus,
        name: name || 'Unknown',
        utilization,
        memoryUsed,
        memoryTotal,
        temperature,
        powerDraw,
        powerLimit,
        fanSpeed,
        clockSm,
        vendor: 'amd'
      })
    }
    return gpus
  } catch (e) {
    return []
  }
}

async function fetchLocal() {
  const [staticOut, metricOut, procOut] = await Promise.all([
    execLocal(staticArgs()),
    execLocal(metricArgs()),
    execLocal(procArgs()).catch(() => '')
  ])

  const gpus = parseAmdSmi(staticOut, metricOut)
  const uuidToIndex = {}
  for (const g of gpus) {
    uuidToIndex[g.uuid] = g.index
  }
  const processes = parseAmdSmiProcesses(procOut, uuidToIndex)

  return { gpus, processes }
}

module.exports = {
  STATIC_CMD,
  METRIC_CMD,
  PROC_CMD,
  ROCM_CMD,
  ROCM_NAME_CMD,
  staticArgs,
  metricArgs,
  procArgs,
  rocmArgs,
  rocmNameArgs,
  execLocal,
  execLocalRocm,
  parseAmdSmi,
  parseAmdSmiProcesses,
  parseRocmSmi,
  fetchLocal
}
