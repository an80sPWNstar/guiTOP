#!/usr/bin/env node
// Standalone GPU backend probe. No dependencies, no Electron — plain node.
//
// Purpose: capture the RAW output of every GPU query backend on a machine so
// the collectors can be written/verified against real hardware output instead
// of documentation. amd-smi's JSON schema shifts between ROCm versions and
// differs consumer-vs-Instinct, so this is the ground truth.
//
//   node tools/gpu-probe.js                 # human summary to stdout
//   node tools/gpu-probe.js --json          # full raw capture as JSON
//   node tools/gpu-probe.js --json > probe.json
//
// PRIVACY: process-listing probes include process names and PIDs, and uevent
// includes PCI ids. Nothing else about the machine is collected. Review the
// file before sharing it if that matters to you.

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const JSON_MODE = process.argv.includes('--json')

// Fixed probes only — nothing here interpolates input.
const PROBES = [
  { id: 'nvidia.version', bin: 'nvidia-smi', args: ['--version'] },
  { id: 'amd-smi.version', bin: 'amd-smi', args: ['version'] },
  { id: 'rocm-smi.version', bin: 'rocm-smi', args: ['--version'] },

  { id: 'amd-smi.list', bin: 'amd-smi', args: ['list', '--json'] },
  { id: 'amd-smi.static', bin: 'amd-smi', args: ['static', '--json'] },
  { id: 'amd-smi.metric', bin: 'amd-smi', args: ['metric', '--json'] },
  { id: 'amd-smi.process', bin: 'amd-smi', args: ['process', '--json'] },
  { id: 'amd-smi.monitor.csv', bin: 'amd-smi', args: ['monitor', '--csv'] },

  { id: 'rocm-smi.all', bin: 'rocm-smi', args: ['--showallinfo', '--json'] },
  { id: 'rocm-smi.pids', bin: 'rocm-smi', args: ['--showpids'] },
]

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          ok: false,
          code: err.code === undefined ? null : err.code,
          error: err.message,
          stdout: stdout || '',
          stderr: stderr || '',
        })
      }
      resolve({ ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

// The sysfs interface the amdgpu kernel driver exposes without ROCm installed.
const SYSFS_FILES = [
  'gpu_busy_percent', 'mem_busy_percent',
  'mem_info_vram_used', 'mem_info_vram_total',
  'product_name', 'uevent', 'pp_dpm_sclk', 'pp_dpm_mclk',
]
const HWMON_FILES = [
  'name', 'temp1_input', 'temp1_label', 'temp2_input', 'temp2_label',
  'temp3_input', 'temp3_label', 'power1_average', 'power1_input',
  'power1_cap', 'power1_cap_max', 'fan1_input', 'fan1_max', 'freq1_input',
]

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8') } catch (e) { return null }
}

function probeSysfs() {
  const out = { available: false, cards: {} }
  if (process.platform !== 'linux') {
    out.note = `not linux (${process.platform}) — sysfs unavailable`
    return out
  }
  let entries
  try { entries = fs.readdirSync('/sys/class/drm') } catch (e) {
    out.note = `/sys/class/drm unreadable: ${e.message}`
    return out
  }
  const cards = entries.filter(e => /^card\d+$/.test(e)).sort()
  if (cards.length === 0) {
    out.note = 'no /sys/class/drm/cardN entries'
    return out
  }
  out.available = true
  for (const card of cards) {
    const dev = path.join('/sys/class/drm', card, 'device')
    const rec = { files: {}, hwmon: {} }
    for (const f of SYSFS_FILES) {
      const v = readSafe(path.join(dev, f))
      if (v !== null) rec.files[f] = v.trimEnd()
    }
    let hwmons = []
    try { hwmons = fs.readdirSync(path.join(dev, 'hwmon')) } catch (e) { /* none */ }
    for (const h of hwmons) {
      const hrec = {}
      for (const f of HWMON_FILES) {
        const v = readSafe(path.join(dev, 'hwmon', h, f))
        if (v !== null) hrec[f] = v.trimEnd()
      }
      rec.hwmon[h] = hrec
    }
    out.cards[card] = rec
  }
  return out
}

function firstLine(s) {
  const l = (s || '').split('\n').find(x => x.trim())
  return l ? l.trim() : ''
}

async function main() {
  const results = {}
  for (const p of PROBES) {
    results[p.id] = { cmd: `${p.bin} ${p.args.join(' ')}`, ...(await run(p.bin, p.args)) }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    probes: results,
    sysfs: probeSysfs(),
  }

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }

  console.log(`platform : ${report.platform} ${report.arch}  node ${report.nodeVersion}`)
  console.log('')
  console.log('backend probes:')
  for (const [id, r] of Object.entries(results)) {
    const mark = r.ok ? 'OK  ' : 'MISS'
    const detail = r.ok ? firstLine(r.stdout).slice(0, 70) : firstLine(r.error).slice(0, 70)
    console.log(`  ${mark} ${id.padEnd(20)} ${detail}`)
  }
  console.log('')
  const sf = report.sysfs
  if (sf.available) {
    for (const [card, rec] of Object.entries(sf.cards)) {
      const name = rec.files.product_name || '(no product_name)'
      const busy = rec.files.gpu_busy_percent === undefined ? '-' : rec.files.gpu_busy_percent + '%'
      const hw = Object.keys(rec.hwmon).join(',') || 'none'
      console.log(`  sysfs ${card}: ${name}  busy=${busy}  hwmon=[${hw}]`)
    }
  } else {
    console.log(`  sysfs: unavailable — ${sf.note}`)
  }
  console.log('')
  console.log('Re-run with --json and send that file to get the collectors tuned:')
  console.log('  node tools/gpu-probe.js --json > gpu-probe.json')
}

main()
