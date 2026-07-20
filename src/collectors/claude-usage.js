// Claude Code usage collector. Scans local transcript files (~/.claude/projects/**/*.jsonl)
// and aggregates token usage into session/week budgets for display.

const fs = require('fs')
const path = require('path')
const os = require('os')

const POLL_MS = 45000
const SCAN_WINDOW_MS = 8 * 24 * 3600000 // files older than this can't affect weekly/session metrics

const ROOT_DIR = path.join(os.homedir(), '.claude', 'projects')

// path -> { mtimeMs, size, entries }
const fileCache = new Map()

function walk(dir, cutoff, out) {
  let items
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      walk(full, cutoff, out)
    } else if (item.isFile() && item.name.endsWith('.jsonl')) {
      let st
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (st.mtimeMs >= cutoff) {
        out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size })
      }
    }
  }
}

function parseFile(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const entries = []
  const lines = text.split('\n')
  for (const line of lines) {
    if (!line) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!obj.message || !obj.message.usage || !obj.timestamp) continue
    const ts = Date.parse(obj.timestamp)
    if (!Number.isFinite(ts)) continue
    const usage = obj.message.usage
    const tokens = (usage.input_tokens || 0) +
      (usage.output_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0)
    const key = (obj.message.id || '') + ':' + (obj.requestId || '')
    entries.push({ ts, tokens, key })
  }
  return entries
}

function collectEntries() {
  const now = Date.now()
  const cutoff = now - SCAN_WINDOW_MS
  const files = []
  walk(ROOT_DIR, cutoff, files)

  const seenPaths = new Set()
  const all = []
  const seenKeys = new Set()

  for (const f of files) {
    seenPaths.add(f.path)
    const cached = fileCache.get(f.path)
    let entries
    if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) {
      entries = cached.entries
    } else {
      entries = parseFile(f.path)
      fileCache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, entries })
    }
    for (const e of entries) {
      if (e.key !== ':' && seenKeys.has(e.key)) continue
      if (e.key !== ':') seenKeys.add(e.key)
      all.push(e)
    }
  }

  for (const cachedPath of fileCache.keys()) {
    if (!seenPaths.has(cachedPath)) fileCache.delete(cachedPath)
  }

  return all
}

function aggregate(entries, now) {
  if (!entries || entries.length === 0) {
    return { sessionTokens: 0, sessionBudget: 1, resetMs: 0, weekTokens: 0, weekBudget: 1, todayTokens: 0 };
  }

  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const HOUR_MS = 3600000;
  const FIVE_HOURS_MS = 5 * HOUR_MS;
  const WEEK_MS = 7 * 24 * HOUR_MS;

  const blocks = [];
  let currentBlockStart = Math.floor(sorted[0].ts / HOUR_MS) * HOUR_MS;
  let currentTotal = 0;

  for (const entry of sorted) {
    if (entry.ts < currentBlockStart + FIVE_HOURS_MS) {
      currentTotal += entry.tokens;
    } else {
      blocks.push({ start: currentBlockStart, total: currentTotal });
      currentBlockStart = Math.floor(entry.ts / HOUR_MS) * HOUR_MS;
      currentTotal = entry.tokens;
    }
  }
  blocks.push({ start: currentBlockStart, total: currentTotal });

  const last = blocks[blocks.length - 1];
  let sessionTokens, resetMs;
  if (now < last.start + FIVE_HOURS_MS) {
    sessionTokens = last.total;
    resetMs = last.start + FIVE_HOURS_MS - now;
  } else {
    sessionTokens = 0;
    resetMs = 0;
  }

  const weekCutoff = now - WEEK_MS;
  let weekTokens = 0;
  for (const entry of sorted) {
    if (entry.ts >= weekCutoff) {
      weekTokens += entry.tokens;
    }
  }

  const nowDate = new Date(now);
  const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  let todayTokens = 0;
  for (const entry of sorted) {
    if (entry.ts >= todayStart) {
      todayTokens += entry.tokens;
    }
  }

  let sessionBudget = 1;
  for (const block of blocks) {
    if (block.total > sessionBudget) {
      sessionBudget = block.total;
    }
  }

  let weekBudget = 1;
  for (let i = 0; i < blocks.length; i++) {
    let windowSum = 0;
    const windowStart = blocks[i].start - WEEK_MS;
    for (let j = 0; j < blocks.length; j++) {
      if (blocks[j].start >= windowStart && blocks[j].start <= blocks[i].start) {
        windowSum += blocks[j].total;
      }
    }
    if (windowSum > weekBudget) {
      weekBudget = windowSum;
    }
  }

  return { sessionTokens, sessionBudget, resetMs, weekTokens, weekBudget, todayTokens };
}

function startClaudeUsage(onData) {
  let firstTimer = null
  let interval = null

  function tick() {
    const now = Date.now()
    try {
      const entries = collectEntries()
      const agg = aggregate(entries, now)
      onData({
        ok: true,
        ts: now,
        sessionPct: Math.min(100, Math.round(agg.sessionTokens / agg.sessionBudget * 100)),
        weekPct: Math.min(100, Math.round(agg.weekTokens / agg.weekBudget * 100)),
        resetMs: agg.resetMs,
        todayTokens: agg.todayTokens,
      })
    } catch (err) {
      onData({ ok: false, ts: Date.now(), error: err.message })
    }
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

module.exports = { startClaudeUsage, aggregate }
