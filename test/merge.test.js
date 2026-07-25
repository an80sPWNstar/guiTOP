// Mixed-vendor merge tests. One host can hold NVIDIA and AMD cards; each backend
// numbers its own cards from 0, so the merge shifts later backends past the
// earlier ones. Single-backend hosts must come through completely unchanged.
const { mergeBackendResults } = require('../src/collectors/service.js')

let pass = 0, fail = 0
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

console.log('merge (single backend must be untouched):')
const one = mergeBackendResults([{ gpus: [{ index: 0 }, { index: 1 }], processes: [{ pid: 1, gpuIndex: 1 }] }])
eq('indices unchanged', one.gpus.map(g => g.index), [0, 1])
eq('nativeIndex recorded', one.gpus.map(g => g.nativeIndex), [0, 1])
eq('process gpuIndex unchanged', one.processes.map(p => p.gpuIndex), [1])

console.log('merge (nvidia + amd on one host):')
const mix = mergeBackendResults([
  { gpus: [{ index: 0, vendor: 'nvidia' }, { index: 1, vendor: 'nvidia' }], processes: [{ pid: 10, gpuIndex: 0 }] },
  {
    gpus: [{ index: 0, vendor: 'amd' }, { index: 1, vendor: 'amd' }],
    processes: [{ pid: 20, gpuIndex: 0 }, { pid: 21, gpuIndex: 1 }, { pid: 22, gpuIndex: null }],
  },
])
eq('display indices are unique', mix.gpus.map(g => g.index), [0, 1, 2, 3])
eq('native indices preserved', mix.gpus.map(g => g.nativeIndex), [0, 1, 0, 1])
eq('vendors preserved', mix.gpus.map(g => g.vendor), ['nvidia', 'nvidia', 'amd', 'amd'])
eq('processes remapped, null stays null', mix.processes.map(p => p.gpuIndex), [0, 2, 3, null])

console.log('merge (edge cases):')
const gap = mergeBackendResults([{ gpus: [], processes: [] }, { gpus: [{ index: 0 }], processes: [] }])
eq('empty backend causes no shift', gap.gpus.map(g => g.index), [0])

const sparse = mergeBackendResults([
  { gpus: [{ index: 0 }, { index: 2 }], processes: [] },
  { gpus: [{ index: 0 }], processes: [] },
])
eq('offset clears the highest native index', sparse.gpus.map(g => g.index), [0, 2, 3])

eq('no backends at all', mergeBackendResults([]).gpus, [])
eq('null part skipped', mergeBackendResults([null, { gpus: [{ index: 0 }], processes: [] }]).gpus.length, 1)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
