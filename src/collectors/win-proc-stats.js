const psHost = require('./win-ps-host');

let latest = {};
let prev = {};
let started = false;

function accept(data) {
  const rows = Array.isArray(data) ? data : [data];
  const now = Date.now() / 1000;
  const nextLatest = {};
  const nextPrev = {};

  for (const row of rows) {
    if (!row) continue;
    const Id = row.Id;
    if (typeof Id !== 'number') continue;

    const cpuSec = typeof row.c === 'number' ? row.c : null;
    let cpuPercent = null;

    if (cpuSec != null && prev[Id] && prev[Id].cpuSec != null && (now - prev[Id].ts) > 0.5) {
      cpuPercent = Math.max(0, Math.round(((cpuSec - prev[Id].cpuSec) / (now - prev[Id].ts)) * 1000) / 10);
    }

    let user = null;
    if (typeof row.u === 'string') {
      const lastBackslash = row.u.lastIndexOf('\\');
      user = lastBackslash !== -1 ? row.u.substring(lastBackslash + 1) : row.u;
    }

    nextLatest[Id] = {
      user,
      sessionId: typeof row.i === 'number' ? row.i : null,
      cpuPercent,
      memBytes: typeof row.w === 'number' ? row.w : null,
      startEpoch: typeof row.s === 'number' ? row.s : null
    };
    nextPrev[Id] = { cpuSec, ts: now };
  }

  latest = nextLatest;
  prev = nextPrev;
}

// Owner fallback: Get-Process -IncludeUserName needs elevation; quser maps
// session ID → username, then processes get SessionId from Get-Process.
let owners = {};

function acceptOwners(data) {
  const stdout = data && typeof data.text === 'string' ? data.text : '';
  if (!stdout) return; // quser prints nothing when there are no sessions

  const newOwners = {};
  const lines = stdout.split('\n');

  // Skip header (first line)
  for (let i = 1; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // Strip leading '>' if present
    if (line.startsWith('>')) {
      line = line.substring(1).trim();
    }

    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;

    const username = tokens[0];

    // Find the first token after username that is all digits (Session ID)
    let sessionId = null;
    for (let j = 1; j < tokens.length; j++) {
      if (/^\d+$/.test(tokens[j])) {
        sessionId = parseInt(tokens[j], 10);
        break;
      }
    }

    if (sessionId !== null) {
      newOwners[sessionId] = username;
    }
  }

  owners = newOwners;
}

function ensureStarted() {
  if (started) return;
  started = true;
  psHost.subscribe('PROCS', accept);
  psHost.subscribe('OWNERS', acceptOwners);
}

function lookup(pid) {
  ensureStarted();
  const e = latest[pid];
  if (!e) return null;

  if (e.user == null && e.sessionId != null && owners[e.sessionId]) {
    return { ...e, user: owners[e.sessionId] };
  }

  return e;
}

module.exports = { lookup };
