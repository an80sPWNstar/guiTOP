// Two long-lived nvidia-smi children instead of two spawns per second.
//
// The local host poll called execFile('nvidia-smi', ...) twice every 1000ms.
// On Windows each console child also allocates a conhost.exe, so a steady
// four process creations a second were attributed to guiTOP. nvidia-smi has a
// built-in loop mode (-l SECONDS) that repeats the same query forever on one
// process, so the parade collapses to two children for the life of the app.
//
// FRAMING: `-l` prints the CSV header once, not per iteration, so there is no
// delimiter between samples. `timestamp` is a valid query field on both
// --query-gpu and --query-compute-apps, and every row of a single iteration
// carries the same value (verified on a 3-GPU box), while consecutive
// iterations never share one. So: prepend timestamp, group consecutive lines
// that share it, and a line with a new timestamp means the previous group is
// complete. The timestamp is stripped again before the CSV is handed on, so
// what parse.js receives is byte-identical to the one-shot output.
//
// SECURITY: the argument arrays are fixed and hard-coded, passed to spawn
// without a shell. Nothing dynamic is interpolated.

const { spawn } = require('child_process')
const readline = require('readline')

const RESPAWN_MS = 5000

// A group is also flushed on a short silence, so a sample does not wait for
// the next iteration to be published.
const IDLE_FLUSH_MS = 400

// An iteration with no rows at all emits nothing, which is indistinguishable
// from a stalled child. Treat a proc sample older than this as "no compute
// processes" rather than serving a stale list forever.
const STALE_MS = 4000

// Rows of one iteration do NOT all carry the same timestamp. Measured on a
// 3-GPU box, a 22-row --query-compute-apps iteration arrives as 21 rows at
// .298 and the last row at .302: nvidia-smi re-stamps as it walks the devices.
// Equality was therefore the wrong test -- it published a 21-row sample and
// then a 1-row one, and the process table showed whichever landed last. Rows
// belong to the same iteration while their timestamps are within this window,
// which sits far above the few ms an iteration spans and far below the 1s
// between them. Comparing the timestamps rather than our own read times is
// what keeps a stalled event loop from splitting a sample.
const SAME_SAMPLE_MS = 500

// One stream = one long-lived nvidia-smi running one repeating query.
// kind is 'gpu' or 'proc' (used only for bookkeeping).
function createStream(kind, args) {
  const stream = {
    kind,
    args,
    csv: null,      // last complete sample, timestamp column stripped
    at: 0,          // Date.now() when that sample completed
    child: null,
    rl: null,
    pending: [],    // rows of the group being accumulated
    stamp: null,    // timestamp of the most recent row
    stampMs: null,  // first timestamp of the group, in ms, for the window test
    idleTimer: null,
    respawnTimer: null,
    stopped: false,
  }
  return stream
}

// Split "2026/07/31 10:19:33.818, 0, GPU-..." into its timestamp and the rest.
// Returns null for a line that carries no comma (a warning, or the header).
function splitStamped(line) {
  const idx = line.indexOf(',')
  if (idx === -1) return null
  return {
    stamp: line.slice(0, idx).trim(),
    rest: line.slice(idx + 1).trim()
  }
}

// "2026/07/31 10:38:58.298" -> ms. Not an ISO string, so it is parsed by hand
// rather than trusting Date to guess. Only differences are ever taken, so the
// zone this pretends to be in does not matter. Returns null if it does not
// match, which leaves the idle flush as the only boundary.
const STAMP_RE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/

function parseStamp(stamp) {
  const m = STAMP_RE.exec(stamp)
  if (!m) return null
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7])
}

// Publish the accumulated group as one CSV text and start a fresh group.
function flush(stream) {
  if (stream.pending.length === 0) {
    if (stream.idleTimer) {
      clearTimeout(stream.idleTimer)
      stream.idleTimer = null
    }
    return
  }
  stream.csv = stream.pending.join('\n')
  stream.at = Date.now()
  stream.pending = []
  stream.stamp = null
  stream.stampMs = null
  if (stream.idleTimer) {
    clearTimeout(stream.idleTimer)
    stream.idleTimer = null
  }
}

function armIdleFlush(stream) {
  if (stream.idleTimer) {
    clearTimeout(stream.idleTimer)
  }
  stream.idleTimer = setTimeout(() => {
    flush(stream)
  }, IDLE_FLUSH_MS)
  stream.idleTimer.unref()
}

function onLine(stream, line) {
  if (!line.trim()) return
  const parsed = splitStamped(line)
  if (!parsed) return

  // A row far enough past the start of the group belongs to the next iteration.
  const ms = parseStamp(parsed.stamp)
  if (stream.pending.length > 0 && ms !== null && stream.stampMs !== null &&
      ms - stream.stampMs >= SAME_SAMPLE_MS) {
    flush(stream)
  }

  if (stream.pending.length === 0) stream.stampMs = ms
  stream.stamp = parsed.stamp
  stream.pending.push(parsed.rest)
  armIdleFlush(stream)
}

function startStream(stream) {
  if (stream.stopped || stream.child) return

  stream.child = spawn('nvidia-smi', stream.args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })

  stream.rl = readline.createInterface({
    input: stream.child.stdout,
    crlfDelay: Infinity
  })

  stream.rl.on('line', (line) => {
    try {
      onLine(stream, line)
    } catch (e) {
      // swallow errors in sampling paths
    }
  })

  const cleanup = () => {
    stream.child = null
    stream.pending = []
    stream.stamp = null
    stream.stampMs = null
    scheduleRespawn(stream)
  }

  stream.child.on('exit', cleanup)
  stream.child.on('error', cleanup)
}

function scheduleRespawn(stream) {
  if (stream.stopped || stream.respawnTimer) return

  stream.respawnTimer = setTimeout(() => {
    stream.respawnTimer = null
    startStream(stream)
  }, RESPAWN_MS)
  stream.respawnTimer.unref()
}

function stopStream(stream) {
  stream.stopped = true

  if (stream.idleTimer) {
    clearTimeout(stream.idleTimer)
    stream.idleTimer = null
  }

  if (stream.respawnTimer) {
    clearTimeout(stream.respawnTimer)
    stream.respawnTimer = null
  }

  if (stream.rl) {
    stream.rl.close()
    stream.rl = null
  }

  if (stream.child) {
    stream.child.kill()
    stream.child = null
  }
}

// The caller owns the query arguments (nvidia-smi.js builds them), so this
// layer never imports them -- that would be a require cycle.

let gpuStream = null
let procStream = null
let stopped = false

// Start the two children if they are not already running. Safe to call on
// every poll tick. Returns nothing.
function ensure(gpuArgs, procArgs) {
  if (stopped) return
  if (gpuStream === null) {
    gpuStream = createStream('gpu', gpuArgs)
    startStream(gpuStream)
  }
  if (procStream === null) {
    procStream = createStream('proc', procArgs)
    startStream(procStream)
  }
}

// The freshest complete pair, or null when the streams cannot serve this tick
// and the caller should fall back to a one-shot query.
function latest() {
  if (gpuStream === null || gpuStream.csv === null || Date.now() - gpuStream.at > STALE_MS) {
    return null
  }
  let procCsv = ''
  if (procStream !== null && procStream.csv !== null && Date.now() - procStream.at <= STALE_MS) {
    procCsv = procStream.csv
  }
  return { gpuCsv: gpuStream.csv, procCsv }
}

function stop() {
  stopped = true
  if (gpuStream) stopStream(gpuStream)
  if (procStream) stopStream(procStream)
  gpuStream = null
  procStream = null
}

// Unlike the PowerShell host, whose script polls for its parent and exits, an
// `nvidia-smi -l 1` child has no such check: orphaned, it would keep querying
// the driver every second forever. Killing it on exit is what prevents that.
// A hard kill of the app skips this, and the child is then left to notice its
// stdout pipe has closed on its next write.
process.on('exit', stop)

module.exports = { createStream, splitStamped, parseStamp, flush, armIdleFlush, onLine, startStream, scheduleRespawn, stopStream, ensure, latest, stop, RESPAWN_MS, IDLE_FLUSH_MS, STALE_MS, SAME_SAMPLE_MS }
