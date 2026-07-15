// Per-host collector service. Creates one poll loop per host; each loop is
// error-isolated so a down host never breaks the others.

const os = require('os')
const { fetchLocal, GPU_CMD, PROC_CMD } = require('./nvidia-smi')
const { parseGpus, parseProcesses, parsePs } = require('./parse')
const { execRemote } = require('./ssh')
const mock = require('./mock')

// Windows WDDM: nvidia-smi reports per-process used_memory as [N/A]. Perf
// counters (GPU Process Memory) do have it — fill the gap on the local host.
const winGpuMem = process.platform === 'win32' ? require('./win-gpu-mem') : null
const winProcStats = process.platform === 'win32' ? require('./win-proc-stats') : null

// Fixed string (no dynamic input) — per-process user/cpu/mem/uptime on Linux.
const PS_EO_CMD = 'ps -eo pid=,user:32=,pcpu=,pmem=,etimes='

const DEFAULT_INTERVAL = 1000

async function pollLocal() {
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

async function pollRemote(hostConfig) {
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

function startHost(hostEntry, onData, { interval = DEFAULT_INTERVAL, useMock = false } = {}) {
  let timer = null
  let running = true

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
      let result
      if (useMock) {
        result = mock.fetch()
      } else if (hostEntry.local) {
        result = await pollLocal()
      } else {
        result = await pollRemote(hostEntry)
      }
      payload.gpus = result.gpus
      payload.processes = result.processes
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

module.exports = { startHost, startAll }
