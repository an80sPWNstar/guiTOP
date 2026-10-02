// The collector tick loop must never overlap itself. A tick that runs long
// (a hung host, a slow SSH handshake) delays the next tick; it does not stack
// a second one on top. setInterval cannot express that, so the loop is a
// self-rescheduling setTimeout, exported as runLoop for this test.

const service = require('../src/collectors/service')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
  eq('runLoop exported', typeof service.runLoop, 'function')
  eq('DEFAULT_INTERVAL is 1000', service.DEFAULT_INTERVAL, 1000)
  eq('REMOTE_INTERVAL is 2000', service.REMOTE_INTERVAL, 2000)

  // 1. Slow tick, short interval: ticks serialize, never overlap.
  let inFlight = 0, maxInFlight = 0, ticks = 0
  const slow = service.runLoop(async () => {
    inFlight++; ticks++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await sleep(60)
    inFlight--
  }, 10)
  await sleep(250)
  slow.stop()
  const ticksAtStop = ticks
  eq('slow tick: never overlapped', maxInFlight, 1)
  ok(`slow tick: ran more than once (${ticks})`, ticks >= 2)
  ok(`slow tick: fewer than a setInterval would have fired (${ticks})`, ticks <= 5)
  await sleep(150)
  eq('slow tick: nothing fires after stop', ticks, ticksAtStop)

  // 2. First tick is deferred (caller gets the handle before it fires), then
  //    the interval is measured from the END of the previous tick.
  const stamps = []
  const fast = service.runLoop(async () => { stamps.push(Date.now()); await sleep(30) }, 50)
  eq('deferred first tick: nothing synchronous', stamps.length, 0)
  await sleep(260)
  fast.stop()
  ok(`gap = interval + tick duration (${stamps.length} ticks)`, stamps.length >= 2 && stamps.length <= 4)
  if (stamps.length >= 2) {
    const gap = stamps[1] - stamps[0]
    ok(`gap ~80ms, not 50 (${gap}ms)`, gap >= 70 && gap < 200)
  }

  // 3. A throwing tick does not kill the loop.
  let n = 0
  const throwing = service.runLoop(async () => { n++; if (n === 1) throw new Error('first tick blew up') }, 10)
  await sleep(120)
  throwing.stop()
  ok(`throwing tick: loop survived (${n} ticks)`, n >= 3)

  // 3b. A synchronously-throwing (non-async) tick is also survivable.
  let m = 0
  const syncThrow = service.runLoop(() => { m++; if (m === 1) throw new Error('sync blow up') }, 10)
  await sleep(100)
  syncThrow.stop()
  ok(`sync-throwing tick: loop survived (${m} ticks)`, m >= 3)

  // 4. stop() during an in-flight tick: that tick finishes, no further tick.
  let k = 0
  let handle
  handle = service.runLoop(async () => { k++; await sleep(40); if (k === 1) handle.stop() }, 5)
  await sleep(200)
  eq('stop mid-tick: exactly one tick', k, 1)

  // 5. stop() is idempotent.
  const idem = service.runLoop(async () => {}, 10)
  idem.stop(); idem.stop()
  ok('stop twice does not throw', true)

  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

// A test awaiting a promise nothing will settle drains the loop and exits 0, which run.js would count as a pass.
process.on('beforeExit', () => { console.log('  FAIL harness hung: event loop drained before the test finished'); process.exit(1) })
main().catch((err) => { console.log('  FAIL harness crashed:', err && err.stack || err); process.exit(1) })
