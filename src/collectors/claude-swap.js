// Claude-swap (cswap CLI) account usage collector. cswap may not be installed;
// this degrades gracefully and just reports ok: false in that case.
// Aliases are cswap's own (`cswap alias <num> <name>`) — no local override
// layer; account management (add/remove/alias/enable) goes through the real
// CLI via IPC handlers in main.js, not a shadow config file.

const { execFile } = require('child_process')

const POLL_MS = 45000

function runCswap(cb) {
  execFile('cmd.exe', ['/c', 'cswap', 'list', '--json'], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  }, cb)
}

function clampPct(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n))
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
      fiveHourPct: clampPct(a.usage && a.usage.fiveHour && a.usage.fiveHour.pct),
      sevenDayPct: clampPct(a.usage && a.usage.sevenDay && a.usage.sevenDay.pct),
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
          { number: 1, alias: 'bryan', active: true, disabled: false, fiveHourPct: 62, sevenDayPct: 41 },
          { number: 2, alias: 'dev', active: false, disabled: false, fiveHourPct: 97, sevenDayPct: 83 },
          { number: 3, alias: 'apikey', active: false, disabled: true, fiveHourPct: null, sevenDayPct: null },
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
      try {
        const parsed = parseSwap(stdout)
        onData({
          ok: true,
          ts: Date.now(),
          // TODO: detect a user-run `cswap auto` daemon; not wired up yet, always false.
          autoOn: false,
          autoSinceMin: null,
          accounts: parsed.accounts,
        })
      } catch (parseErr) {
        onData({ ok: false, ts: Date.now(), error: parseErr.message, accounts: [] })
      }
      running = false
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

module.exports = { startClaudeSwap, parseSwap }
