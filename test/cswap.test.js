// cswap invocation + `cswap auto` detection.
//
// The command-line matching here is the whole feature: cswap is installed by
// `uv tool install`, so a running `cswap auto` shows up as python.exe and the
// process NAME says nothing. Fixtures below are real command lines.

const { cswapCmd } = require('../src/collectors/cswap-cmd')
const { parseSwap, parsePsDate, isoMs, isAutoCmdline, readAuto } = require('../src/collectors/claude-swap')

let pass = 0, fail = 0
function eq(label, got, want) {
  if (got === want) pass++
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

console.log('cswap invocation is per-platform:')

const win = cswapCmd(['list', '--json'])
const nix = cswapCmd(['list', '--json'])
// cswapCmd branches on the live platform, so only one branch is observable here.
if (process.platform === 'win32') {
  eq('windows goes through cmd.exe', win.file, 'cmd.exe')
  eq('windows args start with /c', win.args[0], '/c')
  eq('windows args name cswap', win.args[1], 'cswap')
  eq('windows passes the caller args through', win.args.slice(2).join(' '), 'list --json')
} else {
  eq('non-windows calls cswap directly', nix.file, 'cswap')
  eq('non-windows passes only the caller args', nix.args.join(' '), 'list --json')
}
eq('caller array is copied, not aliased', cswapCmd([]).args === cswapCmd([]).args, false)
eq('no shell metacharacters in the fixed parts', /[;&|`$]/.test(win.file + win.args.slice(0, 2).join(' ')), false)

console.log('PowerShell date shapes:')

// Windows PowerShell 5.1 and PowerShell 7 disagree on DateTime serialisation.
eq('PS 5.1 /Date(ms)/ epoch form', parsePsDate('/Date(1769000000000)/'), 1769000000000)
eq('PS 5.1 form with timezone suffix', parsePsDate('/Date(1769000000000+0000)/'), 1769000000000)
eq('PS 7 ISO form', parsePsDate('2026-07-27T12:00:00.000Z'), Date.parse('2026-07-27T12:00:00.000Z'))
eq('garbage is null, not NaN', parsePsDate('not a date'), null)
eq('missing is null', parsePsDate(undefined), null)
eq('non-string is null', parsePsDate(1769000000000), null)

console.log('command-line matching:')

const UV_AUTO = '"C:\\Users\\B\\AppData\\Local\\uv\\cache\\archive-v0\\X\\Scripts\\python.exe" "C:\\Users\\B\\AppData\\Local\\uv\\cache\\archive-v0\\X\\Scripts\\cswap.exe" auto --interval 60'
const UV_LIST = '"C:\\...\\python.exe" "C:\\...\\Scripts\\cswap.exe" list --json'
const SHIM_AUTO = 'cswap.exe auto'
const LINUX_AUTO = '4711 /home/b/.local/bin/cswap auto --threshold 90'

eq('uv-launched auto loop matches', isAutoCmdline(UV_AUTO), true)
eq('bare shim auto matches', isAutoCmdline(SHIM_AUTO), true)
eq('linux pgrep line matches', isAutoCmdline(LINUX_AUTO), true)
eq('a cswap call that is not auto does not match', isAutoCmdline(UV_LIST), false)
eq('an unrelated python process does not match', isAutoCmdline('"python.exe" "blender-mcp.exe"'), false)
// A directory called autodev must not read as the auto subcommand.
eq('auto as a name prefix does not match', isAutoCmdline('"python.exe" "C:\\autodev-studio\\cswap.exe" list'), false)
eq('auto inside a path segment does not match', isAutoCmdline('"python.exe" "C:\\cswap\\automation\\run.exe"'), false)
eq('non-string is false', isAutoCmdline(null), false)

console.log('readAuto over a CIM payload:')

const NOW = Date.parse('2026-07-27T12:00:00Z')
const started = NOW - 23 * 60000

const rows = [
  { ProcessId: 1, CommandLine: UV_LIST, CreationDate: '/Date(' + started + ')/' },
  { ProcessId: 2, CommandLine: UV_AUTO, CreationDate: '/Date(' + started + ')/' },
]
eq('finds the auto process among others', readAuto(rows, NOW).autoOn, true)
eq('reports whole minutes since start', readAuto(rows, NOW).autoSinceMin, 23)

eq('no auto process -> off', readAuto([{ CommandLine: UV_LIST }], NOW).autoOn, false)
eq('no auto process -> null age', readAuto([{ CommandLine: UV_LIST }], NOW).autoSinceMin, null)
eq('empty payload -> off', readAuto([], NOW).autoOn, false)
// ConvertTo-Json emits a bare null when the CIM query matches nothing at all.
eq('null row is skipped, not dereferenced', readAuto([null], NOW).autoOn, false)
eq('running but undateable is still on', readAuto([{ CommandLine: UV_AUTO }], NOW).autoOn, true)
eq('undateable start -> null age, not NaN', readAuto([{ CommandLine: UV_AUTO }], NOW).autoSinceMin, null)
// A clock that moved backwards must not surface a negative uptime.
eq('start in the future clamps to 0',
  readAuto([{ CommandLine: UV_AUTO, CreationDate: '/Date(' + (NOW + 60000) + ')/' }], NOW).autoSinceMin, 0)

console.log('parseSwap usage + reset fields:')

// A real-shaped cswap list: one healthy account, one the usage endpoint refused
// (usage null, usageStatus 'unavailable') — the case the all-accounts view must
// render as "no data" rather than 0%.
const SWAP_JSON = JSON.stringify({
  activeAccountNumber: 1,
  accounts: [
    {
      number: 1, active: true, alias: 'cinchit', usageStatus: 'ok',
      usage: {
        fiveHour: { pct: 18, resetsAt: '2026-08-07T03:09:59+00:00' },
        sevenDay: { pct: 59, resetsAt: '2026-08-07T01:59:59+00:00' },
      },
    },
    { number: 2, active: false, alias: 'drcu', usageStatus: 'unavailable', usage: null },
  ],
})
const parsed = parseSwap(SWAP_JSON)
eq('active account number carried', parsed.activeNumber, 1)
eq('healthy account keeps its pct', parsed.accounts[0].fiveHourPct, 18)
eq('healthy account status ok', parsed.accounts[0].usageStatus, 'ok')
eq('reset ISO becomes epoch ms', parsed.accounts[0].fiveHourResetMs, Date.parse('2026-08-07T03:09:59+00:00'))
eq('seven-day reset ms too', parsed.accounts[0].sevenDayResetMs, Date.parse('2026-08-07T01:59:59+00:00'))
eq('unavailable account pct is null', parsed.accounts[1].fiveHourPct, null)
eq('unavailable status surfaced', parsed.accounts[1].usageStatus, 'unavailable')
eq('null usage -> null reset ms', parsed.accounts[1].fiveHourResetMs, null)
// A payload with no usageStatus field at all: derive it from whether usage exists.
const derived = parseSwap(JSON.stringify({ accounts: [{ number: 3, usage: null }] }))
eq('missing usageStatus derived from null usage', derived.accounts[0].usageStatus, 'unavailable')

eq('isoMs parses ISO', isoMs('2026-08-07T03:09:59+00:00'), Date.parse('2026-08-07T03:09:59+00:00'))
eq('isoMs garbage is null', isoMs('nope'), null)
eq('isoMs non-string is null', isoMs(1769000000000), null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
