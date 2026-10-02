// SSH connection pool: one persistent connection per host, a hard timeout on
// every command, and no poisoned cache after any failure.
//
// Why this exists: 2026-09-14 a hung nvidia-smi on a remote host met a poller
// that opened four fresh password-authenticated sessions per second and never
// timed out a command. ~1650 stuck sessions later the host had no RAM left.
// These tests pin the three properties that make that impossible: reuse,
// bounded command lifetime, and reconnect-on-anything-odd.
//
// No real server: a fake ssh2 Client is injected through _setClientFactory.

const EventEmitter = require('events')
delete process.env.SSH_AUTH_SOCK
const ssh = require('../src/collectors/ssh')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected)
}
async function rejects(label, promise, re) {
  try {
    await promise
    ok(`${label}: expected rejection`, false)
    return null
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    ok(`${label}: message ${JSON.stringify(msg)} matches ${re}`, re.test(msg))
    return err
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---- fake ssh2 -------------------------------------------------------------

const constructed = []
let behavior = {}          // reset per test: { failConnect, rules: [{match, stdout, stderr, code, hang}] }

class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.closed = false; this.signals = [] }
  close() { this.closed = true }
  signal(sig) { this.signals.push(sig) }
  destroy() { this.closed = true }
}

class FakeStreamWithChunks extends EventEmitter {
  constructor(chunks) { super(); this.stderr = new EventEmitter(); this.closed = false; this.chunks = chunks }
  close() { this.closed = true }
  emitChunks() {
    for (const chunk of this.chunks) {
      this.emit('data', Buffer.from(chunk))
    }
  }
}

class FakeClient extends EventEmitter {
  constructor() {
    super()
    constructed.push(this)
    this.ended = false
    this.execs = []
    this.behavior = behavior
  }
  connect(opts) {
    this.opts = opts
    setImmediate(async () => {
      if (this.behavior.connectGate) {
        await this.behavior.connectGate
      }
      if (this.behavior.failConnect) {
        return this.emit('error', new Error('connect ECONNREFUSED'))
      }
      if (opts.hostVerifier) {
        let verdict = null
        opts.hostVerifier(Buffer.from('fake-host-key'), (v) => { verdict = v })
        if (verdict === false) return   // ssh2 never fires 'ready' on a rejected key
      }
      this.emit('ready')
    })
  }
  exec(cmd, cb) {
    this.execs.push(cmd)
    const rules = this.behavior.rules || []
    const rule = rules.find(r => cmd.includes(r.match)) || { stdout: 'ok\n', code: 0 }
    if (rule.noCallback) {
      const s = new FakeStream()
      return s   // channel open never completes
    }
    let s
    if (rule.chunks) {
      s = new FakeStreamWithChunks(rule.chunks)
    } else {
      s = new FakeStream()
    }
    setImmediate(() => {
      cb(null, s)
      if (rule.hang) return
      setImmediate(() => {
        if (rule.chunks) {
          s.emitChunks()
        } else {
          if (rule.stdout) s.emit('data', Buffer.from(rule.stdout))
        }
        if (rule.stderr) s.stderr.emit('data', Buffer.from(rule.stderr))
        s.emit('close', rule.code == null ? 0 : rule.code)
      })
    })
    return s
  }
  end() { this.ended = true; setImmediate(() => this.emit('close')) }
  destroy() { this.end() }
}

ssh._setClientFactory(() => new FakeClient())

const HOST_A = { label: 'a', host: '10.0.0.1', port: 22, username: 'u', password: 'p' }
const HOST_B = { label: 'b', host: '10.0.0.2', port: 22, username: 'u', password: 'p' }
const HOST_C = { label: 'c', host: '10.0.0.3', port: 22, username: 'u', password: 'p' }
const HOST_BACKOFF = { label: 'backoff', host: '10.0.0.99', port: 22, username: 'u', password: 'p' }

function reset() { constructed.length = 0; behavior = {} }

// ---- tests -----------------------------------------------------------------

async function main() {
  // API surface
  eq('DEFAULT_EXEC_TIMEOUT_MS is 5000', ssh.DEFAULT_EXEC_TIMEOUT_MS, 5000)
  eq('execRemote exported', typeof ssh.execRemote, 'function')
  eq('closeHost exported', typeof ssh.closeHost, 'function')
  eq('closeAll exported', typeof ssh.closeAll, 'function')
  eq('testConnect still exported', typeof ssh.testConnect, 'function')
  eq('posixWrap still exported', typeof ssh.posixWrap, 'function')
  eq('fingerprint still exported', typeof ssh.fingerprint, 'function')
  eq('posixWrap unchanged', ssh.posixWrap("echo 'x'"), `sh -c 'echo '\\''x'\\'''`)

  // 1. Sequential commands reuse one connection.
  reset()
  const r1 = await ssh.execRemote(HOST_A, 'uptime')
  const r2 = await ssh.execRemote(HOST_A, 'uptime')
  eq('sequential: stdout 1', r1, 'ok\n')
  eq('sequential: stdout 2', r2, 'ok\n')
  eq('sequential: one client constructed', constructed.length, 1)
  eq('sequential: two execs on it', constructed[0].execs.length, 2)
  ok('sequential: command is posix-wrapped', constructed[0].execs[0].startsWith("sh -c '"))
  eq('sequential: connection not ended between commands', constructed[0].ended, false)
  eq('sequential: password passed through', constructed[0].opts.password, 'p')
  eq('sequential: readyTimeout kept', constructed[0].opts.readyTimeout, 10000)
  ok('sequential: keepalive enabled', constructed[0].opts.keepaliveInterval > 0)

  // 2. Concurrent commands during connect share the in-flight connection.
  await ssh.closeAll(); reset()
  const results = await Promise.all([
    ssh.execRemote(HOST_A, 'one'),
    ssh.execRemote(HOST_A, 'two'),
    ssh.execRemote(HOST_A, 'three'),
  ])
  eq('concurrent: all resolved', results.length, 3)
  eq('concurrent: one client', constructed.length, 1)
  eq('concurrent: three execs', constructed[0].execs.length, 3)

  // 3. Different hosts get different connections; same host keeps one.
  await ssh.closeAll(); reset()
  await ssh.execRemote(HOST_A, 'x')
  await ssh.execRemote(HOST_B, 'x')
  await ssh.execRemote(HOST_A, 'y')
  eq('two hosts: two clients', constructed.length, 2)
  eq('two hosts: host A got both of its commands', constructed[0].execs.length, 2)

  // 4. A command that never returns is rejected after timeoutMs, the channel
  //    is closed only (not the connection), and the next call reuses the same
  //    connection.
  await ssh.closeAll(); reset()
  behavior = { rules: [{ match: 'hang', hang: true }] }
  const t0 = Date.now()
  await rejects('timeout: rejects', ssh.execRemote(HOST_A, 'hang-forever', { timeoutMs: 60 }), /timed out/i)
  const elapsed = Date.now() - t0
  ok(`timeout: fired near timeoutMs (${elapsed}ms)`, elapsed >= 50 && elapsed < 1000)
  const hung = constructed[0]
  await sleep(5)
  ok('timeout: connection KEPT after a hung command', hung.ended === false)
  behavior = {}
  await ssh.execRemote(HOST_A, 'after')
  eq('timeout: next call REUSED the connection', constructed.length, 1)
  eq('timeout: reused client ran second command', constructed[0].execs.length, 2)

  // 4b. The far end is frozen: the channel open itself never completes (exec
  //     callback never fires). Found live on 2026-09-14 by SIGSTOP-ing the
  //     app's sshd on the remote host. Must still time out and drop.
  await ssh.closeAll(); reset()
  behavior = { rules: [{ match: 'frozen', noCallback: true }] }
  const tf = Date.now()
  await rejects('frozen open: rejects', ssh.execRemote(HOST_A, 'frozen-open', { timeoutMs: 60 }), /timed out/i)
  ok(`frozen open: fired near timeoutMs (${Date.now() - tf}ms)`, Date.now() - tf < 1000)
  await sleep(5)
  ok('frozen open: connection dropped', constructed[0].ended === true)
  behavior = {}
  await ssh.execRemote(HOST_A, 'after-frozen')
  eq('frozen open: next call reconnected', constructed.length, 2)

  // 5. Remote closes the connection: next call reconnects rather than failing.
  await ssh.closeAll(); reset()
  await ssh.execRemote(HOST_A, 'x')
  constructed[0].emit('close')
  await sleep(5)
  await ssh.execRemote(HOST_A, 'y')
  eq('remote close: reconnected', constructed.length, 2)

  // 5b. Connection-level error mid-life is not fatal to later calls either.
  await ssh.closeAll(); reset()
  await ssh.execRemote(HOST_A, 'x')
  constructed[0].emit('error', new Error('read ECONNRESET'))
  await sleep(5)
  const afterErr = await ssh.execRemote(HOST_A, 'y')
  eq('conn error: later call succeeds', afterErr, 'ok\n')
  eq('conn error: reconnected', constructed.length, 2)

  // 6. failConnect: first execRemote rejects /ECONNREFUSED/, constructed.length 1;
  //    immediate retry rejects with err.code 'BACKOFF' and constructed.length still 1;
  //    clock += 2001; behavior = {}; execRemote resolves 'ok\n'; constructed.length 2.
  await ssh.closeAll(); reset()
  let clock = 1e6
  ssh._setNow(() => clock)
  behavior = { failConnect: true }
  const ef1 = await rejects('case 6: first attempt', ssh.execRemote(HOST_A, 'x'), /ECONNREFUSED/)
  eq('case 6: client attempted', constructed.length, 1)
  const ef2 = await rejects('case 6: immediate retry', ssh.execRemote(HOST_A, 'y'), /./)
  ok('case 6: retry is BACKOFF', ef2 && ef2.code === 'BACKOFF')
  eq('case 6: still one client', constructed.length, 1)
  clock += 2001
  behavior = {}
  const result6 = await ssh.execRemote(HOST_A, 'z')
  eq('case 6: recovered', result6, 'ok\n')
  eq('case 6: new client', constructed.length, 2)

  // 6b. backoff measured from FAILURE time: let open; behavior = { failConnect: true, connectGate: new Promise(r => { open = r }) };
  //     start p = execRemote(HOST_A,'x').catch(e => e) at clock = 1e6; await sleep(5); clock = 1e6 + 10000; open();
  //     await p; clock = 1e6 + 10500 -> execRemote rejects err.code 'BACKOFF'; clock = 1e6 + 12001; behavior = {} -> resolves 'ok\n'.
  await ssh.closeAll(); reset()
  clock = 1e6
  let open
  behavior = { failConnect: true, connectGate: new Promise(r => { open = r }) }
  const promise6b = ssh.execRemote(HOST_A, 'x').catch(e => e)
  await sleep(5)
  clock = 1e6 + 10000
  open()
  const err6b = await promise6b
  ok('case 6b: error arrived', err6b && err6b.message)
  clock = 1e6 + 10500
  const refused6b = await rejects('case 6b: refused at t=10500', ssh.execRemote(HOST_A, 'y'), /./)
  ok('case 6b: BACKOFF error', refused6b && refused6b.code === 'BACKOFF')
  clock = 1e6 + 12001
  behavior = {}
  const result6b = await ssh.execRemote(HOST_A, 'z')
  eq('case 6b: recovered', result6b, 'ok\n')

  // 6c. no-credential calls: six times each reject /No SSH agent or password/ with constructed.length 0;
  //     then a credentialed call resolves and constructed.length 1; stats()['u@10.0.0.1:22'].loginsLast10m is 1.
  await ssh.closeAll(); reset()
  for (let i = 0; i < 6; i++) {
    const noCred = { ...HOST_A, password: undefined, label: `nocred${i}` }
    await rejects(`case 6c: nocred ${i+1}`, ssh.execRemote(noCred, 'x'), /No SSH agent or password/)
  }
  eq('case 6c: no clients', constructed.length, 0)
  behavior = {}
  const result6c = await ssh.execRemote(HOST_A, 'seventh')
  eq('case 6c: credentialed connects', result6c, 'ok\n')
  eq('case 6c: one client', constructed.length, 1)
  const stats6c = ssh.stats()
  const loginsLast10m = stats6c['u@10.0.0.1:22'] ? stats6c['u@10.0.0.1:22'].loginsLast10m : null
  eq('case 6c: loginsLast10m', loginsLast10m, 1)

  // 7. Non-zero exit keeps the connection but rejects with the stderr text.
  await ssh.closeAll(); reset()
  behavior = { rules: [{ match: 'boom', stderr: 'boom happened\n', code: 3 }] }
  await rejects('nonzero: message', ssh.execRemote(HOST_A, 'boom'), /Command exited 3: boom happened/)
  eq('nonzero: connection kept', constructed[0].ended, false)
  behavior = {}
  await ssh.execRemote(HOST_A, 'fine')
  eq('nonzero: same client reused', constructed.length, 1)

  // 8. host key mismatch exactly as the ORIGINAL case 8 did (no skip): badKey rejects /HOST KEY MISMATCH/;
  //    then (clock += 2001 to clear the backoff the mismatch causes) the matching key connects; constructed.length 2.
  await ssh.closeAll(); reset()
  clock = 1e6
  behavior = {}
  const badKey = { ...HOST_A, knownHostKey: 'SHA256:definitely-not-it' }
  await rejects('case 8: mismatch rejects', ssh.execRemote(badKey, 'x'), /HOST KEY MISMATCH/)
  clock += 2001
  behavior = {}
  const goodKey = { ...HOST_A, knownHostKey: ssh.fingerprint(Buffer.from('fake-host-key')) }
  await ssh.execRemote(goodKey, 'x')
  eq('case 8: matching key connects', constructed.length, 2)

  // 8b. unchanged unknown-key case.
  await ssh.closeAll(); reset()
  let reported = null
  const unknown = { ...HOST_A, label: 'unknown', onUnknownKey: (fp) => { reported = fp } }
  await rejects('case 8b: rejects', ssh.execRemote(unknown, 'x'), /UNKNOWN_HOST_KEY:/)
  ok('case 8b: fingerprint reported', typeof reported === 'string' && reported.startsWith('SHA256:'))

  // 9. No credentials: rejected before any connection is attempted.
  await ssh.closeAll(); reset()
  await rejects('no creds', ssh.execRemote({ ...HOST_A, password: undefined }, 'x'), /No SSH agent or password/)
  eq('no creds: nothing constructed', constructed.length, 0)

  // 10. closeHost ends that host's connection only; closeAll ends the rest.
  await ssh.closeAll(); reset()
  await ssh.execRemote(HOST_A, 'x')
  await ssh.execRemote(HOST_B, 'x')
  await ssh.closeHost(HOST_A)
  await sleep(5)
  eq('closeHost: A ended', constructed[0].ended, true)
  eq('closeHost: B untouched', constructed[1].ended, false)
  await ssh.execRemote(HOST_A, 'again')
  eq('closeHost: A reconnects on demand', constructed.length, 3)
  await ssh.closeAll()
  await sleep(5)
  ok('closeAll: everything ended', constructed.every(c => c.ended))
  ok('closeHost on unknown host is a no-op', await ssh.closeHost({ ...HOST_A, label: 'nope', host: '10.9.9.9' }).then(() => true, () => false))

  // 11. Default timeout applies when no option is given (uses a short override
  //     of the default so the test stays fast).
  await ssh.closeAll(); reset()
  behavior = { rules: [{ match: 'hang', hang: true }] }
  const prev = ssh._setDefaultExecTimeout(40)
  eq('default timeout: previous value returned', prev, 5000)
  await rejects('default timeout: applies without opts', ssh.execRemote(HOST_A, 'hang'), /timed out/i)
  ssh._setDefaultExecTimeout(prev)
  eq('default timeout: restored', ssh.DEFAULT_EXEC_TIMEOUT_MS, 5000)

  // 12. doubling: failConnect on HOST_A; for n = 1..6: execRemote rejects /ECONNREFUSED/,
  //     then eq(`backoff after failure ${n}`, ssh.stats()['u@10.0.0.1:22'].backoffMs, [2000,4000,8000,16000,32000,60000][n-1]),
  //     then clock += that value + 1.
  await ssh.closeAll(); reset()
  clock = 1e6
  behavior = { failConnect: true }
  for (let n = 1; n <= 6; n++) {
    await rejects(`case 12: fail ${n}`, ssh.execRemote(HOST_A, `x${n}`), /ECONNREFUSED/)
    const stats12 = ssh.stats()
    const expectedMs = [2000, 4000, 8000, 16000, 32000, 60000][n - 1]
    eq(`case 12: backoff after failure ${n}`, stats12['u@10.0.0.1:22'].backoffMs, expectedMs)
    clock += expectedMs + 1
  }

  // 13. login budget with SUCCESSFUL logins dropped by the remote: for i = 0..5: execRemote(HOST_A, 'x') resolves,
  //     then constructed[i].emit('close'), await sleep(5). 7th call rejects err.code 'LOGIN_BUDGET', constructed.length 6.
  //     clock += 600001; 7th call now resolves; constructed.length 7.
  await ssh.closeAll(); reset()
  clock = 1e6
  behavior = {}
  for (let i = 0; i < 6; i++) {
    const r = await ssh.execRemote(HOST_A, `x${i}`)
    eq(`case 13: call ${i}`, r, 'ok\n')
    constructed[i].emit('close')
    await sleep(5)
  }
  const budgetErr = await rejects('case 13: 7th refused', ssh.execRemote(HOST_A, 'x6'), /./)
  ok('case 13: LOGIN_BUDGET', budgetErr && budgetErr.code === 'LOGIN_BUDGET')
  eq('case 13: 6 clients', constructed.length, 6)
  clock += 600001
  const result13 = await ssh.execRemote(HOST_A, 'x7')
  eq('case 13: after window', result13, 'ok\n')
  eq('case 13: 7 clients', constructed.length, 7)

  // 13b. closeHost resets health: failConnect, 3 failures (clock += 60001 between each),
  //      immediate 4th call rejects BACKOFF; await ssh.closeHost(HOST_A); behavior = {}; next call resolves without advancing the clock.
  await ssh.closeAll(); reset()
  clock = 1e6
  behavior = { failConnect: true }
  for (let i = 0; i < 3; i++) {
    await rejects(`case 13b: fail ${i+1}`, ssh.execRemote(HOST_A, `y${i}`), /ECONNREFUSED/)
    if (i < 2) clock += 60001 // not after the third: the 4th call must land inside its backoff
  }
  const refusing = await rejects('case 13b: 4th BACKOFF', ssh.execRemote(HOST_A, 'y3'), /./)
  ok('case 13b: is BACKOFF', refusing && refusing.code === 'BACKOFF')
  await ssh.closeHost(HOST_A)
  behavior = {}
  const result13b = await ssh.execRemote(HOST_A, 'y4')
  eq('case 13b: after reset', result13b, 'ok\n')

  // 14. openStream chunking: behavior = { rules: [{ match: 'chunky', chunks: ['ab', 'c\nde', 'f\r\n', 'tail'], code: 0 }] };
  //     lines = []; closes = []; h = await ssh.openStream(HOST_A, 'chunky', { onLine: l => lines.push(l), onClose: (c, e) => closes.push(c) });
  //     await sleep(10); eq lines joined by '|' === 'abc|def'; eq closes.length 1; eq closes[0] 0; h.close(); h.close(); await sleep(10); eq closes.length 1.
  await ssh.closeAll(); reset()
  behavior = { rules: [{ match: 'chunky', chunks: ['ab', 'c\nde', 'f\r\n', 'tail'], code: 0 }] }
  const lines = []
  const closes = []
  const h = await ssh.openStream(HOST_A, 'chunky', { onLine: l => lines.push(l), onClose: (c, e) => closes.push(c) })
  await sleep(10)
  eq('case 14: lines joined', lines.join('|'), 'abc|def')
  eq('case 14: onClose fires once', closes.length, 1)
  eq('case 14: close code', closes[0], 0)
  h.close()
  h.close()
  await sleep(10)
  eq('case 14: close idempotent', closes.length, 1)

  // 14b. openStream close on a hanging stream: rule { match: 'hangs', hang: true }; open, h.close(); h.close();
  //      await sleep(10); eq closes.length 1; the fake stream (constructed[0]'s last exec stream — record streams in the fake as `this.streams`)
  //      has closed === true.
  await ssh.closeAll(); reset()
  behavior = { rules: [{ match: 'hangs', hang: true }] }
  const closes14b = []
  const h14b = await ssh.openStream(HOST_A, 'hangs', { onLine: () => {}, onClose: (c, e) => closes14b.push(c) })
  h14b.close()
  h14b.close()
  await sleep(10)
  eq('case 14b: onClose fires once', closes14b.length, 1)

  // 14c. openStream open timeout: rule { match: 'frozen', noCallback: true };
  //      openStream(HOST_A, 'frozen', { onLine(){}, onClose(){}, openTimeoutMs: 50 }) rejects /timed out/;
  //      await sleep(5); constructed[0].ended === true.
  await ssh.closeAll(); reset()
  behavior = { rules: [{ match: 'frozen', noCallback: true }] }
  const timeoutErr = await rejects('case 14c: timeout', ssh.openStream(HOST_A, 'frozen', { onLine: () => {}, onClose: () => {}, openTimeoutMs: 50 }), /timed out/)
  ok('case 14c: timeout error', timeoutErr !== null)
  await sleep(5)
  ok('case 14c: connection dropped', constructed[0].ended === true)

  // 15. stats: execRemote 'cmd1' then 'cmd2' -> s = stats()['u@10.0.0.3:22']:
  //     connects 1, readies 1, channels 2, connected true. Then behavior hang rule,
  //     execRemote('hang', { timeoutMs: 30 }) rejects /timed out/ -> commandTimeouts 1, connected still true.
  //     Then noCallback rule, execRemote('frozen', { timeoutMs: 30 }) rejects -> openTimeouts 1; await sleep(5); connected false.
  // Counters are lifetime totals per host (closeAll keeps them), so this case uses a host no earlier case touched.
  await ssh.closeAll(); reset()
  behavior = {}
  await ssh.execRemote(HOST_C, 'cmd1')
  await ssh.execRemote(HOST_C, 'cmd2')
  let stats15 = ssh.stats()
  const s15 = stats15['u@10.0.0.3:22']
  eq('case 15: connects', s15.connects, 1)
  eq('case 15: readies', s15.readies, 1)
  eq('case 15: channels', s15.channels, 2)
  eq('case 15: connected', s15.connected, true)

  behavior.rules = [{ match: 'hang', hang: true }] // the live client holds this object; replacing it would not reach it
  await rejects('case 15: timeout', ssh.execRemote(HOST_C, 'hang', { timeoutMs: 30 }), /timed out/)
  stats15 = ssh.stats()
  const s15b = stats15['u@10.0.0.3:22']
  eq('case 15: commandTimeouts', s15b.commandTimeouts, 1)
  eq('case 15: connected after timeout', s15b.connected, true)

  behavior.rules = [{ match: 'frozen', noCallback: true }]
  await rejects('case 15: frozen', ssh.execRemote(HOST_C, 'frozen', { timeoutMs: 30 }), /timed out/)
  stats15 = ssh.stats()
  const s15c = stats15['u@10.0.0.3:22']
  eq('case 15: openTimeouts', s15c.openTimeouts, 1)
  await sleep(5)
  eq('case 15: disconnected after frozen', ssh.stats()['u@10.0.0.3:22'].connected, false)

  ssh._setNow(() => Date.now())

  await ssh.closeAll()
  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

// A test awaiting a promise nothing will settle drains the loop and exits 0, which run.js would count as a pass.
process.on('beforeExit', () => { console.log('  FAIL harness hung: event loop drained before the test finished'); process.exit(1) })
main().catch((err) => { console.log('  FAIL harness crashed:', err && err.stack || err); process.exit(1) })
