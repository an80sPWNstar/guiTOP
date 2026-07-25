// Fixture tests for the amdgpu sysfs collector. No hardware needed.
const sysfs = require('../src/collectors/amd-sysfs.js')

let pass = 0, fail = 0
function eq(label, got, want) {
  if (got === want) pass++
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

// card0 = AMD, fully populated. card1 = NVIDIA (must be dropped).
// card2 = AMD, sparse: no power1_average, no fan1_max, bogus freq1_input.
// Plus connector-path noise that must be ignored.
const DUMP = [
  '/sys/class/drm/card0/device/gpu_busy_percent:42',
  '/sys/class/drm/card0/device/mem_busy_percent:17',
  '/sys/class/drm/card0/device/mem_info_vram_used:3221225472',
  '/sys/class/drm/card0/device/mem_info_vram_total:25757220864',
  '/sys/class/drm/card0/device/product_name:AMD Radeon RX 7900 XTX',
  '/sys/class/drm/card0/device/hwmon/hwmon2/temp1_input:52000',
  '/sys/class/drm/card0/device/hwmon/hwmon2/temp1_label:edge',
  '/sys/class/drm/card0/device/hwmon/hwmon2/power1_average:145000000',
  '/sys/class/drm/card0/device/hwmon/hwmon2/power1_cap:355000000',
  '/sys/class/drm/card0/device/hwmon/hwmon2/fan1_input:1180',
  '/sys/class/drm/card0/device/hwmon/hwmon2/fan1_max:3200',
  '/sys/class/drm/card0/device/hwmon/hwmon2/freq1_input:2394000000',
  '/sys/class/drm/card0/device/uevent:DRIVER=amdgpu',
  '/sys/class/drm/card0/device/uevent:PCI_CLASS=30000',
  '/sys/class/drm/card0/device/uevent:PCI_ID=1002:744C',
  '/sys/class/drm/card0/device/uevent:PCI_SLOT_NAME=0000:03:00.0',
  '/sys/class/drm/card0/device/pp_dpm_sclk:0: 500Mhz',
  '/sys/class/drm/card0/device/pp_dpm_sclk:1: 2394Mhz *',
  '/sys/class/drm/card0-DP-1/status:connected',
  '/sys/class/drm/card1/device/uevent:DRIVER=nvidia',
  '/sys/class/drm/card1/device/uevent:PCI_ID=10DE:2684',
  '/sys/class/drm/card1/device/uevent:PCI_SLOT_NAME=0000:01:00.0',
  '/sys/class/drm/card2/device/gpu_busy_percent:0',
  '/sys/class/drm/card2/device/mem_info_vram_used:268435456',
  '/sys/class/drm/card2/device/mem_info_vram_total:17163091968',
  '/sys/class/drm/card2/device/hwmon/hwmon3/temp1_input:34500',
  '/sys/class/drm/card2/device/hwmon/hwmon3/power1_input:22000000',
  '/sys/class/drm/card2/device/hwmon/hwmon3/fan1_input:900',
  '/sys/class/drm/card2/device/hwmon/hwmon3/freq1_input:0',
  '/sys/class/drm/card2/device/uevent:DRIVER=amdgpu',
  '/sys/class/drm/card2/device/uevent:PCI_ID=1002:73DF',
  '/sys/class/drm/card2/device/uevent:PCI_SLOT_NAME=0000:0a:00.0',
  '/sys/class/drm/card2/device/pp_dpm_sclk:0: 500Mhz *',
  '/sys/class/drm/card2/device/pp_dpm_sclk:1: 2575 MHz',
  '',
].join('\n')

console.log('amdgpu sysfs:')
const g = sysfs.parseSysfs(DUMP)
eq('non-amdgpu card dropped (2 of 3 kept)', g.length, 2)
if (g.length === 2) {
  eq('[0] index', g[0].index, 0)
  eq('[0] name', g[0].name, 'AMD Radeon RX 7900 XTX')
  eq('[0] uuid from PCI_SLOT_NAME', g[0].uuid, 'AMD-0000:03:00.0')
  eq('[0] utilization', g[0].utilization, 42)
  eq('[0] memoryUsed MiB', g[0].memoryUsed, 3072)
  eq('[0] memoryTotal MiB', g[0].memoryTotal, 24564)
  eq('[0] temperature millideg->C', g[0].temperature, 52)
  eq('[0] powerDraw uW->W', g[0].powerDraw, 145)
  eq('[0] powerLimit uW->W', g[0].powerLimit, 355)
  eq('[0] fanSpeed rpm/max->pct', g[0].fanSpeed, 37)
  eq('[0] clockSm Hz->MHz', g[0].clockSm, 2394)
  eq('[0] vendor', g[0].vendor, 'amd')

  eq('[1] index (card2, gap preserved)', g[1].index, 2)
  eq('[1] name from PCI_ID', g[1].name, 'AMD GPU 73DF')
  eq('[1] utilization zero survives', g[1].utilization, 0)
  eq('[1] powerDraw falls back to power1_input', g[1].powerDraw, 22)
  eq('[1] powerLimit missing -> null', g[1].powerLimit, null)
  eq('[1] fanSpeed no max -> null (not raw RPM)', g[1].fanSpeed, null)
  eq('[1] clockSm bogus freq -> starred pp_dpm', g[1].clockSm, 500)
  eq('[1] memoryTotal MiB', g[1].memoryTotal, 16368)
}

// A capture with no uevent at all must still be kept (partial dump tolerance).
const NO_UEVENT = [
  '/sys/class/drm/card0/device/gpu_busy_percent:55',
  '/sys/class/drm/card0/device/mem_info_vram_total:17163091968',
].join('\n')
console.log('partial dump (no uevent):')
const gp = sysfs.parseSysfs(NO_UEVENT)
eq('card kept', gp.length, 1)
if (gp.length) {
  eq('utilization', gp[0].utilization, 55)
  eq('uuid fallback', gp[0].uuid, 'AMD-card0')
  eq('name fallback', gp[0].name, 'AMD GPU')
}

// Case variants on the clock unit.
const CLOCK_CASE = [
  '/sys/class/drm/card0/device/uevent:DRIVER=amdgpu',
  '/sys/class/drm/card0/device/pp_dpm_sclk:0: 1800 MHz *',
].join('\n')
console.log('clock unit case/spacing:')
const gc = sysfs.parseSysfs(CLOCK_CASE)
eq('uppercase MHz with space', gc.length === 1 ? gc[0].clockSm : null, 1800)

console.log('robustness:')
eq('empty', sysfs.parseSysfs('').length, 0)
eq('null', sysfs.parseSysfs(null).length, 0)
eq('garbage', sysfs.parseSysfs('total nonsense\nno colons here').length, 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
