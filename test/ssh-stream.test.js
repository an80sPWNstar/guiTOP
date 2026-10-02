// Streaming remote sampler: one ssh channel per host running a shell loop that
// prints framed samples every 2 seconds. Steady state is one login and one channel
// for the life of the app. Tests the framing, state machine, error recovery, and
// backoff behavior.

const T = require('../src/collectors/remote-commands')
const stream = require('../src/collectors/ssh-stream')

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

// ---- fake openStream + clock/timers ----

let clock = 0
let timers = []
let nextTimerId = 1
let nonceSeq = 0
const calls = []

function advance(ms) {
  const end = clock + ms
  while (timers.length > 0 && timers[0].at <= end) {
    const t = timers.shift()
    clock = t.at
    t.fn()
    if (t.every) {
      t.id = nextTimerId++
      t.at = clock + t.every
      timers.push(t)
      timers.sort((a, b) => a.at - b.at)
    }
  }
  clock = end
}

async function flush() {
  return new Promise(r => setImmediate(r))
}

function fakeSetTimeout(fn, ms) {
  const id = nextTimerId++
  timers.push({ id, at: clock + ms, fn })
  timers.sort((a, b) => a.at - b.at)
  return id
}

function fakeClearTimeout(id) {
  timers = timers.filter(t => t.id !== id)
}

function fakeSetInterval(fn, ms) {
  const id = nextTimerId++
  timers.push({ id, at: clock + ms, fn, every: ms })
  timers.sort((a, b) => a.at - b.at)
  return id
}

function fakeClearInterval(id) {
  timers = timers.filter(t => t.id !== id)
}

let openMode = 'ok'

async function fakeOpenStream(hostConfig, script, handlers) {
  const call = { host: hostConfig.host, script, handlers, closed: 0, opened: false, at: clock }
  calls.push(call)
  if (openMode === 'reject') {
    return Promise.reject(new Error('connect ECONNREFUSED'))
  }
  if (openMode === 'manual') {
    return new Promise(resolve => {
      call.resolveOpen = resolve
    }).then(handle => {
      call.opened = true
      return handle
    })
  }
  call.opened = true
  return { close() { call.closed++ } }
}

function deps() {
  return {
    openStream: fakeOpenStream,
    now: () => clock,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    nonce: () => 'n' + (++nonceSeq),
    lockId: 'abcdef012345',
  }
}

function iteration(call, map) {
  const nonce = call.script.split('@@')[1].split(' ')[0]
  call.handlers.onLine(`@@${nonce} B`)
  for (const [name, {out, code}] of map) {
    call.handlers.onLine(`@@${nonce} S ${name}`)
    if (out === '') {
      call.handlers.onLine('')
    } else {
      for (const line of out.split('\n')) {
        if (line || out.endsWith('\n')) {
          call.handlers.onLine(line)
        }
      }
    }
    call.handlers.onLine(`@@${nonce} E ${name} ${code}`)
  }
  call.handlers.onLine(`@@${nonce} Z`)
}

function reset() {
  clock = 0
  timers = []
  nextTimerId = 1
  nonceSeq = 0
  calls.length = 0
  openMode = 'ok'
}

function openChannels() {
  return calls.filter(c => c.opened && !c.closed).length
}

// ---- tests -----------------------------------------------------------------

async function main() {
  // 1. buildScript contains lock, flock, BUSY guard, sleep 2 9>&-, S/E pairs in
  //    sorted order, and the nonce/lockId are literal hex.
  reset()
  const e1 = { name: 'b', cmd: 'echo two' }
  const e2 = { name: 'a', cmd: 'echo one' }
  const script1 = stream.buildScript([e1, e2], 'ff00', 'abc123')
  ok('buildScript: contains /tmp/guitop-abc123-$(id -u).lock', script1.includes('/tmp/guitop-abc123-$(id -u).lock'))
  ok('buildScript: contains flock -n 9', script1.includes('flock -n 9'))
  ok('buildScript: contains @@ff00 BUSY', script1.includes('@@ff00 BUSY'))
  ok('buildScript: contains sleep 2 9>&-', script1.includes('sleep 2 9>&-'))
  const aIdx = script1.indexOf('@@ff00 S a')
  const bIdx = script1.indexOf('@@ff00 S b')
  ok('buildScript: a S marker before b S marker (sorted by name)', aIdx !== -1 && bIdx !== -1 && aIdx < bIdx)
  ok('buildScript: contains ( echo one ) </dev/null 2>/dev/null', script1.includes('( echo one ) </dev/null 2>/dev/null'))
  ok('buildScript: contains printf for exit code', script1.includes('printf'))
  ok('buildScript: last line is done', script1.trim().endsWith('done'))

  // 2. parseMarker recognizes all marker types and rejects plain text and bad nonces.
  eq('parseMarker B', JSON.stringify(stream.parseMarker('@@foo B', 'foo')), JSON.stringify({t:'B'}))
  eq('parseMarker Z', JSON.stringify(stream.parseMarker('@@foo Z', 'foo')), JSON.stringify({t:'Z'}))
  eq('parseMarker BUSY', JSON.stringify(stream.parseMarker('@@foo BUSY', 'foo')), JSON.stringify({t:'BUSY'}))
  eq('parseMarker S', JSON.stringify(stream.parseMarker('@@foo S nv-gpu', 'foo')), JSON.stringify({t:'S',name:'nv-gpu'}))
  eq('parseMarker E', JSON.stringify(stream.parseMarker('@@foo E ps 3', 'foo')), JSON.stringify({t:'E',name:'ps',code:3}))
  eq('parseMarker E with code 0', JSON.stringify(stream.parseMarker('@@foo E host 0', 'foo')), JSON.stringify({t:'E',name:'host',code:0}))
  eq('parseMarker wrong nonce', stream.parseMarker('@@wrong S nv-gpu', 'foo'), null)
  eq('parseMarker plain text', stream.parseMarker('some output', 'foo'), null)
  eq('parseMarker E with non-numeric code', stream.parseMarker('@@foo E ps x', 'foo'), null)

  // 3. One channel per tick: four exec() calls in one tick coalesce into ONE channel.
  reset()
  const s3 = stream.createSampler({ host: 'h3', port: 22, username: 'u', label: 'h3' }, deps())
  s3.exec({ name: 'nv-gpu', cmd: 'nvidia-smi' })
  s3.exec({ name: 'nv-proc', cmd: 'nvidia-smi --query-compute-apps' })
  s3.exec({ name: 'ps', cmd: 'ps -eo ...' })
  s3.exec({ name: 'host', cmd: 'cat /proc/stat' })
  advance(250)
  eq('one channel per tick: one call so far', calls.length, 1)
  ok('one channel per tick: script contains all 4 S markers',
    calls[0].script.includes('S nv-gpu') &&
    calls[0].script.includes('S nv-proc') &&
    calls[0].script.includes('S ps') &&
    calls[0].script.includes('S host'))

  // 4. Framed iteration resolves exec with correct output, handling empty outputs
  //    and outputs without trailing newlines, and non-zero codes reject.
  reset()
  const s4 = stream.createSampler({ host: 'h4', port: 22, username: 'u', label: 'h4' }, deps())
  const p4_host = s4.exec({ name: 'host', cmd: 'cat /proc/stat' })
  const p4_nv_gpu = s4.exec({ name: 'nv-gpu', cmd: 'nvidia-smi' })
  const p4_ps = s4.exec({ name: 'ps', cmd: 'ps -eo ...' })
  const p4_nv_proc = s4.exec({ name: 'nv-proc', cmd: 'nvidia-smi --query-compute-apps' })
  // Attach the handler now: it rejects during the flushes below, before it is awaited.
  const r4_nv_proc_errP = rejects('framed: nv-proc code 3', p4_nv_proc, /Command exited 3/)
  advance(250)
  ok('framed iteration: channel opened', calls.length === 1)
  iteration(calls[0], [
    ['host', { out: 'line1\nline2\n', code: 0 }],
    ['nv-gpu', { out: '', code: 0 }],
    ['ps', { out: 'x\n', code: 0 }],
    ['nv-proc', { out: '', code: 3 }],
  ])
  await flush(); await flush(); await flush()
  const r4_host = await p4_host
  const r4_nv_gpu = await p4_nv_gpu
  const r4_ps = await p4_ps
  const r4_nv_proc_err = await r4_nv_proc_errP
  eq('framed: host output correct', r4_host, 'line1\nline2\n')
  eq('framed: nv-gpu empty output', r4_nv_gpu, '')
  eq('framed: ps output with newline', r4_ps, 'x\n')
  ok('framed: nv-proc rejects code 3', r4_nv_proc_err && r4_nv_proc_err.message.includes('3'))

  // 4b. Output without trailing newline.
  reset()
  const s4b = stream.createSampler({ host: 'h4b', port: 22, username: 'u', label: 'h4b' }, deps())
  const p4b_ps = s4b.exec({ name: 'ps', cmd: 'ps -eo ...' })
  advance(250)
  const nonce4b = calls[0].script.split('@@')[1].split(' ')[0]
  calls[0].handlers.onLine(`@@${nonce4b} B`)
  calls[0].handlers.onLine(`@@${nonce4b} S ps`)
  calls[0].handlers.onLine('x')
  calls[0].handlers.onLine(`@@${nonce4b} E ps 0`)
  calls[0].handlers.onLine(`@@${nonce4b} Z`)
  await flush(); await flush(); await flush()
  const r4b_ps = await p4b_ps
  eq('framed without trailing newline: adds newline', r4b_ps, 'x\n')

  // 5. Steady state: after first iteration, loop 20 times with the same channel.
  reset()
  const s5 = stream.createSampler({ host: 'h5', port: 22, username: 'u', label: 'h5' }, deps())
  s5.exec({ name: 'host', cmd: 'cat /proc/stat' })
  advance(250)
  eq('steady: first channel opened', calls.length, 1)
  iteration(calls[0], [['host', { out: 'stat\n', code: 0 }]])
  for (let i = 0; i < 20; i++) {
    const p = s5.exec({ name: 'host', cmd: 'cat /proc/stat' })
    advance(2000)
    iteration(calls[0], [['host', { out: 'stat\n', code: 0 }]])
    await p
  }
  eq('steady state: still one channel', calls.length, 1)
  eq('steady state: iterations counted', s5.stats().iterations, 21)

  // 6. Freshness: after an iteration, exec('host') resolves immediately (cached).
  //    Then if nothing is fed for > STALL_MS, it stalls. But WAIT_MS alone is not a stall.
  reset()
  const s6 = stream.createSampler({ host: 'h6', port: 22, username: 'u', label: 'h6' }, deps())
  const p6_1 = s6.exec({ name: 'host', cmd: 'cat /proc/stat' })
  advance(250)
  iteration(calls[0], [['host', { out: 'a\n', code: 0 }]])
  await flush(); await flush(); await flush()
  const r6_1 = await p6_1
  eq('freshness: first exec cached', r6_1, 'a\n')
  const p6_2 = s6.exec({ name: 'host', cmd: 'cat /proc/stat' })
  await p6_2
  ok('freshness: second exec immediate', true)
  advance(10001)
  const p6_3 = s6.exec({ name: 'host', cmd: 'cat /proc/stat' })
  const err6_3P = rejects('freshness: no sample after WAIT_MS', p6_3, /no sample|stuck/)
  advance(4001) // the WAIT_MS timer is fake; nothing fires it but the clock
  const err6_3 = await err6_3P
  ok('freshness: rejected with timeout message', err6_3 && (err6_3.message.includes('no sample') || err6_3.message.includes('stuck')))

  // 7. Stall then BUSY: after an iteration, advance past STALL_MS (15000) with no
  //    output -> stall, restart. Feed BUSY, trigger onClose. Repeat.
  //    After BUSY_QUICK_RETRIES quick retries, the next BUSY sets stuck=true.
  reset()
  const s7 = stream.createSampler({ host: 'h7', port: 22, username: 'u', label: 'h7' }, deps())
  s7.exec({ name: 'host', cmd: 'cat /proc/stat' })
  advance(250)
  await flush() // let restart() finish its await so the stall watchdog is armed
  iteration(calls[0], [['host', { out: 'stat\n', code: 0 }]])
  advance(15000 + 5000 + 100)
  eq('stall: one stall detected', s7.stats().stalls, 1)
  eq('stall: channel closed', calls[0].closed, 1)
  advance(2001)
  await flush()
  eq('stall: reconnected', calls.length, 2)
  const nonce7 = calls[1].script.split('@@')[1].split(' ')[0]
  calls[1].handlers.onLine(`@@${nonce7} BUSY`)
  calls[1].handlers.onClose(75)
  advance(3001)
  await flush()
  eq('stall: third attempt after first BUSY', calls.length, 3)
  const nonce7_2 = calls[2].script.split('@@')[1].split(' ')[0]
  calls[2].handlers.onLine(`@@${nonce7_2} BUSY`)
  calls[2].handlers.onClose(75)
  advance(3001)
  await flush()
  eq('stall: fourth attempt after second BUSY', calls.length, 4)
  const nonce7_3 = calls[3].script.split('@@')[1].split(' ')[0]
  calls[3].handlers.onLine(`@@${nonce7_3} BUSY`)
  calls[3].handlers.onClose(75)
  const p7_stuck = s7.exec({ name: 'host', cmd: 'cat /proc/stat' })
  const err7_stuckP = rejects('stall then BUSY: stuck message', p7_stuck, /stuck/)
  advance(4001)
  const err7_stuck = await err7_stuckP
  ok('stall then BUSY: stuck detected', err7_stuck && err7_stuck.message.includes('stuck'))

  // 8. Restart delay doubles and caps at RESTART_MAX_MS (300000).
  reset()
  openMode = 'reject'
  const s8 = stream.createSampler({ host: 'h8', port: 22, username: 'u', label: 'h8' }, deps())
  const want8 = () => s8.exec({ name: 'host', cmd: 'cat /proc/stat' }).catch(() => {})
  want8()
  fakeSetInterval(want8, 10000) // keep the name requested so idle-drop never empties the set
  // One timer at a time, so a rejection settles at the instant its restart fired.
  while (calls.length < 12 && timers.length && clock < 3000000) {
    advance(timers[0].at - clock)
    await flush()
  }
  const gaps8 = calls.slice(1).map((c, i) => c.at - calls[i].at)
  const expect8 = [2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000]
  for (let i = 0; i < expect8.length; i++) eq(`restart delay: gap ${i + 1}`, gaps8[i], expect8[i])

  // 9. Never two channels open at once.
  reset()
  const s9 = stream.createSampler({ host: 'h9', port: 22, username: 'u', label: 'h9' }, deps())
  for (let i = 0; i < 10; i++) {
    s9.exec({ name: 'host', cmd: 'cat /proc/stat' })
    advance(250); await flush()
    ok(`never two channels ${i}: open count <= 1`, openChannels() <= 1)
    if (calls.length > 0 && calls[calls.length - 1].opened) {
      iteration(calls[calls.length - 1], [['host', { out: 'stat\n', code: 0 }]])
    }
    advance(2000); await flush()
  }

  // 10. Idle drop: a name not requested for IDLE_DROP_MS is removed from wanted.
  reset()
  const s10 = stream.createSampler({ host: 'h10', port: 22, username: 'u', label: 'h10' }, deps())
  s10.exec({ name: 'host', cmd: 'cat /proc/stat' })
  s10.exec({ name: 'ps', cmd: 'ps -eo ...' })
  advance(250); await flush()
  ok('idle drop: both in script initially',
    calls[0].script.includes('S host') &&
    calls[0].script.includes('S ps'))
  iteration(calls[0], [['host', { out: 'stat\n', code: 0 }], ['ps', { out: 'p\n', code: 0 }]])
  for (let i = 0; i < 15; i++) {
    s10.exec({ name: 'host', cmd: 'cat /proc/stat' })
    advance(2100); await flush()
    if (calls.length > 0 && calls[calls.length - 1].opened) {
      iteration(calls[calls.length - 1], [['host', { out: 'stat\n', code: 0 }]])
    }
  }
  s10.exec({ name: 'nv-gpu', cmd: 'nvidia-smi' })
  advance(250); await flush()
  ok('idle drop: newest call includes nv-gpu and host',
    calls[calls.length - 1].script.includes('S nv-gpu') &&
    calls[calls.length - 1].script.includes('S host'))
  ok('idle drop: newest call does NOT include ps (idle > 30s)',
    !calls[calls.length - 1].script.includes('S ps'))

  // 11. Old channel ignored: lines from a closed channel don't affect a new one.
  reset()
  const s11 = stream.createSampler({ host: 'h11', port: 22, username: 'u', label: 'h11' }, deps())
  s11.exec({ name: 'host', cmd: 'cat /proc/stat' })
  advance(250); await flush()
  iteration(calls[0], [['host', { out: 'good1\n', code: 0 }]])
  s11.exec({ name: 'nv-gpu', cmd: 'nvidia-smi' })
  advance(250); await flush()
  eq('old channel ignored: restart triggered', calls.length, 2)
  const nonce11_old = calls[0].script.split('@@')[1].split(' ')[0]
  calls[0].handlers.onLine(`@@${nonce11_old} B`)
  calls[0].handlers.onLine(`@@${nonce11_old} S host`)
  calls[0].handlers.onLine('BOGUS')
  calls[0].handlers.onLine(`@@${nonce11_old} E host 0`)
  calls[0].handlers.onLine(`@@${nonce11_old} Z`)
  calls[0].handlers.onClose(1)
  const nonce11_new = calls[1].script.split('@@')[1].split(' ')[0]
  calls[1].handlers.onLine(`@@${nonce11_new} B`)
  calls[1].handlers.onLine(`@@${nonce11_new} S host`)
  calls[1].handlers.onLine('good')
  calls[1].handlers.onLine(`@@${nonce11_new} E host 0`)
  calls[1].handlers.onLine(`@@${nonce11_new} S nv-gpu`)
  calls[1].handlers.onLine('g')
  calls[1].handlers.onLine(`@@${nonce11_new} E nv-gpu 0`)
  calls[1].handlers.onLine(`@@${nonce11_new} Z`)
  const p11_host = s11.exec({ name: 'host', cmd: 'cat /proc/stat' })
  const r11_host = await p11_host
  eq('old channel ignored: resolved from new channel', r11_host, 'good\n')

  // 12. Name added while opening: openMode='manual' so we can delay the open.
  reset()
  openMode = 'manual'
  const s12 = stream.createSampler({ host: 'h12', port: 22, username: 'u', label: 'h12' }, deps())
  s12.exec({ name: 'host', cmd: 'cat /proc/stat' })
  advance(250); await flush()
  eq('name while opening: open pending', calls.length, 1)
  eq('name while opening: not yet opened', calls[0].opened, false)
  s12.exec({ name: 'ps', cmd: 'ps -eo ...' })
  calls[0].resolveOpen({ close() { calls[0].closed++ } })
  advance(1); await flush()
  ok('name while opening: opened', calls[0].opened)
  iteration(calls[0], [['host', { out: 'h\n', code: 0 }]])
  advance(2100); await flush()
  s12.exec({ name: 'ps', cmd: 'ps -eo ...' })
  advance(250); await flush()
  eq('name while opening: restart triggered', calls.length, 2)
  iteration(calls[1], [['ps', { out: 'p\n', code: 0 }]])
  const p12_ps = s12.exec({ name: 'ps', cmd: 'ps -eo ...' })
  const r12_ps = await p12_ps
  eq('name while opening: resolved ps from new channel', r12_ps, 'p\n')

  // 13. stop(): pending execs are rejected; new execs after stop are rejected;
  //     the open channel is closed.
  reset()
  const s13 = stream.createSampler({ host: 'h13', port: 22, username: 'u', label: 'h13' }, deps())
  const p13_pending = s13.exec({ name: 'host', cmd: 'cat /proc/stat' })
  advance(250); await flush()
  ok('stop: channel opened', calls.length === 1 && calls[0].opened)
  s13.stop()
  const err13_pending = await rejects('stop: pending rejected', p13_pending, /stopped/)
  ok('stop: pending exec rejected', err13_pending && err13_pending.message.includes('stopped'))
  const p13_after = s13.exec({ name: 'host', cmd: 'cat /proc/stat' })
  const err13_after = await rejects('stop: exec after stop rejected', p13_after, /stopped/)
  ok('stop: exec after stop rejected', err13_after && err13_after.message.includes('stopped'))
  eq('stop: channel was closed', calls[0].closed, 1)

  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

// A test awaiting a promise nothing will settle drains the loop and exits 0, which run.js would count as a pass.
process.on('beforeExit', () => { console.log('  FAIL harness hung: event loop drained before the test finished'); process.exit(1) })
main().catch((err) => { console.log('  FAIL harness crashed:', err && err.stack || err); process.exit(1) })
