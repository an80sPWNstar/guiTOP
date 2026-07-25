// Claude OAuth usage collector — polls the Anthropic OAuth usage endpoint
// using the token from Claude's own credential store. Falls back to the
// claude.ai cookie session when no OAuth token exists.
// Any failure (missing file, non-200, bad JSON) retries on the next poll.

const fs = require('fs')
const path = require('path')
const os = require('os')

const POLL_MS = 5 * 60 * 1000
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CREDENTIAL_PATHS = [
  path.join(os.homedir(), '.claude', '.credentials.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', '.credentials.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Claude Code', '.credentials.json'),
  path.join(os.homedir(), 'AppData', 'Local', 'Claude', '.credentials.json'),
  path.join(os.homedir(), 'AppData', 'Local', 'Claude Code', '.credentials.json'),
]

function readToken() {
  for (const file of CREDENTIAL_PATHS) {
    try {
      const creds = JSON.parse(fs.readFileSync(file, 'utf8'))
      const token = creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken
      if (typeof token === 'string' && token.length) return token
    } catch { /* next path */ }
  }
  return null
}

function pct(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function parseDate(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function startClaudeUsageOAuth(onData) {
  let cache = null
  let timer = null
  let stopped = false
  let failCount = 0

  async function poll() {
    const token = readToken()
    if (!token) {
      cache = null
      failCount++
      onData({ ok: false, ts: Date.now(), error: 'no OAuth token found', missingToken: true })
      return
    }
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      const body = await res.json()
      if (stopped) return

      failCount = 0

      let fablePct = null, fableResetsAt = null, fableModel = null
      if (Array.isArray(body?.limits)) {
        const entry = body.limits.find(e => e.kind === 'weekly_scoped' && e?.scope?.model)
        if (entry) {
          fablePct = pct(entry.percent)
          fableResetsAt = parseDate(entry.resets_at)
          fableModel = typeof entry.scope.model.display_name === 'string'
            ? entry.scope.model.display_name : 'Fable'
        }
      }

      cache = {
        sessionPct: pct(body?.five_hour?.utilization),
        sessionResetsAt: parseDate(body?.five_hour?.resets_at),
        weekPct: pct(body?.seven_day?.utilization),
        weekResetsAt: parseDate(body?.seven_day?.resets_at),
        fablePct, fableResetsAt, fableModel,
      }

      onData({
        ok: true,
        ts: Date.now(),
        sessionPct: cache.sessionPct ?? 0,
        weekPct: cache.weekPct ?? 0,
        sessionResetAt: cache.sessionResetsAt,
        weekResetAt: cache.weekResetsAt,
        fable: cache.fablePct != null ? {
          name: cache.fableModel, pct: cache.fablePct, resetAt: cache.fableResetsAt,
        } : null,
        todayTokens: null,
        via: 'oauth',
      })
    } catch (err) {
      failCount++
      console.warn('[claude-usage-oauth] poll error:', err.message)
      onData({ ok: false, ts: Date.now(), error: err.message, missingToken: false })
    }
  }

  async function tick() {
    if (stopped) return
    await poll()
    if (!stopped) timer = setTimeout(tick, cache ? POLL_MS : 30 * 1000)
  }
  tick()

  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null },
    hasToken() { return !!readToken() },
    status() { return { tokenPresent: !!readToken(), lastOk: !!(cache), failCount } },
  }
}

module.exports = { startClaudeUsageOAuth }
