// Streaming remote sampler: ONE ssh channel per host running a shell loop that
// prints every requested command's output, framed by nonce-tagged markers, every
// LOOP_SECONDS. A poll tick reads the latest framed sample instead of opening a
// channel, so steady state is one login and one channel for the life of the app.
//
// Why a lock on the remote: a command stuck in an unkillable D-state (a hung GPU
// driver) keeps fd 9 open, so a restarted loop says BUSY and exits instead of
// spawning a second stuck process beside the first. `sleep` closes fd 9 so an
// ordinary restart is not blocked by a predecessor that is only sleeping.

const crypto = require('crypto')
const os = require('os')

const LOOP_SECONDS = 2
const STALE_MS = 10000
const WAIT_MS = 4000
const STALL_MS = 15000
const STALL_CHECK_MS = 5000
const RESTART_DEBOUNCE_MS = 200
const IDLE_DROP_MS = 30000
const RESTART_MIN_MS = 2000
const RESTART_MAX_MS = 300000
const BUSY_RETRY_MS = 3000
const BUSY_QUICK_RETRIES = 2

function defaultLockId() {
  return crypto.createHash('sha256')
    .update(os.hostname() + ':' + os.userInfo().username)
    .digest('hex').slice(0, 12)
}

function defaultDeps() {
  return {
    openStream: (...args) => require('./ssh').openStream(...args),
    now: () => Date.now(),
    setTimeout, clearTimeout, setInterval, clearInterval,
    nonce: () => crypto.randomBytes(6).toString('hex'),
    lockId: defaultLockId(),
  }
}

function poolKey({ host, port = 22, username }) { return `${username}@${host}:${port}` }

// entries: table entries with stream:true. nonce and lockId are hex only, so
// interpolating them into the script cannot change its meaning.
function buildScript(entries, nonce, lockId) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const lines = [
    `L="/tmp/guitop-${lockId}-$(id -u).lock"`,
    'if command -v flock >/dev/null 2>&1; then exec 9>"$L"; flock -n 9 || { echo "@@' + nonce + ' BUSY"; exit 75; }; fi',
    'while :; do',
    `echo "@@${nonce} B"`,
  ]
  for (const entry of sorted) {
    lines.push(`echo "@@${nonce} S ${entry.name}"; ( ${entry.cmd} ) </dev/null 2>/dev/null; printf '\\n@@${nonce} E ${entry.name} %d\\n' $?`)
  }
  lines.push(`echo "@@${nonce} Z"`)
  lines.push(`sleep ${LOOP_SECONDS} 9>&-`)
  lines.push('done')
  return lines.join('\n')
}

// Returns null for an ordinary output line, else {t:'B'} | {t:'Z'} | {t:'BUSY'} |
// {t:'S', name} | {t:'E', name, code}.
function parseMarker(line, nonce) {
  const prefix = `@@${nonce} `
  if (!line.startsWith(prefix)) return null
  const rest = line.slice(prefix.length)
  if (rest === 'B') return { t: 'B' }
  if (rest === 'Z') return { t: 'Z' }
  if (rest === 'BUSY') return { t: 'BUSY' }
  const sp = rest.indexOf(' ')
  if (sp === -1) return null
  const tag = rest.slice(0, sp)
  const arg = rest.slice(sp + 1)
  if (tag === 'S') return { t: 'S', name: arg }
  if (tag === 'E') {
    const sp2 = arg.lastIndexOf(' ')
    if (sp2 === -1) return null
    const name = arg.slice(0, sp2)
    const code = parseInt(arg.slice(sp2 + 1), 10)
    if (isNaN(code)) return null
    return { t: 'E', name, code }
  }
  return null
}

function createSampler(hostConfig, deps = defaultDeps()) {
  const label = hostConfig.label || hostConfig.host
  const wanted = new Map()        // name -> table entry
  const lastRequested = new Map() // name -> ms
  const results = new Map()       // name -> { code, out, at }
  let running = []                // names in the channel that is open now
  let waiters = []                // { name, resolve, reject, timer }

  let channel = null              // { close() } from openStream
  let opening = false
  let partial = null              // Map name -> { code, out } for the iteration in progress
  let capture = null              // { name, lines: [] } while between S and E
  let lastMarker = null
  let lastLineAt = 0
  let lastCommitAt = 0
  let restartDelay = RESTART_MIN_MS
  let restartTimer = null
  let restartAt = 0
  let debounceTimer = null
  let stallTimer = null
  let stuck = false
  let stopped = false
  let lastError = null
  let busyCount = 0
  const counters = { iterations: 0, restarts: 0, stalls: 0, busy: 0 }

  function settleFrom(r, resolve, reject) {
    if (r.code === 0) resolve(r.out)
    else reject(new Error('Command exited ' + r.code))
  }

  function waitMessage() {
    const now = deps.now()
    if (stuck) return `remote sampler on ${label} is stuck: a previous sample never finished (GPU driver hung?)`
    if (restartTimer) {
      const secs = Math.ceil((restartAt - now) / 1000)
      return `stream to ${label} restarting in ${secs}s: ${lastError || 'unknown error'}`
    }
    return `no sample from ${label} stream in 4s`
  }

  function commit() {
    const now = deps.now()
    for (const [name, r] of partial) {
      results.set(name, { code: r.code, out: r.out, at: now })
    }
    counters.iterations++
    lastCommitAt = now
    restartDelay = RESTART_MIN_MS
    stuck = false
    busyCount = 0

    const nextWaiters = []
    for (const waiter of waiters) {
      if (partial.has(waiter.name)) {
        deps.clearTimeout(waiter.timer)
        settleFrom(partial.get(waiter.name), waiter.resolve, waiter.reject)
      } else {
        nextWaiters.push(waiter)
      }
    }
    waiters = nextWaiters
  }

  function onLine(line) {
    lastLineAt = deps.now()
    const m = parseMarker(line, nonce)
    if (m) {
      lastMarker = m.t
      if (m.t === 'B') {
        partial = new Map()
        capture = null
      } else if (m.t === 'S') {
        capture = { name: m.name, lines: [] }
      } else if (m.t === 'E') {
        if (capture && capture.name === m.name) {
          let lines = capture.lines
          if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines = lines.slice(0, -1)
          }
          const out = lines.length > 0 ? lines.join('\n') + '\n' : ''
          partial.set(m.name, { code: m.code, out })
        }
        capture = null
      } else if (m.t === 'Z') {
        if (partial) commit()
        partial = null
      } else if (m.t === 'BUSY') {
        counters.busy++
      }
    } else {
      if (capture) {
        capture.lines.push(line)
      }
    }
  }

  let nonce = null
  // Bumped whenever a channel is closed or opened. Each channel's callbacks carry
  // the generation they were opened with, so lines or a close event still in
  // flight from a channel we already replaced can never touch the new one.
  let generation = 0

  function clearStallTimer() {
    if (stallTimer) { deps.clearInterval(stallTimer); stallTimer = null }
  }

  function closeChannel() {
    if (channel) {
      generation++
      channel.close()
      channel = null
    }
    clearStallTimer()
    partial = null
    capture = null
  }

  function scheduleRestart(delayMs) {
    if (stopped) return
    if (restartTimer) deps.clearTimeout(restartTimer)
    const now = deps.now()
    restartAt = now + delayMs
    restartTimer = deps.setTimeout(() => { restartTimer = null; restart() }, delayMs)
  }

  function backoff() {
    scheduleRestart(restartDelay)
    restartDelay = Math.min(RESTART_MAX_MS, restartDelay * 2)
  }

  function onClose(code, err) {
    channel = null
    clearStallTimer()
    if (stopped) return
    if (lastMarker === 'BUSY') {
      busyCount++
      if (busyCount <= BUSY_QUICK_RETRIES) {
        scheduleRestart(BUSY_RETRY_MS)
      } else {
        stuck = true
        lastError = 'remote sampler still running from a previous stream'
        backoff()
      }
    } else {
      lastError = err ? err.message : `stream exited ${code}`
      backoff()
    }
  }

  function checkStall() {
    if (channel && deps.now() - lastLineAt > STALL_MS) {
      counters.stalls++
      stuck = true
      lastError = `no output for ${STALL_MS / 1000}s`
      closeChannel()
      backoff()
    }
  }

  async function restart() {
    if (stopped || opening) return
    const now = deps.now()
    const idle = []
    for (const [name, t] of lastRequested) {
      if (now - t > IDLE_DROP_MS) {
        idle.push(name)
      }
    }
    for (const name of idle) {
      wanted.delete(name)
      lastRequested.delete(name)
    }
    closeChannel()
    if (wanted.size === 0) return
    counters.restarts++
    opening = true
    nonce = deps.nonce()
    running = Array.from(wanted.keys()).sort()
    lastMarker = null
    lastLineAt = deps.now()
    const gen = ++generation
    const handlers = {
      onLine: (l) => { if (gen === generation) onLine(l) },
      onClose: (code, err) => { if (gen === generation) onClose(code, err) },
    }
    try {
      const entries = Array.from(wanted.values())
      channel = await deps.openStream(hostConfig, buildScript(entries, nonce, deps.lockId), handlers)
    } catch (err) {
      lastError = err.message
      opening = false
      backoff()
      return
    }
    opening = false
    if (stopped) {
      closeChannel()
      return
    }
    stallTimer = deps.setInterval(checkStall, STALL_CHECK_MS)
  }

  function requestRestart() {
    if (debounceTimer) return
    debounceTimer = deps.setTimeout(() => {
      debounceTimer = null
      if (!restartTimer) restart()
    }, RESTART_DEBOUNCE_MS)
  }

  function exec(entry) {
    if (stopped) return Promise.reject(new Error('stopped'))
    const now = deps.now()
    lastRequested.set(entry.name, now)
    const name = entry.name
    if (!wanted.has(name)) {
      wanted.set(name, entry)
      requestRestart()
    } else {
      let anyIdle = false
      for (const n of wanted.keys()) {
        const t = lastRequested.get(n)
        if (t && now - t > IDLE_DROP_MS) {
          anyIdle = true
          break
        }
      }
      // A name added while a channel was opening is wanted but not running, and
      // restart() refuses to run mid-open -- ask again so it is not left out forever.
      if (anyIdle || (!running.includes(name) && !opening && !restartTimer)) requestRestart()
    }
    if (results.has(name)) {
      const r = results.get(name)
      if (now - r.at <= STALE_MS && running.includes(name)) {
        return new Promise((resolve, reject) => {
          settleFrom(r, resolve, reject)
        })
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = { name, resolve, reject, timer: null }
      const timer = deps.setTimeout(() => {
        const idx = waiters.indexOf(waiter)
        if (idx !== -1) waiters.splice(idx, 1)
        reject(new Error(waitMessage()))
      }, WAIT_MS)
      waiter.timer = timer
      waiters.push(waiter)
    })
  }

  function stop() {
    stopped = true
    closeChannel()
    if (restartTimer) {
      deps.clearTimeout(restartTimer)
      restartTimer = null
    }
    if (debounceTimer) {
      deps.clearTimeout(debounceTimer)
      debounceTimer = null
    }
    for (const waiter of waiters) {
      deps.clearTimeout(waiter.timer)
      waiter.reject(new Error('stopped'))
    }
    waiters = []
  }

  function stats() {
    const now = deps.now()
    let state = 'starting'
    if (stopped) state = 'stopped'
    else if (stuck) state = 'stuck'
    else if (restartTimer) state = 'backoff'
    else if (channel && lastCommitAt) state = 'streaming'
    return {
      state,
      names: running,
      iterations: counters.iterations,
      restarts: counters.restarts,
      stalls: counters.stalls,
      busy: counters.busy,
      lastIterationAgeMs: lastCommitAt ? now - lastCommitAt : null,
      restartInMs: restartTimer ? Math.max(0, restartAt - now) : null,
      lastError,
    }
  }

  return { exec, stop, stats, _onLine: (l) => onLine(l) }
}

const samplers = new Map()

function exec(hostConfig, entry) {
  const key = poolKey(hostConfig)
  let s = samplers.get(key)
  if (!s) { s = createSampler(hostConfig); samplers.set(key, s) }
  return s.exec(entry)
}

function closeHost(hostConfig) {
  const key = poolKey(hostConfig)
  const s = samplers.get(key)
  if (s) { s.stop(); samplers.delete(key) }
}

function closeAll() {
  for (const s of samplers.values()) s.stop()
  samplers.clear()
}

function stats() {
  const out = {}
  for (const [key, s] of samplers) out[key] = s.stats()
  return out
}

module.exports = {
  exec, closeHost, closeAll, stats, buildScript, parseMarker, createSampler,
  LOOP_SECONDS, STALE_MS, WAIT_MS, STALL_MS, STALL_CHECK_MS, RESTART_DEBOUNCE_MS, IDLE_DROP_MS,
  RESTART_MIN_MS, RESTART_MAX_MS, BUSY_RETRY_MS, BUSY_QUICK_RETRIES,
}
