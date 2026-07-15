const { execFile } = require('child_process');

let adapters = {};
let samples = {};
let started = false;
let busy = false;

const PS_CMD = `$m = @{}; Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\DirectX' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.Description -and $p.AdapterLuid) { $m[(('0x{0:x8}_0x{1:x8}' -f (($p.AdapterLuid -shr 32) -band 0xFFFFFFFF), ($p.AdapterLuid -band 0xFFFFFFFF))).ToLower()] = $p.Description } }; $s = @((Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | Where-Object CookedValue -gt 0 | ForEach-Object { if ($_.InstanceName -match '^pid_(\\d+)_luid_(0x[0-9a-fA-F]+)_(0x[0-9a-fA-F]+)') { [pscustomobject]@{ pid = [int]$Matches[1]; luid = (($Matches[2] + '_' + $Matches[3])).ToLower(); bytes = [long]$_.CookedValue } } }); @{ adapters = $m; samples = $s } | ConvertTo-Json -Compress -Depth 3`;

function poll() {
  if (busy) return;
  busy = true;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_CMD], { timeout: 15000, maxBuffer: 1 << 22 }, (err, stdout) => {
    busy = false;
    if (err) return;
    try {
      const data = JSON.parse(stdout);
      adapters = data.adapters || {};
      samples = {};
      const rawSamples = data.samples || [];
      const list = Array.isArray(rawSamples) ? rawSamples : [rawSamples];
      for (const s of list) {
        if (s && s.pid != null && s.luid && s.bytes != null) {
          samples[s.pid + '|' + s.luid] = s.bytes;
        }
      }
    } catch (e) {
      // ignore parse errors
    }
  });
}

function ensureStarted() {
  if (started) return;
  started = true;
  poll();
  setInterval(poll, 3000).unref();
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
