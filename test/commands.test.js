// Guards on the fixed remote command strings.
//
// ssh.js rejects whenever the remote command exits non-zero. Both of these
// commands end in a shell test that legitimately fails on a healthy machine
// (no amdgpu card found; pp_dpm_sclk absent), which would otherwise report the
// whole host as down. They must force a zero exit.
const vendor = require('../src/collectors/vendor.js')
const sysfs = require('../src/collectors/amd-sysfs.js')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}

console.log('remote command strings:')
ok('PROBE_CMD forces exit 0', /;\s*true\s*$/.test(vendor.PROBE_CMD))
ok('SYSFS_CMD forces exit 0', /;\s*true\s*$/.test(sysfs.SYSFS_CMD))

// No dynamic input may ever reach a remote shell (see CLAUDE.md code standards).
console.log('no interpolation:')
ok('PROBE_CMD has no template placeholder', !/\$\{/.test(vendor.PROBE_CMD))
ok('SYSFS_CMD has no template placeholder', !/\$\{/.test(sysfs.SYSFS_CMD))

console.log('probe covers every backend:')
for (const token of ['nvidia-smi', 'amd-smi', 'rocm-smi', 'amdgpu']) {
  ok(`PROBE_CMD mentions ${token}`, vendor.PROBE_CMD.includes(token))
}

console.log('backend labels:')
ok('nvidia', vendor.backendLabel('nvidia') === 'NVIDIA')
ok('amd-smi', vendor.backendLabel('amd-smi') === 'AMD (amd-smi)')
ok('rocm-smi', vendor.backendLabel('rocm-smi') === 'AMD (rocm-smi)')
ok('amd-sysfs', vendor.backendLabel('amd-sysfs') === 'AMD (sysfs)')
ok('unknown', vendor.backendLabel('nope') === 'unknown')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
