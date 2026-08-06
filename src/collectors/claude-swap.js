// Claude-swap (cswap CLI) account usage collector. cswap may not be installed;
// this degrades gracefully and just reports ok: false in that case.
// Aliases are cswap's own (`cswap alias <num> <name>`) — no local override
// layer; account management (add/remove/alias/enable) goes through the real
// CLI via IPC handlers in main.js, not a shadow config file.

const { execFile } = require('child_process')
const { cswapCmd } = require('./cswap-cmd')

const POLL_MS = 45000

// `cswap auto` is a foreground polling loop — no daemon, no pidfile, nothing on
// disk to check — so the only way to know it is running is to look for the
// process. uv-installed tools run under python.exe with the shim path in their
// command line, so the command line is what gets matched, never the name.
const PS_PROC_QUERY = 'Get-CimInstance Win32_Process -Filter "Name=\'python.exe\' OR Name=\'pythonw.exe\' OR Name=\'cswap.exe\'" | Select-Object ProcessId, CommandLine, CreationDate | ConvertTo-Json'

function runCswap(cb) {
  const { file, args } = cswapCmd(['list', '--json'])
  execFile(file, args, {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  }, cb)
}

// Windows PowerShell 5.1 serialises a DateTime as "/Date(1769...)/" while
// PowerShell 7 emits ISO 8601, and which one answers depends on the machine.
function parsePsDate(val) {
  if (typeof val !== 'string') return null
  // The epoch form sometimes carries a trailing timezone offset: /Date(ms+0100)/.
  const epoch = val.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//)
  const ms = epoch ? Number(epoch[1]) : Date.parse(val)
  return Number.isFinite(ms) ? ms : null
}

function isAutoCmdline(cmdline) {
  if (typeof cmdline !== 'string') return false
  if (!/cswap/i.test(cmdline)) return false
  // The subcommand is a bare argument: `"...\cswap.exe" auto --interval 60`.
  // Matching a loose /auto/ would also hit any directory called "auto".
  return /\sauto(\s|$)/.test(cmdline)
}

function readAuto(rows, now) {
  for (const row of rows) {
    if (!row || !isAutoCmdline(row.CommandLine)) continue
    const started = parsePsDate(row.CreationDate)
    return {
      autoOn: true,
      autoSinceMin: started === null ? null : Math.max(0, Math.floor((now - started) / 60000)),
    }
  }
  return { autoOn: false, autoSinceMin: null }
}

// Never reports an error: a detection that cannot run just means "not detected".
function detectAuto(cb) {
  const none = { autoOn: false, autoSinceMin: null }

  if (process.platform === 'win32') {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PROC_QUERY], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) return cb(none)
      let parsed
      try { parsed = JSON.parse(stdout) } catch { return cb(none) }
      // ConvertTo-Json emits a bare object, not an array, for a single match.
      cb(readAuto(Array.isArray(parsed) ? parsed : [parsed], Date.now()))
    })
    return
  }

  // pgrep reports no start time, so autoSinceMin stays null off Windows.
  execFile('pgrep', ['-af', 'cswap'], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err) return cb(none)
    const rows = String(stdout).split('\n')
      .filter(l => l.trim() && !l.includes('pgrep'))
      .map(l => ({ CommandLine: l }))
    cb(readAuto(rows, Date.now()))
  })
}

function clampPct(v) {
  // Guard null/undefined/'' explicitly: Number(null) and Number('') are both 0,
  // which is finite, so a missing usage value would otherwise read as a real 0%.
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n))
}

// cswap emits resetsAt as an ISO 8601 string; the strip wants absolute epoch ms
// so it can tick a live countdown between polls. Non-strings / bad dates -> null.
function isoMs(v) {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

function accountAlias(a) {
  return String(a.alias || String(a.email || '').split('@')[0] || ('ACC' + a.number)).slice(0, 24)
}

function parseSwap(stdout) {
  const data = JSON.parse(stdout)
  return {
    activeNumber: data.activeAccountNumber ?? null,
    accounts: (data.accounts || []).map(a => ({
      number: Number(a.number) || 0,
      alias: accountAlias(a),
      active: !!a.active,
      disabled: !!a.disabled,
      // cswap reports 'ok' only when it actually fetched usage; anything else
      // (e.g. 'unavailable' after a 403/429 on the usage endpoint) leaves the
      // pcts null. Carry it through so the strip can show "no data" rather than
      // an empty bar that reads as 0%.
      usageStatus: String(a.usageStatus || (a.usage ? 'ok' : 'unavailable')),
      fiveHourPct: clampPct(a.usage && a.usage.fiveHour && a.usage.fiveHour.pct),
      sevenDayPct: clampPct(a.usage && a.usage.sevenDay && a.usage.sevenDay.pct),
      fiveHourResetMs: isoMs(a.usage && a.usage.fiveHour && a.usage.fiveHour.resetsAt),
      sevenDayResetMs: isoMs(a.usage && a.usage.sevenDay && a.usage.sevenDay.resetsAt),
    })),
  }
}

function startClaudeSwap(onData) {
  let firstTimer = null
  let interval = null
  let running = false

  function tick() {
    if (running) return
    running = true

    if (process.env.GUITOP_SWAP_MOCK === '1') {
      onData({
        ok: true,
        ts: Date.now(),
        autoOn: true,
        autoSinceMin: 23,
        accounts: [
          { number: 1, alias: 'bryan', active: true, disabled: false, usageStatus: 'ok', fiveHourPct: 62, sevenDayPct: 41 },
          { number: 2, alias: 'dev', active: false, disabled: false, usageStatus: 'ok', fiveHourPct: 97, sevenDayPct: 83 },
          { number: 3, alias: 'apikey', active: false, disabled: true, usageStatus: 'unavailable', fiveHourPct: null, sevenDayPct: null },
        ],
      })
      running = false
      return
    }

    runCswap((err, stdout) => {
      if (err) {
        onData({ ok: false, ts: Date.now(), error: err.message, accounts: [] })
        running = false
        return
      }
      let parsed
      try {
        parsed = parseSwap(stdout)
      } catch (parseErr) {
        onData({ ok: false, ts: Date.now(), error: parseErr.message, accounts: [] })
        running = false
        return
      }
      detectAuto((auto) => {
        onData({
          ok: true,
          ts: Date.now(),
          autoOn: auto.autoOn,
          autoSinceMin: auto.autoSinceMin,
          accounts: parsed.accounts,
        })
        running = false
      })
    })
  }

  // Defer first tick so the caller has the handle before onData fires.
  firstTimer = setTimeout(tick, 2000)
  interval = setInterval(tick, POLL_MS)

  return {
    refresh() { tick() },
    stop() {
      clearTimeout(firstTimer)
      clearInterval(interval)
    },
  }
}

module.exports = { startClaudeSwap, parseSwap, parsePsDate, isoMs, isAutoCmdline, readAuto, detectAuto }
