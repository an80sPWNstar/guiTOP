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

const fs = require('fs')
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

// The two sources count in different units -- /proc/stat in jiffies, os.cpus() in
// milliseconds -- so a delta taken across a switch between them is meaningless.
// Tag the baseline with where it came from and drop it when that changes.
function baseline(state, src, cur) {
  const prev = state.prevSrc === src ? state.prevCpu : null
  const pct = cpuPercentFrom(prev, cur)
  if (cur) {
    state.prevCpu = cur
    state.prevSrc = src
  }
  return pct
}

// Linux exposes the same two files locally that the SSH path reads remotely, so
// read them directly and a Linux box reports identically either way.
//
// Memory is NOT the reason. Measured on Node 18: os.freemem() on Linux returns
// MemAvailable exactly (27699256 kB against /proc/meminfo's 27699256), so the
// two agreed already. But that is a libuv implementation choice, not a documented
// guarantee, and it differs per platform -- which is precisely the kind of thing
// that changes under a runtime upgrade without anyone noticing.
//
// CPU is the reason that bites today: os.cpus() reports user, nice, sys, idle and
// irq, with no iowait and no steal column at all. /proc/stat has both, and this
// collector counts iowait as idle the way top and nvitop do. So a box waiting on
// disk reads busier through os.cpus() than through /proc/stat -- the iowait
// jiffies are missing from the total rather than counted as idle -- and a VM
// losing time to its hypervisor reads busier still.
//
// Returns undefined -- not null -- when the files cannot be read, since null is a
// real answer here meaning "no reading available".
function sampleLinuxLocal(state) {
  let statText, memText
  try {
    statText = fs.readFileSync('/proc/stat', 'utf8')
    memText = fs.readFileSync('/proc/meminfo', 'utf8')
  } catch (_) {
    return undefined
  }

  const cpu = parseProcStat(statText)
  const mem = parseMeminfo(memText)
  if (!cpu || !mem) return undefined

  return shape(baseline(state, 'proc', cpu), mem)
}

// The portable path. On Windows os.freemem() is available physical memory, the
// same quantity Task Manager subtracts to show "In use", so used = total - free
// is the number a Windows user expects; this is verified against Task Manager.
// macOS is the open question -- libuv reports free pages there, which excludes
// inactive and purgeable memory and would read fuller than Activity Monitor
// shows, but there is no Mac here to confirm it on and no mac build target yet.
// Linux only reaches this path if /proc is unreadable.
function sampleLocal(state) {
  if (process.platform === 'linux') {
    const viaProc = sampleLinuxLocal(state)
    if (viaProc !== undefined) return viaProc
  }

  const cpuPct = baseline(state, 'os', localCpuTimes())

  const total = os.totalmem()
  const free = os.freemem()
  if (!total) return shape(cpuPct, null)
  const mem = { memUsedKb: Math.round((total - free) / 1024), memTotalKb: Math.round(total / 1024) }
  return shape(cpuPct, mem)
}

function parseRemote(out, state) {
  const cur = parseProcStat(out)
  const cpuPct = baseline(state, 'proc', cur)
  // Only advance the baseline on a sample we could actually read, or one
  // unparseable tick would be charged to the next good one as a spike.
  if (!cur) state.prevCpu = null
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

// baseline is exported for tests only.
module.exports = {
  sample, sampleLocal, parseRemote,
  parseProcStat, parseMeminfo, cpuPercentFrom, memPct, baseline,
  HOST_STAT_CMD,
}
