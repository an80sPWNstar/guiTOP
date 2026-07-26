// Regression tests pinned to a REAL hardware capture: AMD Radeon 8060S (Strix
// Halo APU, PCI 1002:7550), CachyOS, ROCm 7.2, rocm-smi 4.0.0, kernel exposes the
// GPU as card1 with NO product_name. Captured 2026-07-26 via tools/gpu-probe.js.

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

console.log('real hardware (Radeon 8060S, sysfs):')
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
  eq('fanSpeed 1533/5000 rpm->pct', g[0].fanSpeed, 31)
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)