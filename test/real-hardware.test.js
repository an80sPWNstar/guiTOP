// Regression tests pinned to a REAL hardware capture: Sapphire Radeon RX 9070 XT
// (Navi 48, gfx1201, PCI 1002:7550) -- a DISCRETE card, not an APU. CachyOS,
// ROCm 7.2, rocm-smi 4.0.0 / rocm-smi-lib 7.8.0. The kernel exposes the GPU as
// card1 with NO product_name. Captured 2026-07-26 via tools/gpu-probe.js, plus a
// hand-run rocm-smi capture with the narrowed flag set on 2026-07-27.

const sysfs = require('../src/collectors/amd-sysfs.js')
const amdSmi = require('../src/collectors/amd-smi.js')

let pass = 0, fail = 0
function eq(label, got, want) {
  if (got === want) pass++
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const B = '/sys/class/drm/card1/device'
const H = B + '/hwmon/hwmon2'

// This card has no product_name file, so grep emits nothing for it at all.
const REAL = [
  `${B}/gpu_busy_percent:7`,
  `${B}/mem_busy_percent:1`,
  `${B}/mem_info_vram_used:1780375552`,
  `${B}/mem_info_vram_total:17095983104`,
  `${H}/temp1_input:32000`,
  `${H}/temp1_label:edge`,
  `${H}/power1_average:52000000`,
  `${H}/power1_cap:374000000`,
  `${H}/fan1_input:1533`,
  `${H}/fan1_max:5000`,
  `${H}/freq1_input:1943000000`,
  `${B}/uevent:DRIVER=amdgpu`,
  `${B}/uevent:PCI_CLASS=30000`,
  `${B}/uevent:PCI_ID=1002:7550`,
  `${B}/uevent:PCI_SUBSYS_ID=1DA2:E490`,
  `${B}/uevent:PCI_SLOT_NAME=0000:2d:00.0`,
  `${B}/uevent:MODALIAS=pci:v00001002d00007550sv00001DA2sd0000E490bc03sc00i00`,
  `${B}/pp_dpm_sclk:0: 500Mhz`,
  `${B}/pp_dpm_sclk:1: 1943Mhz *`,
  `${B}/pp_dpm_sclk:2: 2400Mhz`
].join('\n') + '\n'

console.log('real hardware (RX 9070 XT, sysfs):')
const g = sysfs.parseSysfs(REAL)
eq('one card found', g.length, 1)

if (g.length === 1) {
  eq('index is dense 0 even though DRM says card1', g[0].index, 0)
  eq('drmCard keeps the real DRM number', g[0].drmCard, 1)
  eq('utilization', g[0].utilization, 7)
  eq('memoryUsed bytes->MiB', g[0].memoryUsed, 1698)
  eq('memoryTotal bytes->MiB', g[0].memoryTotal, 16304)
  eq('temperature millideg->C (edge sensor)', g[0].temperature, 32)
  eq('powerDraw uW->W', g[0].powerDraw, 52)
  eq('powerLimit uW->W from power1_cap', g[0].powerLimit, 374)
  // This capture predates the probe dumping pwm1, so it can only exercise the RPM
  // fallback. The same card at the same instant read pwm1=89 / pwm1_max=255 = 35%,
  // which is what the reader now prefers and what rocm-smi reports below. Once a
  // capture with pwm1 lands here, this number becomes 35.
  eq('fanSpeed 1533/5000 rpm->pct (RPM fallback, no pwm1 in this capture)', g[0].fanSpeed, 31)
  eq('clockSm Hz->MHz, agrees with starred pp_dpm_sclk', g[0].clockSm, 1943)
  eq('uuid from PCI_SLOT_NAME', g[0].uuid, 'AMD-0000:2d:00.0')
  eq('vendor', g[0].vendor, 'amd')
  eq('no product_name -> name falls back to PCI device id', g[0].name, 'AMD GPU 7550')
}

console.log('rocm-smi command avoids the OD-clock crash path:')

// rocm-smi --showallinfo aborts on ROCm 7.2: an assertion fires inside
// get_od_clk_volt_info. We parse nothing from that table, so never ask for it.
eq('does not use --showallinfo', amdSmi.ROCM_CMD.includes('--showallinfo') === false, true)
eq('still asks for a product name', amdSmi.ROCM_CMD.includes('--showproductname') === true, true)
eq('still asks for temperature', amdSmi.ROCM_CMD.includes('--showtemp') === true, true)
eq('still asks for power', amdSmi.ROCM_CMD.includes('--showpower') === true, true)
eq('still asks for vram', amdSmi.ROCM_CMD.includes('--showmeminfo') === true, true)
eq('still json', amdSmi.ROCM_CMD.includes('--json') === true, true)
eq('no shell metacharacters', /[;&|`$]/.test(amdSmi.ROCM_CMD) === false, true)

console.log('real hardware (RX 9070 XT, rocm-smi narrowed flags):')

// Verbatim stdout of ROCM_CMD on that machine. Note rocm-smi calls the card
// "card0" while the DRM tree calls it card1 -- rocm-smi numbers its own list.
const REAL_ROCM = JSON.stringify({
  card0: {
    'Unique ID': '0xb5b82def8872709d',
    'Temperature (Sensor edge) (C)': '36.0',
    'Temperature (Sensor junction) (C)': '39.0',
    'Temperature (Sensor memory) (C)': '60.0',
    'dcefclk clock speed:': '(818Mhz)',
    'dcefclk clock level:': '1',
    'fclk clock speed:': '(2016Mhz)',
    'fclk clock level:': '1',
    'mclk clock speed:': '(1258Mhz)',
    'mclk clock level:': '5',
    'sclk clock speed:': '(1697Mhz)',
    'sclk clock level:': '1',
    'socclk clock speed:': '(1280Mhz)',
    'socclk clock level:': '1',
    'pcie clock level': '1 (16.0GT/s x16)',
    'Fan speed (level)': '89',
    'Fan speed (%)': '35',
    'Fan RPM': '1536',
    'Max Graphics Package Power (W)': '374.0',
    'Average Graphics Package Power (W)': '58.0',
    'GPU use (%)': '7',
    'VRAM Total Memory (B)': '17095983104',
    'VRAM Total Used Memory (B)': '2794479616',
    'Card Series': 'AMD Radeon RX 9070 XT',
    'Card Model': '0x7550',
    'Card Vendor': 'Advanced Micro Devices, Inc. [AMD/ATI]',
    'Card SKU': '1E490TX',
    'Subsystem ID': '-0x1b70',
    'Device Rev': '0xc0',
    'Node ID': '1',
    GUID: '58540',
    'GFX Version': 'gfx1201'
  }
})

const r = amdSmi.parseRocmSmi(REAL_ROCM)
eq('one card found', r.length, 1)

if (r.length === 1) {
  eq('index from card key', r[0].index, 0)
  eq('name prefers Card Series over Card Model', r[0].name, 'AMD Radeon RX 9070 XT')
  eq('uuid from Unique ID', r[0].uuid, '0xb5b82def8872709d')
  eq('utilization', r[0].utilization, 7)
  eq('memoryUsed bytes->MiB', r[0].memoryUsed, 2665)
  eq('memoryTotal bytes->MiB', r[0].memoryTotal, 16304)
  eq('temperature takes the edge sensor, not junction/memory', r[0].temperature, 36)
  eq('powerDraw from Average Graphics Package Power', r[0].powerDraw, 58)
  eq('powerLimit from Max Graphics Package Power', r[0].powerLimit, 374)
  // Both "Fan speed (level)" (raw PWM 0-255) and "Fan speed (%)" are present;
  // the percent must win no matter which key JSON order hands over first.
  eq('fanSpeed takes the percent, not the 0-255 level', r[0].fanSpeed, 35)
  eq('clockSm from sclk, not dcefclk/fclk/mclk/socclk', r[0].clockSm, 1697)
  eq('vendor', r[0].vendor, 'amd')
}

// Same key set, percent key removed: fall back to level/255.
const NO_PCT = JSON.parse(REAL_ROCM)
delete NO_PCT.card0['Fan speed (%)']
eq('fanSpeed falls back to level/255 when percent is absent',
  amdSmi.parseRocmSmi(JSON.stringify(NO_PCT))[0].fanSpeed, 35)

// Key order reversed: nothing may depend on how the tool happens to order keys.
const REVERSED = { card0: {} }
for (const k of Object.keys(JSON.parse(REAL_ROCM).card0).reverse()) {
  REVERSED.card0[k] = JSON.parse(REAL_ROCM).card0[k]
}
const rev = amdSmi.parseRocmSmi(JSON.stringify(REVERSED))
eq('reversed keys: fanSpeed still the percent', rev[0].fanSpeed, 35)
eq('reversed keys: name still Card Series', rev[0].name, 'AMD Radeon RX 9070 XT')
eq('reversed keys: powerLimit still 374', rev[0].powerLimit, 374)
eq('reversed keys: memoryTotal not overwritten by used', rev[0].memoryTotal, 16304)
eq('reversed keys: memoryUsed still used', rev[0].memoryUsed, 2665)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)