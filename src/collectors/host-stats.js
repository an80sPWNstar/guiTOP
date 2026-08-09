// Host-level CPU and RAM, the pair nvitop shows above its GPU panels.
//
// One sample per host per tick, reported once next to the host name rather than
// on every card. Two sources, no child process on either:
//
//   local  — os.cpus() and os.totalmem()/os.freemem(). Works on every platform,
//            so Windows needs no PowerShell here.
//   remote — one fixed command, `cat /proc/stat /proc/meminfo`, added to the
//            per-tick SSH calls. Linux only; anything else reports null and the
//            renderer simply draws no meters.
//
// CPU percent is a DELTA between consecutive samples -- the kernel exposes
// cumulative jiffies, not a rate -- so the first tick after a host starts (or
// after it comes back from an outage) has nothing to compare against and
// reports null rather than a made-up 0%.

const os = require('os')
const { execRemote } = require('./ssh')

// Fixed string, no interpolation. Both files are read in one call so the CPU and
// memory halves describe the same instant. `true` forces exit 0: ssh.js rejects a
// non-zero status, and cat fails on a host with no /proc, which is not our error.
const HOST_STAT_CMD = 'cat /proc/stat /proc/meminfo 2>/dev/null; true'

// --- CPU ---------------------------------------------------------------------

// Cumulative busy/total across all cores. Node reports the same jiffy counters
// /proc/stat does, already summed per core.
function localCpuTimes() {
  const cpus = os.cpus()
  if (!cpus || cpus.length === 0) return null
  let idle = 0, total = 0
  for (const c of cpus) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { idle, total }
}

// The leading `cpu ` line of /proc/stat: user nice system idle iowait irq
// softirq steal guest guest_nice. iowait counts as idle, matching top and
// nvitop; every other column is busy. Trailing columns are summed blind so a
// kernel that adds one does not silently shrink the total.
function parseProcStat(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('cpu ')) continue
    const cols = line.trim().split(/\s+/).slice(1).map(Number)
    if (cols.length < 4 || cols.some(n => !isFinite(n))) return null
    let total = 0
    for (const n of cols) total += n
    return { idle: cols[3] + (cols[4] || 0), total }
  }
  return null
}

// Two cumulative samples -> a percentage. Null whenever the pair cannot describe
// a real interval: no previous sample, the same sample twice (a stalled poll), or
// a total that went backwards, which means the counters were reset under us --
// a reboot, or a host label pointed at a different machine.
function cpuPercentFrom(prev, cur) {
  if (!prev || !cur) return null
  const dTotal = cur.total - prev.total
  const dIdle = cur.idle - prev.idle
  if (dTotal <= 0 || dIdle < 0) return null
  const pct = 100 * (1 - dIdle / dTotal)
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10))
}

// --- Memory ------------------------------------------------------------------

// MemAvailable is the kernel's own estimate of what a new workload could claim,
// so used = total - available matches what free(1) and nvitop call used. It has
// been there since Linux 3.14; the older Free+Buffers+Cached sum is the fallback
// for anything more ancient, and is deliberately approximate.
function parseMeminfo(text) {
  const kb = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line)
    if (m) kb[m[1]] = Number(m[2])
  }
  const total = kb.MemTotal
  if (!total) return null
  const avail = kb.MemAvailable != null
    ? kb.MemAvailable
    : (kb.MemFree || 0) + (kb.Buffers || 0) + (kb.Cached || 0)
  const used = Math.max(0, total - avail)
  return { memUsedKb: used, memTotalKb: total }
}

function memPct(memUsedKb, memTotalKb) {
  if (!memTotalKb) return null
  return Math.round((memUsedKb / memTotalKb) * 1000) / 10
}

// --- Sampling ----------------------------------------------------------------

function shape(cpuPct, mem) {
  if (!mem) return null
  return {
    cpuPct,
    memUsedKb: mem.memUsedKb,
    memTotalKb: mem.memTotalKb,
    memPct: memPct(mem.memUsedKb, mem.memTotalKb),
  }
}

// os.freemem() is not MemFree and not quite MemAvailable either: on Windows it
// is available physical memory, on Linux it is MemFree. So a Linux box polled
// locally reads slightly fuller than the same box polled over SSH, where
// MemAvailable counts reclaimable cache as free. Both are honest answers to
// "how much is in use"; they are just not the same question, and no local API
// exposes the remote one. Compare a host against itself, not against another.
function sampleLocal(state) {
  const cur = localCpuTimes()
  const cpuPct = cpuPercentFrom(state.prevCpu, cur)
  if (cur) state.prevCpu = cur

  const total = os.totalmem()
  const free = os.freemem()
  if (!total) return shape(cpuPct, null)
  const mem = { memUsedKb: Math.round((total - free) / 1024), memTotalKb: Math.round(total / 1024) }
  return shape(cpuPct, mem)
}

function parseRemote(out, state) {
  const cur = parseProcStat(out)
  const cpuPct = cpuPercentFrom(state.prevCpu, cur)
  // Only advance the baseline on a sample we could actually read, or one
  // unparseable tick would be charged to the next good one as a spike.
  if (cur) state.prevCpu = cur
  else state.prevCpu = null
  return shape(cpuPct, parseMeminfo(out))
}

async function sampleRemote(hostEntry, state) {
  const out = await execRemote(hostEntry, HOST_STAT_CMD)
  return parseRemote(out, state)
}

// Never rejects: host stats are a nice-to-have beside the GPU cards, and a
// non-Linux or unreachable host must not turn a working GPU poll into an error.
// A failed sample drops the CPU baseline so the tick after a recovery is not
// charged for the whole outage.
async function sample(hostEntry, state) {
  try {
    return hostEntry.local ? sampleLocal(state) : await sampleRemote(hostEntry, state)
  } catch (_) {
    state.prevCpu = null
    return null
  }
}

module.exports = {
  sample, sampleLocal, parseRemote,
  parseProcStat, parseMeminfo, cpuPercentFrom, memPct,
  HOST_STAT_CMD,
}
