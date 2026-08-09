// Guards that remote commands survive a non-POSIX login shell.
//
// ssh runs the command string under the remote user's LOGIN shell, not sh. On a
// host whose login shell is fish (CachyOS/Arch installs it by default), the
// `for ...; do ...; done` in PROBE_CMD is a parse error: exit 127, nothing runs,
// and the host reports as down. posixWrap() is what stops that.
//
// The sh assertions run everywhere. The fish assertions self-skip if fish is not
// installed, so this file is safe on a bash-only CI box.
const { execFileSync } = require('child_process')
const { posixWrap } = require('../src/collectors/ssh.js')
const vendor = require('../src/collectors/vendor.js')
const sysfs = require('../src/collectors/amd-sysfs.js')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}

// Simulate sshd: it runs `<login-shell> -c "<string>"` with no extra quoting.
function viaLoginShell(shell, command) {
  return execFileSync(shell, ['-c', posixWrap(command)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function which(bin) {
  try { return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() }
  catch { return null }
}

console.log('wrapper shape:')
ok('wraps in sh -c', posixWrap('echo hi').startsWith("sh -c '"))
ok('closes its quote', posixWrap('echo hi').endsWith("'"))
ok('escapes an embedded single quote', posixWrap("echo 'x'") === "sh -c 'echo '\\''x'\\'''")

console.log('round-trips through /bin/sh:')
ok('simple command', viaLoginShell('/bin/sh', 'echo hi').trim() === 'hi')
ok('embedded single quote', viaLoginShell('/bin/sh', `echo "it's fine"`).trim() === "it's fine")
ok('inner shell owns expansion', viaLoginShell('/bin/sh', 'echo ${NOPE:-ok}').trim() === 'ok')
ok('backslash escapes survive', viaLoginShell('/bin/sh', `printf 'a\\tb'`) === 'a\tb')

console.log('the real command constants parse:')
for (const [name, cmd] of [['PROBE_CMD', vendor.PROBE_CMD], ['SYSFS_CMD', sysfs.SYSFS_CMD]]) {
  let exit = 0
  try { viaLoginShell('/bin/sh', cmd) } catch (e) { exit = e.status }
  ok(`${name} exits 0 under sh`, exit === 0)
}

const fish = which('fish')
if (!fish) {
  console.log('fish not installed -- non-POSIX login shell checks skipped')
} else {
  console.log('round-trips through fish (the shell that broke it):')
  for (const [name, cmd] of [['PROBE_CMD', vendor.PROBE_CMD], ['SYSFS_CMD', sysfs.SYSFS_CMD]]) {
    let exit = 0
    try { viaLoginShell(fish, cmd) } catch (e) { exit = e.status }
    ok(`${name} exits 0 wrapped`, exit === 0)
  }
  ok('embedded single quote', viaLoginShell(fish, `echo "it's fine"`).trim() === "it's fine")

  // The guard only means something if the unwrapped form genuinely fails here.
  let bare = 0
  try {
    execFileSync(fish, ['-c', vendor.PROBE_CMD], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) { bare = e.status }
  ok('unwrapped PROBE_CMD still fails under fish (regression is real)', bare !== 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
