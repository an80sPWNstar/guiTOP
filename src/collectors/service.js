// Per-host collector service. Creates one poll loop per host; each loop is
// error-isolated so a down host never breaks the others.

const { fetchLocal, GPU_CMD, PROC_CMD } = require('./nvidia-smi')
const { parseGpus, parseProcesses } = require('./parse')
const { execRemote } = require('./ssh')
const mock = require('./mock')

const DEFAULT_INTERVAL = 1000

async function pollLocal() {
  const { gpuCsv, procCsv } = await fetchLocal()
  const gpus = parseGpus(gpuCsv)
  const uuidMap = {}
  for (const g of gpus) uuidMap[g.uuid] = g.index
  const processes = parseProcesses(procCsv, uuidMap)
  return { gpus, processes }
}

async function pollRemote(hostConfig) {
  const [gpuCsv, procCsv] = await Promise.all([
    execRemote(hostConfig, GPU_CMD),
    execRemote(hostConfig, PROC_CMD),
  ])
  const gpus = parseGpus(gpuCsv)
  const uuidMap = {}
  for (const g of gpus) uuidMap[g.uuid] = g.index
  const processes = parseProcesses(procCsv, uuidMap)
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
