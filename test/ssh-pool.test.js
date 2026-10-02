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
    setImmediate(() => {
      if (this.behavior.failConnect) return this.emit('error', new Error('connect ECONNREFUSED'))
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
    const s = new FakeStream()
    const rules = this.behavior.rules || []
    const rule = rules.find(r => cmd.includes(r.match)) || { stdout: 'ok\n', code: 0 }
    if (rule.noCallback) return s   // channel open never completes
    setImmediate(() => {
      cb(null, s)
      if (rule.hang) return
      setImmediate(() => {
        if (rule.stdout) s.emit('data', Buffer.from(rule.stdout))
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
  //    is closed, the connection is dropped, and the next call reconnects.
  await ssh.closeAll(); reset()
  behavior = { rules: [{ match: 'hang', hang: true }] }
  const t0 = Date.now()
  await rejects('timeout: rejects', ssh.execRemote(HOST_A, 'hang-forever', { timeoutMs: 60 }), /timed out/i)
  const elapsed = Date.now() - t0
  ok(`timeout: fired near timeoutMs (${elapsed}ms)`, elapsed >= 50 && elapsed < 1000)
  const hung = constructed[0]
  await sleep(5)
  ok('timeout: connection dropped after a hung command', hung.ended === true)
  behavior = {}
  await ssh.execRemote(HOST_A, 'after')
  eq('timeout: next call built a fresh client', constructed.length, 2)
  eq('timeout: fresh client ran the command', constructed[1].execs.length, 1)

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

  // 6. Connect failure rejects every waiter and does not poison the cache.
  await ssh.closeAll(); reset()
  behavior = { failConnect: true }
  const [e1, e2] = await Promise.all([
    rejects('connect fail: waiter 1', ssh.execRemote(HOST_A, 'x'), /ECONNREFUSED/),
    rejects('connect fail: waiter 2', ssh.execRemote(HOST_A, 'y'), /ECONNREFUSED/),
  ])
  ok('connect fail: both waiters got an error', e1 && e2)
  eq('connect fail: one client attempted', constructed.length, 1)
  behavior = {}
  await ssh.execRemote(HOST_A, 'z')
  eq('connect fail: recovered with a new client', constructed.length, 2)

  // 7. Non-zero exit keeps the connection but rejects with the stderr text.
  await ssh.closeAll(); reset()
  behavior = { rules: [{ match: 'boom', stderr: 'boom happened\n', code: 3 }] }
  await rejects('nonzero: message', ssh.execRemote(HOST_A, 'boom'), /Command exited 3: boom happened/)
  eq('nonzero: connection kept', constructed[0].ended, false)
  behavior = {}
  await ssh.execRemote(HOST_A, 'fine')
  eq('nonzero: same client reused', constructed.length, 1)

  // 8. Host key mismatch still rejects, and nothing is cached for that host.
  await ssh.closeAll(); reset()
  const badKey = { ...HOST_A, knownHostKey: 'SHA256:definitely-not-it' }
  await rejects('hostkey: mismatch rejects', ssh.execRemote(badKey, 'x'), /HOST KEY MISMATCH/)
  behavior = {}
  const goodKey = { ...HOST_A, knownHostKey: ssh.fingerprint(Buffer.from('fake-host-key')) }
  await ssh.execRemote(goodKey, 'x')
  eq('hostkey: matching key connects', constructed.length, 2)

  // 8b. Unknown key with a reporter: reported, rejected, not cached.
  await ssh.closeAll(); reset()
  let reported = null
  const unknown = { ...HOST_A, onUnknownKey: (fp) => { reported = fp } }
  await rejects('unknown key: rejects', ssh.execRemote(unknown, 'x'), /UNKNOWN_HOST_KEY:/)
  ok('unknown key: fingerprint reported', typeof reported === 'string' && reported.startsWith('SHA256:'))

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

  await ssh.closeAll()
  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((err) => { console.log('  FAIL harness crashed:', err && err.stack || err); process.exit(1) })
