// Fixture tests for the AMD collectors. No hardware needed.
const amd = require('../src/collectors/amd-smi.js')

let pass = 0, fail = 0
function eq(label, got, want) {
  const ok = got === want
  if (ok) pass++
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

// --- amd-smi ROCm 6.x nested shape (value/unit wrappers) ---
const STATIC = JSON.stringify([
  {
    gpu: 0,
    asic: { market_name: 'Radeon RX 7900 XTX', vendor_id: '0x1002', device_id: '0x744c', asic_serial: '0xABC' },
    bus: { bdf: '0000:03:00.0', max_pcie_width: 16 },
    vram: { type: 'GDDR6', size: { value: 24560, unit: 'MB' }, bit_width: 384 },
    limit: { max_power: { value: 355, unit: 'W' }, min_power_cap: { value: 0, unit: 'W' } },
  },
  {
    gpu: 1,
    asic: { market_name: 'Radeon RX 7800 XT' },
    bus: { bdf: '0000:0a:00.0' },
    vram: { size: { value: 16384, unit: 'MB' } },
    limit: { max_power: { value: 263, unit: 'W' } },
  },
])

const METRIC = JSON.stringify([
  {
    gpu: 0,
    usage: { gfx_activity: { value: 37, unit: '%' }, umc_activity: { value: 12, unit: '%' }, mm_activity: { value: 'N/A' } },
    power: { socket_power: { value: 145, unit: 'W' }, gfx_voltage: { value: 900, unit: 'mV' } },
    clock: {
      gfx_0: { clk: { value: 2394, unit: 'MHz' }, min_clk: { value: 500, unit: 'MHz' }, max_clk: { value: 2500, unit: 'MHz' } },
      mem_0: { clk: { value: 1249, unit: 'MHz' } },
    },
    temperature: { edge: { value: 52, unit: 'C' }, hotspot: { value: 68, unit: 'C' }, mem: { value: 70, unit: 'C' } },
    mem_usage: { total_vram: { value: 24560, unit: 'MB' }, used_vram: { value: 3072, unit: 'MB' }, free_vram: { value: 21488, unit: 'MB' } },
    fan: { speed: 1180, max: 3200, usage: 37 },
  },
  {
    gpu: 1,
    usage: { gfx_activity: { value: 0, unit: '%' } },
    power: { socket_power: { value: 'N/A' } },
    clock: { gfx_0: { clk: { value: 500, unit: 'MHz' } }, mem_0: { clk: { value: 96, unit: 'MHz' } } },
    temperature: { edge: { value: 34, unit: 'C' } },
    mem_usage: { total_vram: { value: 16384, unit: 'MB' }, used_vram: { value: 411, unit: 'MB' } },
    fan: { speed: 0, max: 3200, usage: 0 },
  },
])

console.log('amd-smi (ROCm 6.x nested):')
const g = amd.parseAmdSmi(STATIC, METRIC)
eq('gpu count', g.length, 2)
if (g.length === 2) {
  eq('[0] name', g[0].name, 'Radeon RX 7900 XTX')
  eq('[0] uuid', g[0].uuid, '0000:03:00.0')
  eq('[0] index', g[0].index, 0)
  eq('[0] utilization', g[0].utilization, 37)
  eq('[0] memoryUsed MiB', g[0].memoryUsed, 3072)
  eq('[0] memoryTotal MiB', g[0].memoryTotal, 24560)
  eq('[0] temperature (edge, NOT mem)', g[0].temperature, 52)
  eq('[0] powerDraw', g[0].powerDraw, 145)
  eq('[0] powerLimit', g[0].powerLimit, 355)
  eq('[0] clockSm (gfx, NOT mem)', g[0].clockSm, 2394)
  eq('[0] fanSpeed pct', g[0].fanSpeed, 37)
  eq('[1] index', g[1].index, 1)
  eq('[1] powerDraw N/A -> null', g[1].powerDraw, null)
  eq('[1] utilization zero survives', g[1].utilization, 0)
  eq('[1] clockSm', g[1].clockSm, 500)
  eq('[1] vendor', g[1].vendor, 'amd')
}

// --- amd-smi flat/older shape, bytes not MB, no unit strings ---
const STATIC_FLAT = JSON.stringify({
  gpu: [{ gpu_index: 0, market_name: 'Instinct MI210', uuid: 'GPU-abc123', vram_total: 68702699520 }],
})
const METRIC_FLAT = JSON.stringify({
  gpu: [{ gpu_index: 0, gfx_activity: 91, socket_power: 288, power_limit: 300, sclk: 1700, edge: 61, vram_used: 34351349760, fan_speed: 64 }],
})
console.log('amd-smi (flat/older, raw bytes):')
const gf = amd.parseAmdSmi(STATIC_FLAT, METRIC_FLAT)
eq('gpu count', gf.length, 1)
if (gf.length === 1) {
  eq('name', gf[0].name, 'Instinct MI210')
  eq('uuid', gf[0].uuid, 'GPU-abc123')
  eq('utilization', gf[0].utilization, 91)
  eq('memoryTotal bytes->MiB', gf[0].memoryTotal, 65520)
  eq('memoryUsed bytes->MiB', gf[0].memoryUsed, 32760)
  eq('temperature', gf[0].temperature, 61)
  eq('powerDraw', gf[0].powerDraw, 288)
  eq('powerLimit', gf[0].powerLimit, 300)
  eq('clockSm', gf[0].clockSm, 1700)
  eq('fanSpeed', gf[0].fanSpeed, 64)
}

// --- amd-smi process --json, nested per-GPU with process_info wrapper ---
const PROC = JSON.stringify([
  {
    gpu: 0,
    process_list: [
      { process_info: { name: 'python3', pid: 4242, memory_usage: { vram_mem: { value: 2048, unit: 'MB' }, gtt_mem: { value: 12, unit: 'MB' } }, engine_usage: { gfx: { value: 0, unit: 'ns' } } } },
      { process_info: { name: 'ollama', pid: 4300, memory_usage: { vram_mem: { value: 512, unit: 'MB' } } } },
    ],
  },
  { gpu: 1, process_list: [] },
])
console.log('amd-smi process (nested):')
const pr = amd.parseAmdSmiProcesses(PROC, { '0000:03:00.0': 0 })
eq('process count', pr.length, 2)
if (pr.length === 2) {
  eq('[0] pid', pr[0].pid, 4242)
  eq('[0] name', pr[0].processName, 'python3')
  eq('[0] usedMemory MiB', pr[0].usedMemory, 2048)
  eq('[0] gpuIndex 0 survives', pr[0].gpuIndex, 0)
  eq('[1] pid', pr[1].pid, 4300)
}

// --- amd-smi process, flat older shape keyed by uuid ---
const PROC_FLAT = JSON.stringify([
  { gpu_uuid: 'GPU-abc123', pid: 99, name: 'rocblas-bench', vram_mem: 1073741824 },
])
console.log('amd-smi process (flat, uuid keyed):')
const prf = amd.parseAmdSmiProcesses(PROC_FLAT, { 'GPU-abc123': 3 })
eq('count', prf.length, 1)
if (prf.length) {
  eq('gpuIndex via uuid map', prf[0].gpuIndex, 3)
  eq('usedMemory bytes->MiB', prf[0].usedMemory, 1024)
}

// --- legacy rocm-smi --showallinfo --json ---
const ROCM = JSON.stringify({
  card0: {
    'Card series': 'Radeon RX 6800 XT',
    'Card model': '0x744c',
    'Card vendor': 'Advanced Micro Devices, Inc. [AMD/ATI]',
    'Unique ID': '0x2150e7d042a1124',
    'Temperature (Sensor edge) (C)': '48.0',
    'Temperature (Sensor junction) (C)': '52.0',
    'Temperature (Sensor memory) (C)': '66.0',
    'GPU use (%)': '73',
    'GPU memory use (%)': '41',
    'VRAM Total Memory (B)': '17163091968',
    'VRAM Total Used Memory (B)': '5368709120',
    'Average Graphics Package Power (W)': '211.0',
    'Max Graphics Package Power (W)': '289.0',
    'Fan speed (%)': '46',
    'sclk clock speed:': '(2280Mhz)',
    'mclk clock speed:': '(1000Mhz)',
  },
})
console.log('rocm-smi (legacy):')
const gr = amd.parseRocmSmi(ROCM)
eq('count', gr.length, 1)
if (gr.length) {
  eq('name is series not vendor', gr[0].name, 'Radeon RX 6800 XT')
  eq('index', gr[0].index, 0)
  eq('uuid', gr[0].uuid, '0x2150e7d042a1124')
  eq('utilization', gr[0].utilization, 73)
  eq('temperature edge', gr[0].temperature, 48)
  eq('memoryTotal MiB', gr[0].memoryTotal, 16368)
  eq('memoryUsed MiB', gr[0].memoryUsed, 5120)
  eq('powerDraw', gr[0].powerDraw, 211)
  eq('powerLimit from max pkg power', gr[0].powerLimit, 289)
  eq('fanSpeed', gr[0].fanSpeed, 46)
  eq('clockSm sclk not mclk', gr[0].clockSm, 2280)
}

// --- garbage input must not throw ---
console.log('robustness:')
eq('empty static/metric', amd.parseAmdSmi('', '').length, 0)
eq('garbage', amd.parseAmdSmi('not json', '{{{').length, 0)
eq('null text', amd.parseAmdSmi(null, null).length, 0)
eq('proc garbage', amd.parseAmdSmiProcesses('nope', {}).length, 0)
eq('rocm garbage', amd.parseRocmSmi('<html>').length, 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
