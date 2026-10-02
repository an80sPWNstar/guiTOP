// Fixed remote command table. Commands are identified by NAME by the stream
// and the agent transport. All commands are pre-built with fixed arguments only.

const { GPU_CMD, PROC_CMD } = require('./nvidia-smi')
const amdSmi = require('./amd-smi')
const { SYSFS_CMD } = require('./amd-sysfs')

// Fixed string (no dynamic input) — per-process user/cpu/mem/uptime on Linux.
const PS_EO_CMD = 'ps -eo pid=,user:32=,pcpu=,pmem=,etimes='

// Fixed string, no interpolation. Both files are read in one call so the CPU and
// memory halves describe the same instant. `true` forces exit 0: ssh.js rejects a
// non-zero status, and cat fails on a host with no /proc, which is not our error.
const HOST_STAT_CMD = 'cat /proc/stat /proc/meminfo 2>/dev/null; true'

// Backend detection command: probes for nvidia-smi, amd-smi, rocm-smi and amdgpu sysfs.
const PROBE_CMD = 'for c in nvidia-smi amd-smi rocm-smi; do command -v $c >/dev/null 2>&1 && echo $c; done; for u in /sys/class/drm/card[0-9]*/device/uevent; do grep -q "^DRIVER=amdgpu" "$u" 2>/dev/null && { echo amdgpu; break; }; done; true'

const HOSTNAME_CMD = 'hostname'

// stream: true  -> sampled every loop by the stream / agent
// stream: false -> one-shot (detection, names): stream transport sends these over a plain
//                  channel on the pooled connection; the agent runs them on demand, cached 300 s.
const TABLE = Object.freeze([
  { name: 'nv-gpu',     cmd: GPU_CMD,              stream: true },
  { name: 'nv-proc',    cmd: PROC_CMD,             stream: true },
  { name: 'ps',         cmd: PS_EO_CMD,            stream: true },
  { name: 'host',       cmd: HOST_STAT_CMD,        stream: true },
  { name: 'amd-static', cmd: amdSmi.STATIC_CMD,    stream: true },
  { name: 'amd-metric', cmd: amdSmi.METRIC_CMD,    stream: true },
  { name: 'amd-proc',   cmd: amdSmi.PROC_CMD,      stream: true },
  { name: 'rocm',       cmd: amdSmi.ROCM_CMD,      stream: true },
  { name: 'sysfs',      cmd: SYSFS_CMD,            stream: true },
  { name: 'probe',      cmd: PROBE_CMD,            stream: false },
  { name: 'rocm-name',  cmd: amdSmi.ROCM_NAME_CMD, stream: false },
  { name: 'hostname',   cmd: HOSTNAME_CMD,         stream: false },
])

function byName(name) {
  return TABLE.find(e => e.name === name) || null
}

function byCmd(cmd) {
  return TABLE.find(e => e.cmd === cmd) || null
}

function agentTable() {
  return TABLE.map(e => ({
    name: e.name,
    cmd: e.cmd,
    interval: e.stream ? 2 : 300,
  }))
}

module.exports = {
  TABLE, byName, byCmd, agentTable,
  PS_EO_CMD, HOST_STAT_CMD, PROBE_CMD, HOSTNAME_CMD,
}
