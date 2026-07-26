// Per-host collector service. Creates one poll loop per host; each loop is
// error-isolated so a down host never breaks the others.

const os = require('os')
const { fetchLocal, GPU_CMD, PROC_CMD } = require('./nvidia-smi')
const { parseGpus, parseProcesses, parsePs } = require('./parse')
const { execRemote } = require('./ssh')
const vendor = require('./vendor')
const amdSmi = require('./amd-smi')
const amdSysfs = require('./amd-sysfs')
const mock = require('./mock')

// Windows WDDM: nvidia-smi reports per-process used_memory as [N/A]. Perf
// counters (GPU Process Memory) do have it — fill the gap on the local host.
const winGpuMem = process.platform === 'win32' ? require('./win-gpu-mem') : null
const winProcStats = process.platform === 'win32' ? require('./win-proc-stats') : null

// Fixed string (no dynamic input) — per-process user/cpu/mem/uptime on Linux.
const PS_EO_CMD = 'ps -eo pid=,user:32=,pcpu=,pmem=,etimes='

const DEFAULT_INTERVAL = 1000

async function pollLocalNvidia() {
  const { gpuCsv, procCsv } = await fetchLocal()
  const gpus = parseGpus(gpuCsv)
  const uuidMap = {}
  for (const g of gpus) uuidMap[g.uuid] = g.index
  const processes = parseProcesses(procCsv, uuidMap)
  if (winGpuMem) {
    const nameByIndex = {}
    for (const g of gpus) nameByIndex[g.index] = g.name
    const totalMem = os.totalmem()
    const nowSecs = Date.now() / 1000
    for (const p of processes) {
      if (p.usedMemory == null) p.usedMemory = winGpuMem.lookup(p.pid, nameByIndex[p.gpuIndex])
      const st = winProcStats.lookup(p.pid)
      p.user = st ? st.user : null
      p.cpuPercent = st ? st.cpuPercent : null
      p.memPercent = st && st.memBytes != null ? Math.round((st.memBytes / totalMem) * 1000) / 10 : null
      p.elapsedSecs = st && st.startEpoch != null ? Math.max(0, Math.floor(nowSecs - st.startEpoch)) : null
    }
  }
  return { gpus, processes }
}

async function pollRemoteNvidia(hostConfig) {
  const [gpuCsv, procCsv, psOut] = await Promise.all([
    execRemote(hostConfig, GPU_CMD),
    execRemote(hostConfig, PROC_CMD),
    execRemote(hostConfig, PS_EO_CMD).catch(() => ''),
  ])
  const gpus = parseGpus(gpuCsv)
  const uuidMap = {}
  for (const g of gpus) uuidMap[g.uuid] = g.index
  const processes = parseProcesses(procCsv, uuidMap)
  const stats = parsePs(psOut)
  for (const p of processes) {
    const st = p.pid != null ? stats[p.pid] : null
    p.user = st ? st.user : null
    p.cpuPercent = st ? st.cpuPercent : null
    p.memPercent = st ? st.memPercent : null
    p.elapsedSecs = st ? st.elapsedSecs : null
  }
  return { gpus, processes }
}

// --- AMD backends (Linux only: amd-smi, legacy rocm-smi, or bare amdgpu sysfs) ---

function attachPsStats(processes, psOut) {
  const stats = parsePs(psOut)
  for (const p of processes) {
    const st = p.pid != null ? stats[p.pid] : null
    p.user = st ? st.user : null
    p.cpuPercent = st ? st.cpuPercent : null
    p.memPercent = st ? st.memPercent : null
    p.elapsedSecs = st ? st.elapsedSecs : null
  }
  return processes
}

async function pollRemoteAmdSmi(hostConfig) {
  const [staticOut, metricOut, procOut, psOut] = await Promise.all([
    execRemote(hostConfig, amdSmi.STATIC_CMD),
    execRemote(hostConfig, amdSmi.METRIC_CMD),
    execRemote(hostConfig, amdSmi.PROC_CMD).catch(() => ''),
    execRemote(hostConfig, PS_EO_CMD).catch(() => ''),
  ])
  const gpus = amdSmi.parseAmdSmi(staticOut, metricOut)
  const uuidMap = {}
  for (const g of gpus) uuidMap[g.uuid] = g.index
  const processes = amdSmi.parseAmdSmiProcesses(procOut, uuidMap)
  return { gpus, processes: attachPsStats(processes, psOut) }
}

async function pollRemoteRocmSmi(hostConfig) {
  const out = await execRemote(hostConfig, amdSmi.ROCM_CMD)
  return { gpus: amdSmi.parseRocmSmi(out), processes: [] }
}

async function pollRemoteAmdSysfs(hostConfig) {
  const out = await execRemote(hostConfig, amdSysfs.SYSFS_CMD)
  return { gpus: amdSysfs.parseSysfs(out), processes: [] }
}

const REMOTE_POLLERS = {
  'nvidia': pollRemoteNvidia,
  'amd-smi': pollRemoteAmdSmi,
  'rocm-smi': pollRemoteRocmSmi,
  'amd-sysfs': pollRemoteAmdSysfs,
}

const LOCAL_POLLERS = {
  'nvidia': pollLocalNvidia,
  'amd-smi': () => amdSmi.fetchLocal(),
  'rocm-smi': async () => ({ gpus: amdSmi.parseRocmSmi(await amdSmi.execLocalRocm(amdSmi.rocmArgs())), processes: [] }),
  'amd-sysfs': () => amdSysfs.fetchLocal(),
}

// One host can hold cards from both vendors. Each backend numbers its own cards
// from 0, so shift every backend after the first past the previous one's highest
// index — otherwise two different cards both render as "GPU 0". The original
// per-vendor index is kept as nativeIndex. Single-backend hosts get no shift.
function mergeBackendResults(parts) {
  const gpus = []
  const processes = []
  let offset = 0

  for (const part of parts) {
    if (!part) continue
    let highest = -1
    for (const g of part.gpus) {
      const native = g.index
      if (native > highest) highest = native
      gpus.push({ ...g, nativeIndex: native, index: offset + native })
    }
    for (const p of part.processes) {
      processes.push({ ...p, gpuIndex: p.gpuIndex == null ? null : offset + p.gpuIndex })
    }
    offset += highest + 1
  }

  return { gpus, processes }
}

// The AMD tools all describe the SAME cards, so only one may serve a host or every
// card renders twice. NVIDIA is independent and always polled alongside. Group the
// detected backends into slots: one slot = one set of cards = one winning backend.
function planSlots(backends) {
  const slots = []
  if (backends.includes('nvidia')) slots.push(['nvidia'])
  const amd = vendor.AMD_PRIORITY.filter(b => backends.includes(b))
  if (amd.length) slots.push(amd)
  return slots
}

function slotName(candidates) {
  return candidates[0] === 'nvidia' ? 'nvidia' : 'amd'
}

// Walk a slot's candidates best-first and keep the first that actually produces a
// card. Installed does not mean working: a real ROCm 7.2 box had rocm-smi present
// but aborting, so the old code took the whole host down while sysfs sat there with
// full telemetry. The winner is remembered so steady state is one call per slot,
// and forgotten the moment it stops delivering so the chain is re-walked.
async function pollSlot(hostEntry, candidates, pollers, state) {
  const name = slotName(candidates)
  const chosen = state.chosen[name]
  const order = chosen ? [chosen, ...candidates.filter(b => b !== chosen)] : candidates

  const notes = []
  let empty = null

  for (const backend of order) {
    const poll = pollers[backend]
    if (!poll) {
      notes.push(`${backend}: no poller`)
      continue
    }
    try {
      const result = await poll(hostEntry)
      if (result && result.gpus && result.gpus.length > 0) {
        state.chosen[name] = backend
        return { backend, result, notes }
      }
      // Parsed fine but described no cards -- keep it only if nothing better shows up.
      if (!empty) empty = { backend, result: result || { gpus: [], processes: [] } }
      notes.push(`${backend}: reported no GPUs`)
    } catch (err) {
      notes.push(`${backend}: ${err.message}`)
    }
  }

  delete state.chosen[name]
  if (empty) return { ...empty, notes }
  throw new Error(notes.join('; ') || `no working backend for ${name}`)
}

async function pollHost(hostEntry, state) {
  const backends = await vendor.detectCached(hostEntry)
  const slots = planSlots(backends)
  if (slots.length === 0) {
    throw new Error('no GPU backend found (nvidia-smi, amd-smi, rocm-smi, amdgpu sysfs)')
  }

  const pollers = hostEntry.local ? LOCAL_POLLERS : REMOTE_POLLERS
  const settled = await Promise.all(slots.map(async (candidates) => {
    try {
      return await pollSlot(hostEntry, candidates, pollers, state)
    } catch (err) {
      return { error: err, notes: [] }
    }
  }))

  // One dead slot must not hide a healthy one -- only fail if every slot failed.
  const ok = settled.filter(s => s.result)
  if (ok.length === 0) {
    throw new Error(settled.map(s => s.error.message).join(' | '))
  }

  const merged = mergeBackendResults(ok.map(s => s.result))
  merged.backends = ok.map(s => s.backend)

  const notes = settled.flatMap(s => s.notes).concat(settled.filter(s => s.error).map(s => s.error.message))
  if (notes.length) merged.warning = notes.join('; ')
  return merged
}

function startHost(hostEntry, onData, { interval = DEFAULT_INTERVAL, useMock = false, mockVendor = 'nvidia' } = {}) {
  let timer = null
  let running = true

  // Which backend won each slot on this host. Lives with the poll loop, so it is
  // gone when the host is removed.
  const state = { chosen: {} }

  async function tick() {
    const payload = {
      host: hostEntry.label,
      ok: true,
      error: null,
      ts: Date.now(),
      gpus: [],
      processes: [],
    }

    try {
      const result = useMock ? mock.fetch(3, mockVendor) : await pollHost(hostEntry, state)
      payload.gpus = result.gpus
      payload.processes = result.processes
      if (result.backends) payload.backends = result.backends
      if (result.warning) payload.warning = result.warning
    } catch (err) {
      payload.ok = false
      payload.error = err.message || String(err)
    }

    if (running) onData(payload)
  }

  // Defer first tick so the caller has the handle before onData fires.
  setImmediate(tick)
  timer = setInterval(tick, interval)

  return {
    stop() {
      running = false
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

// Start collectors for an array of host entries. Returns a stop-all handle.
function startAll(hosts, onData, opts) {
  const handles = hosts.map(h => startHost(h, onData, opts))
  return {
    stop() { handles.forEach(h => h.stop()) },
  }
}

// mergeBackendResults, planSlots and pollSlot are exported for tests only.
module.exports = { startHost, startAll, mergeBackendResults, planSlots, pollSlot }
