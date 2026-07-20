// Claude usage collector. Polls cswap list --json for the active account's
// usage percentages — matches what claude.ai/account shows online.

const { execFile } = require('child_process')

const POLL_MS = 45000

function runCswap(cb) {
  execFile('cmd.exe', ['/c', 'cswap', 'list', '--json'], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  }, cb)
}

function findActive(accounts) {
  if (!accounts || accounts.length === 0) return null
  for (const a of accounts) {
    if (a.active) return a
  }
  return accounts[0]
}

function parseResetsMs(resetsAt) {
  if (!resetsAt) return null
  const ts = Date.parse(resetsAt)
  if (!Number.isFinite(ts)) return null
  return Math.max(0, ts - Date.now())
}

function parseUsage(stdout) {
  const data = JSON.parse(stdout)
  const acct = findActive(data.accounts)
  if (!acct || !acct.usage) {
    return { sessionPct: 0, weekPct: 0, resetMs: null, todayTokens: null }
  }
  return {
    sessionPct: Math.round((acct.usage.fiveHour && acct.usage.fiveHour.pct) || 0),
    weekPct: Math.round((acct.usage.sevenDay && acct.usage.sevenDay.pct) || 0),
    resetMs: parseResetsMs(acct.usage.fiveHour && acct.usage.fiveHour.resetsAt),
    todayTokens: null,
  }
}

function startClaudeUsage(onData) {
  let firstTimer = null
  let interval = null
  let running = false

  function tick() {
    if (running) return
    running = true

    runCswap((err, stdout) => {
      if (err) {
        onData({ ok: false, ts: Date.now(), error: err.message })
        running = false
        return
      }
      try {
        const usage = parseUsage(stdout)
        onData({
          ok: true,
          ts: Date.now(),
          sessionPct: usage.sessionPct,
          weekPct: usage.weekPct,
          resetMs: usage.resetMs,
          todayTokens: usage.todayTokens,
        })
      } catch (parseErr) {
        onData({ ok: false, ts: Date.now(), error: parseErr.message })
        running = false
        return
      }
      running = false
    })
  }

  // Defer first tick so the caller has the handle before onData fires.
  firstTimer = setTimeout(tick, 1500)
  interval = setInterval(tick, POLL_MS)

  return {
    stop() {
      clearTimeout(firstTimer)
      clearInterval(interval)
    },
  }
}

module.exports = { startClaudeUsage, parseUsage }
