// Host CPU/RAM sampling: the /proc parsers, the delta arithmetic, and the
// states where there is deliberately no answer.
//
// The CPU half is a rate derived from two cumulative samples, so most of what
// can go wrong is about the SECOND sample -- a first tick, a repeated tick, a
// rebooted host whose counters restarted. Each of those must read as null, not
// as 0%, because 0% is a claim that the machine is idle.

const hs = require('../src/collectors/host-stats')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)})`, actual === expected)
}

// A real /proc/stat head: aggregate line, per-core lines, then the counters that
// follow. The parser must take the aggregate and stop.
const PROC_STAT = `cpu  2255 34 2290 22625563 6290 127 456 0 0 0
cpu0 1132 34 1441 11311718 3675 0 0 0 0 0
cpu1 1123 0 849 11313845 2614 127 456 0 0 0
intr 114930548 113199788 3 0 0 0
ctxt 1990473
btime 1418183276
processes 2915
procs_running 2
procs_blocked 0`

const MEMINFO = `MemTotal:       65393072 kB
MemFree:         2158060 kB
MemAvailable:   41297632 kB
Buffers:         1234000 kB
Cached:         38000000 kB
SwapTotal:       8388604 kB
SwapFree:        8388604 kB`

console.log('/proc/stat parsing:')
const st = hs.parseProcStat(PROC_STAT)
ok('reads the aggregate line', st !== null)
// idle 22625563 + iowait 6290 -- iowait counts as idle, as top and nvitop do.
eq('idle includes iowait', st.idle, 22625563 + 6290)
eq('total sums every column', st.total, 2255 + 34 + 2290 + 22625563 + 6290 + 127 + 456)
ok('no cpu line is null, not a crash', hs.parseProcStat('intr 5\nctxt 9') === null)
ok('garbage columns are null', hs.parseProcStat('cpu  a b c d') === null)
// 'cpu0 ...' must not satisfy the aggregate match, or a machine reads as one core.
const perCoreOnly = hs.parseProcStat('cpu0 1 2 3 4 5')
ok('a per-core line alone does not count as the aggregate', perCoreOnly === null)

console.log('meminfo parsing:')
const mem = hs.parseMeminfo(MEMINFO)
eq('total', mem.memTotalKb, 65393072)
eq('used is total minus available', mem.memUsedKb, 65393072 - 41297632)
// Pre-3.14 kernels have no MemAvailable; the sum is the documented fallback.
const old = hs.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 200 kB')
eq('falls back to free+buffers+cached', old.memUsedKb, 1000 - 350)
ok('no MemTotal is null', hs.parseMeminfo('MemFree: 100 kB') === null)
ok('empty output is null', hs.parseMeminfo('') === null)

console.log('cpu delta:')
eq('no previous sample is null', hs.cpuPercentFrom(null, { idle: 10, total: 20 }), null)
// Half the jiffies in the interval were idle.
eq('half idle is 50%', hs.cpuPercentFrom({ idle: 100, total: 200 }, { idle: 150, total: 300 }), 50)
eq('all idle is 0%', hs.cpuPercentFrom({ idle: 100, total: 200 }, { idle: 200, total: 300 }), 0)
eq('none idle is 100%', hs.cpuPercentFrom({ idle: 100, total: 200 }, { idle: 100, total: 300 }), 100)
eq('identical samples are null', hs.cpuPercentFrom({ idle: 100, total: 200 }, { idle: 100, total: 200 }), null)
// A reboot restarts the counters; the delta would go negative and read as a
// nonsense percentage, so it must be refused instead.
eq('counters going backwards is null', hs.cpuPercentFrom({ idle: 900, total: 5000 }, { idle: 10, total: 20 }), null)
eq('idle alone going backwards is null', hs.cpuPercentFrom({ idle: 100, total: 200 }, { idle: 90, total: 300 }), null)

console.log('remote sample, two ticks:')
const state = {}
const first = hs.parseRemote(PROC_STAT + '\n' + MEMINFO, state)
eq('first tick has memory', first.memTotalKb, 65393072)
eq('first tick cpu is null, not zero', first.cpuPct, null)
ok('first tick stored a baseline', state.prevCpu !== null && state.prevCpu !== undefined)

// Second tick: 100 jiffies pass, 25 of them idle -> 75% busy.
const NEXT_STAT = PROC_STAT.replace(
  'cpu  2255 34 2290 22625563 6290',
  'cpu  2330 34 2290 22625588 6290'
)
const second = hs.parseRemote(NEXT_STAT + '\n' + MEMINFO, state)
eq('second tick has a percentage', second.cpuPct, 75)

// An unreadable tick must not be charged to the next good one as a spike.
const broken = hs.parseRemote('nothing useful here', state)
eq('unparseable output is null', broken, null)
ok('baseline was dropped', !state.prevCpu)
const afterBreak = hs.parseRemote(NEXT_STAT + '\n' + MEMINFO, state)
eq('tick after a break is null again, not a spike', afterBreak.cpuPct, null)

console.log('baseline source tagging:')
// /proc/stat counts jiffies and os.cpus() counts milliseconds, so a delta taken
// across a switch between them is arithmetic on two different units. It happens
// for real when /proc becomes unreadable mid-session and the local sampler falls
// back to the os path.
const mixed = {}
eq('first os sample is null', hs.baseline(mixed, 'os', { idle: 100, total: 200 }), null)
eq('same source deltas normally', hs.baseline(mixed, 'os', { idle: 150, total: 300 }), 50)
eq('switching source discards the baseline', hs.baseline(mixed, 'proc', { idle: 900, total: 1800 }), null)
eq('and the new source deltas from there', hs.baseline(mixed, 'proc', { idle: 950, total: 1900 }), 50)
eq('switching back discards again', hs.baseline(mixed, 'os', { idle: 10, total: 20 }), null)

console.log('local sample:')
const localState = {}
const l1 = hs.sampleLocal(localState)
ok('local reports memory', l1 && l1.memTotalKb > 0)
eq('local first tick cpu is null', l1.cpuPct, null)
const l2 = hs.sampleLocal(localState)
ok('local second tick has a percentage 0..100',
  l2.cpuPct === null || (l2.cpuPct >= 0 && l2.cpuPct <= 100))
ok('local memPct is a percentage', l1.memPct >= 0 && l1.memPct <= 100)

console.log('percent helper:')
eq('zero total is null, not a divide by zero', hs.memPct(100, 0), null)
eq('rounds to one decimal', hs.memPct(500, 1000), 50)

console.log('remote command:')
// ssh.js rejects a non-zero exit, and cat fails on a host with no /proc, which
// is a normal state for a non-Linux host rather than an error for the user.
ok('forces a zero exit', /;\s*true\s*$/.test(hs.HOST_STAT_CMD))
ok('reads both files in one call',
  hs.HOST_STAT_CMD.includes('/proc/stat') && hs.HOST_STAT_CMD.includes('/proc/meminfo'))
ok('is a fixed string with no interpolation', !hs.HOST_STAT_CMD.includes('$'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
