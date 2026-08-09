// Naming consumer AMD cards that sysfs can only describe by device ID.
//
// The first fixture is a real capture: RX 9070 XT, ROCm 7.2, rocm-smi 4.0.0,
// hand-run 2026-08-09. Note the kernel exposes it at /sys/class/drm/card1 while
// rocm-smi calls it card0 -- that mismatch is the whole reason the join is on
// PCI bus, and the two-card fixture below is what pins it down.
const names = require('../src/collectors/amd-names.js')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}
function eq(label, got, want) {
  const good = got === want
  if (good) pass++
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const REAL_9070XT = JSON.stringify({
  card0: {
    'PCI Bus': '0000:2D:00.0',
    'Card Series': 'AMD Radeon RX 9070 XT',
    'Card Model': '0x7550',
    'Card Vendor': 'Advanced Micro Devices, Inc. [AMD/ATI]',
    'Card SKU': '1E490TX',
    'GFX Version': 'gfx1201'
  }
})

console.log('real RX 9070 XT capture:')
{
  const map = names.buildMap(REAL_9070XT)
  eq('one card mapped', map.size, 1)
  eq('keyed by lowercased bus', map.get('0000:2d:00.0'), 'AMD Radeon RX 9070 XT')
  ok('the uppercase form is not a separate key', !map.has('0000:2D:00.0'))
}

console.log('replaces the device-ID fallback:')
{
  // What amd-sysfs.js produces for this card: uuid from PCI_SLOT_NAME, name from
  // the PCI_ID second field, because product_name does not exist on the card.
  const gpus = [{ uuid: 'AMD-0000:2d:00.0', name: 'AMD GPU 7550' }]
  names.applyNames(gpus, names.buildMap(REAL_9070XT))
  eq('7550 -> the real board', gpus[0].name, 'AMD Radeon RX 9070 XT')
}

console.log('never overwrites a name a collector already resolved:')
{
  const gpus = [{ uuid: 'AMD-0000:2d:00.0', name: 'Instinct MI210' }]
  names.applyNames(gpus, names.buildMap(REAL_9070XT))
  eq('product_name wins', gpus[0].name, 'Instinct MI210')
}

// The case the bus join exists for. rocm-smi enumerates from card0; DRM does not
// have to. Here rocm-smi's card0 is the SECOND drm card, so joining on index or
// on array position swaps the two names. Joining on bus cannot.
console.log('two cards, rocm-smi order reversed vs drm order:')
{
  const TWO = JSON.stringify({
    card0: { 'PCI Bus': '0000:C1:00.0', 'Card Series': 'AMD Radeon RX 7900 XTX', 'Card Model': '0x744c' },
    card1: { 'PCI Bus': '0000:2D:00.0', 'Card Series': 'AMD Radeon RX 9070 XT', 'Card Model': '0x7550' }
  })
  const gpus = [
    { uuid: 'AMD-0000:2d:00.0', name: 'AMD GPU 7550' },
    { uuid: 'AMD-0000:c1:00.0', name: 'AMD GPU 744c' }
  ]
  names.applyNames(gpus, names.buildMap(TWO))
  eq('drm card 0 keeps its own identity', gpus[0].name, 'AMD Radeon RX 9070 XT')
  eq('drm card 1 keeps its own identity', gpus[1].name, 'AMD Radeon RX 7900 XTX')
  ok('an index join would have swapped these', gpus[0].name !== 'AMD Radeon RX 7900 XTX')
}

console.log('a hex Card Model is not an improvement:')
{
  // parseRocmSmi falls back to Card Model when Card Series is absent. That is the
  // same hex we are trying to get rid of, so it must not be adopted as a name.
  const HEXONLY = JSON.stringify({ card0: { 'PCI Bus': '0000:2D:00.0', 'Card Model': '0x7550' } })
  const gpus = [{ uuid: 'AMD-0000:2d:00.0', name: 'AMD GPU 7550' }]
  names.applyNames(gpus, names.buildMap(HEXONLY))
  eq('left alone', gpus[0].name, 'AMD GPU 7550')
}

console.log('degrades quietly, never throws:')
{
  eq('garbage json -> empty map', names.buildMap('not json at all').size, 0)
  eq('empty string -> empty map', names.buildMap('').size, 0)
  eq('no bus field -> unmapped', names.buildMap(JSON.stringify({ card0: { 'Card Series': 'X' } })).size, 0)

  const gpus = [{ uuid: 'AMD-0000:2d:00.0', name: 'AMD GPU 7550' }]
  names.applyNames(gpus, new Map())
  eq('empty map leaves names alone', gpus[0].name, 'AMD GPU 7550')
  ok('applyNames tolerates a non-array', names.applyNames(null, new Map()) === null)
}

console.log('enrich() skips the probe when there is nothing to fix:')
{
  // hostEntry has no label and no local flag, so a probe would attempt a real ssh
  // connection and reject. enrich must never get that far when all names are real.
  const result = { gpus: [{ uuid: 'AMD-0000:2d:00.0', name: 'Instinct MI210' }], processes: [] }
  names.enrich({}, result)
    .then(r => {
      eq('unchanged', r.gpus[0].name, 'Instinct MI210')
      console.log(`\n${pass} passed, ${fail} failed`)
      process.exit(fail ? 1 : 0)
    })
    .catch(e => {
      console.log(`  FAIL enrich rejected: ${e.message}`)
      console.log(`\n${pass} passed, ${fail + 1} failed`)
      process.exit(1)
    })
}
