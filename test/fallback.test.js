// Backend fallback tests. A GPU tool being installed does not mean it works: a
// real ROCm 7.2 box had rocm-smi in PATH but aborting mid-query, while the amdgpu
// sysfs tree held complete telemetry. A present-but-broken tool must never take a
// host down while a working one sits behind it.
const { planSlots, pollSlot } = require('../src/collectors/service.js')

let pass = 0, fail = 0
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const HOST = { label: 'test' }
const card = (index) => ({ gpus: [{ index }], processes: [] })
const boom = (msg) => () => Promise.reject(new Error(msg))
const nothing = () => Promise.resolve({ gpus: [], processes: [] })

console.log('slot planning:')
eq('nvidia alone', planSlots(['nvidia']), [['nvidia']])
eq('amd tools collapse into ONE slot', planSlots(['amd-smi', 'amd-sysfs', 'rocm-smi']), [['amd-smi', 'amd-sysfs', 'rocm-smi']])
eq('mixed host gets two slots', planSlots(['nvidia', 'amd-sysfs']), [['nvidia'], ['amd-sysfs']])
eq('amd order is priority, not detection order', planSlots(['rocm-smi', 'amd-sysfs']), [['amd-sysfs', 'rocm-smi']])
eq('nothing detected', planSlots([]), [])

// The exact shape of the real failure: rocm-smi installed, crashing, sysfs fine.
async function main() {
  console.log('\nbroken rocm-smi must fall through to sysfs:')
  let state = { chosen: {} }
  const pollers = {
    'rocm-smi': boom('Command exited 134'),
    'amd-sysfs': () => Promise.resolve(card(0)),
  }
  const r = await pollSlot(HOST, ['amd-sysfs', 'rocm-smi'], pollers, state)
  eq('sysfs served the cards', r.backend, 'amd-sysfs')
  eq('one card returned', r.result.gpus.length, 1)
  eq('slot winner remembered', state.chosen.amd, 'amd-sysfs')

  console.log('\nremembered winner is tried first (no re-walk each tick):')
  const calls = []
  const counting = {
    'amd-smi': () => { calls.push('amd-smi'); return Promise.resolve(card(0)) },
    'amd-sysfs': () => { calls.push('amd-sysfs'); return Promise.resolve(card(0)) },
  }
  state = { chosen: { amd: 'amd-sysfs' } }
  await pollSlot(HOST, ['amd-smi', 'amd-sysfs'], counting, state)
  eq('only the remembered backend ran', calls, ['amd-sysfs'])

  console.log('\na backend that stops working is demoted:')
  state = { chosen: { amd: 'rocm-smi' } }
  const flaky = { 'rocm-smi': boom('gone'), 'amd-sysfs': () => Promise.resolve(card(0)) }
  const r2 = await pollSlot(HOST, ['amd-sysfs', 'rocm-smi'], flaky, state)
  eq('fell back on the spot', r2.backend, 'amd-sysfs')
  eq('winner replaced', state.chosen.amd, 'amd-sysfs')
  eq('failure is reported as a warning', r2.notes.some(n => n.includes('rocm-smi')), true)

  console.log('\nparses fine but reports zero cards -> keep looking:')
  state = { chosen: {} }
  const r3 = await pollSlot(HOST, ['rocm-smi', 'amd-sysfs'], { 'rocm-smi': nothing, 'amd-sysfs': () => Promise.resolve(card(0)) }, state)
  eq('preferred the backend with actual cards', r3.backend, 'amd-sysfs')

  console.log('\nevery candidate empty -> empty result, not a thrown host:')
  state = { chosen: {} }
  const r4 = await pollSlot(HOST, ['rocm-smi', 'amd-sysfs'], { 'rocm-smi': nothing, 'amd-sysfs': nothing }, state)
  eq('no cards', r4.result.gpus.length, 0)
  eq('nothing cached as a winner', state.chosen.amd, undefined)

  console.log('\nevery candidate throws -> slot fails, message names both:')
  state = { chosen: {} }
  let threw = null
  try {
    await pollSlot(HOST, ['amd-sysfs', 'rocm-smi'], { 'amd-sysfs': boom('no such file'), 'rocm-smi': boom('exited 134') }, state)
  } catch (err) {
    threw = err.message
  }
  eq('threw', threw !== null, true)
  eq('names amd-sysfs', threw.includes('amd-sysfs'), true)
  eq('names rocm-smi', threw.includes('rocm-smi'), true)

  console.log('\nmissing poller is skipped, not fatal:')
  state = { chosen: {} }
  const r5 = await pollSlot(HOST, ['amd-smi', 'amd-sysfs'], { 'amd-sysfs': () => Promise.resolve(card(0)) }, state)
  eq('served by the backend that exists', r5.backend, 'amd-sysfs')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
