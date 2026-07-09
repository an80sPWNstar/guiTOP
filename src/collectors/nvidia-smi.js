// nvidia-smi command definitions + a local runner.
//
// SECURITY: the query strings are fixed and hard-coded. We invoke nvidia-smi via
// execFile with an ARGUMENT ARRAY (never a shell string), so nothing dynamic is
// ever interpolated into a command line. The SSH transport (ssh.js) runs these
// same fixed strings remotely.

const { execFile } = require('child_process')

// --query-gpu fields. `uuid` is included so we can map processes (which report
// gpu_uuid) back to a gpu index without a third query.
const GPU_FIELDS = [
  'index', 'uuid', 'name', 'utilization.gpu', 'memory.used', 'memory.total',
  'temperature.gpu', 'power.draw', 'power.limit', 'fan.speed', 'clocks.sm',
]

// --query-compute-apps fields (the per-process GPU memory users).
const PROC_FIELDS = ['gpu_uuid', 'pid', 'process_name', 'used_memory']

const FORMAT = ['--format=csv,noheader,nounits']

const gpuArgs = () => [`--query-gpu=${GPU_FIELDS.join(',')}`, ...FORMAT]
const procArgs = () => [`--query-compute-apps=${PROC_FIELDS.join(',')}`, ...FORMAT]

// Run a single nvidia-smi query on THIS machine. Resolves to stdout (string).
function execLocal(args) {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', args, { timeout: 8000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout)
    })
  })
}

// Fetch both queries locally. Returns { gpuCsv, procCsv }.
async function fetchLocal() {
  const [gpuCsv, procCsv] = await Promise.all([
    execLocal(gpuArgs()),
    execLocal(procArgs()),
  ])
  return { gpuCsv, procCsv }
}

// The exact shell-safe command strings for the SSH transport to run remotely.
// (ssh2 exec runs a command line on the remote shell; these contain no dynamic
// input, so they are safe as fixed strings.)
const GPU_CMD = `nvidia-smi ${gpuArgs().join(' ')}`
const PROC_CMD = `nvidia-smi ${procArgs().join(' ')}`

module.exports = {
  GPU_FIELDS, PROC_FIELDS,
  gpuArgs, procArgs,
  execLocal, fetchLocal,
  GPU_CMD, PROC_CMD,
}
