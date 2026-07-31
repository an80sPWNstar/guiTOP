const psHost = require('./win-ps-host');

let adapters = {};
let samples = {};
let started = false;

function accept(data) {
  adapters = data.adapters || {};
  samples = {};
  const rawSamples = data.samples || [];
  const list = Array.isArray(rawSamples) ? rawSamples : [rawSamples];
  for (const s of list) {
    if (s && s.pid != null && s.luid && s.bytes != null) {
      samples[s.pid + '|' + s.luid] = s.bytes;
    }
  }
}

function ensureStarted() {
  if (started) return;
  started = true;
  psHost.subscribe('GPUMEM', accept);
}

function lookup(pid, gpuName) {
  ensureStarted();
  if (pid == null || !gpuName) return null;

  // Find all luids matching the gpuName
  const targetLuids = new Set();
  for (const [luid, desc] of Object.entries(adapters)) {
    if (desc === gpuName) {
      targetLuids.add(luid);
    }
  }

  if (targetLuids.size === 0) return null;

  let sum = 0;
  for (const luid of targetLuids) {
    const key = pid + '|' + luid;
    if (samples[key] != null) {
      sum += samples[key];
    }
  }

  if (sum > 0) {
    return Math.round(sum / (1024 * 1024));
  }
  return null;
}

module.exports = { lookup };
