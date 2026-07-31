// Sample framing for the long-lived `nvidia-smi -l 1` children.
//
// nvidia-smi's loop mode prints the CSV header once, not per iteration, so
// there is no delimiter between samples. The framing rides on the `timestamp`
// query field instead: every row of one iteration carries the same value, and
// consecutive iterations never share one. Fixtures below are real lines from a
// 3-GPU box (RTX 5070 Ti / 5060 Ti / 3090).

const { createStream, splitStamped, flush, onLine } = require('../src/collectors/nvidia-stream')
const { parseGpus, parseProcesses } = require('../src/collectors/parse')

let pass = 0, fail = 0
function eq(label, got, want) {
  if (got === want) pass++
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const T1 = '2026/07/31 10:19:33.818'
const T2 = '2026/07/31 10:19:34.818'

// The one-shot query's output, which is what parse.js has always been fed.
const ONESHOT_GPU = [
  '0, GPU-e76160e9-98e5-cc0d-a023-13a77931092c, NVIDIA GeForce RTX 5070 Ti, 4, 1892, 16303, 42, 31.05, 300.00, 30, 1350',
  '1, GPU-f678240a-8f09-056f-bebb-51a5d42a8e1c, NVIDIA GeForce RTX 5060 Ti, 0, 512, 16311, 38, 12.40, 180.00, 0, 210',
  '2, GPU-7d90cee9-2e3a-80d8-7d1b-e1c5d50eaf94, NVIDIA GeForce RTX 3090, 97, 22110, 24576, 71, 348.22, 350.00, 78, 1935',
]

// The same rows as the loop child emits them, with timestamp leading.
const stamped = (t, rows) => rows.map(r => `${t}, ${r}`)

console.log('timestamp splitting:')

eq('stamp is the first field', splitStamped(`${T1}, 0, GPU-abc`).stamp, T1)
eq('rest is everything after it, leading space gone', splitStamped(`${T1}, 0, GPU-abc`).rest, '0, GPU-abc')
eq('a line with no comma is not a row', splitStamped('Unable to determine the device handle'), null)
eq('empty stamp field still splits', splitStamped(', 0').stamp, '')

console.log('a sample is published when the next one starts:')

const gpu = createStream('gpu', [])
for (const line of stamped(T1, ONESHOT_GPU)) onLine(gpu, line)

eq('an incomplete group publishes nothing', gpu.csv, null)
eq('rows are held pending', gpu.pending.length, 3)

// First row of the next iteration proves the previous one ended.
onLine(gpu, stamped(T2, ONESHOT_GPU)[0])

eq('previous sample is now complete', gpu.csv, ONESHOT_GPU.join('\n'))
eq('published CSV is byte-identical to the one-shot output', gpu.csv === ONESHOT_GPU.join('\n'), true)
eq('sample is timestamped', gpu.at > 0, true)
eq('the new iteration is already accumulating', gpu.pending.length, 1)

// The whole point of matching the one-shot bytes: the existing parser is untouched.
const fromStream = parseGpus(gpu.csv)
const fromOneShot = parseGpus(ONESHOT_GPU.join('\n'))
eq('parses to the same card count', fromStream.length, fromOneShot.length)
eq('parses to identical readings', JSON.stringify(fromStream), JSON.stringify(fromOneShot))
eq('index survives the round trip', fromStream[2].index, 2)
eq('uuid survives the round trip', fromStream[0].uuid, 'GPU-e76160e9-98e5-cc0d-a023-13a77931092c')
eq('a GPU name containing no comma is intact', fromStream[2].name, 'NVIDIA GeForce RTX 3090')

console.log('groups of differing length:')

// Compute-app rows vary in count between iterations, which is why line counting
// was never an option.
const PROC_A = [
  'GPU-e76160e9-98e5-cc0d-a023-13a77931092c, 17444, C:\\llama-server.exe, [N/A]',
  'GPU-f678240a-8f09-056f-bebb-51a5d42a8e1c, 11528, C:\\Windows\\explorer.exe, [N/A]',
  'GPU-7d90cee9-2e3a-80d8-7d1b-e1c5d50eaf94, 17444, C:\\llama-server.exe, [N/A]',
]
const PROC_B = ['GPU-e76160e9-98e5-cc0d-a023-13a77931092c, 17444, C:\\llama-server.exe, [N/A]']

const proc = createStream('proc', [])
for (const line of stamped(T1, PROC_A)) onLine(proc, line)
for (const line of stamped(T2, PROC_B)) onLine(proc, line)

eq('the three-row sample published in full', proc.csv, PROC_A.join('\n'))
eq('one row pending for the shorter iteration', proc.pending.length, 1)

flush(proc)
eq('a shorter following sample replaces it entirely', proc.csv, PROC_B.join('\n'))

const procs = parseProcesses(proc.csv, {})
eq('proc rows parse', procs.length, 1)
eq('pid survives the round trip', procs[0].pid, 17444)
eq('WDDM [N/A] memory is still null, not 0', procs[0].usedMemory, null)

console.log('flushing an empty group:')

const before = proc.csv
flush(proc)
eq('flushing nothing keeps the last good sample', proc.csv, before)

const fresh = createStream('gpu', [])
flush(fresh)
eq('flushing a never-fed stream publishes nothing', fresh.csv, null)
eq('and leaves no sample time', fresh.at, 0)

console.log('a dead child must not splice two samples together:')

// startStream's exit handler drops the half-read group; simulate that.
const torn = createStream('gpu', [])
onLine(torn, stamped(T1, ONESHOT_GPU)[0])
torn.pending = []
torn.stamp = null
for (const line of stamped(T2, ONESHOT_GPU)) onLine(torn, line)
flush(torn)
eq('only the complete iteration is published', torn.csv, ONESHOT_GPU.join('\n'))

console.log('blank lines are ignored:')

const blanks = createStream('gpu', [])
onLine(blanks, '')
onLine(blanks, '   ')
eq('whitespace does not start a group', blanks.pending.length, 0)
eq('and does not publish', blanks.csv, null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
