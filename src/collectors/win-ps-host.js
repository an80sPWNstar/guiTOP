// One long-lived PowerShell child for every Windows-only sampler.
//
// The Windows collectors used to call execFile('powershell.exe', ...) on every
// tick: two samplers at 3s plus an owner map at 10s, so a fresh PowerShell
// runtime (and its conhost) started and died roughly 70 times a minute for as
// long as the app was open. Booting a PowerShell runtime costs far more than
// the query it then runs, and Task Manager attributes the whole parade to
// guiTOP.
//
// Instead: spawn PowerShell once, have it loop, and stream one tagged JSON
// line per sample back over stdout. Subscribers get the parsed payload.
//
// SECURITY: the script is a fixed string. The only interpolation is
// process.pid, a number produced by Node, which the loop uses to notice that
// its parent is gone. It is passed with -EncodedCommand so no shell quoting is
// involved at all.

const { spawn } = require('child_process');
const readline = require('readline');

const LOOP_SECONDS = 3;
const RESPAWN_MS = 5000;

// Tags must match the prefixes written by the script below.
const TAGS = ['PROCS', 'GPUMEM', 'OWNERS'];

function buildScript(parentPid) {
  return String.raw`
$parent = ${parentPid}
$out = [Console]::Out
$tick = 0
$adapters = $null

while ($true) {
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }

  try {
    try { $p = Get-Process -IncludeUserName -ErrorAction Stop } catch { $p = Get-Process }
    $rows = $p | Select-Object Id, @{n='u';e={$_.UserName}}, @{n='i';e={$_.SessionId}}, @{n='c';e={$_.CPU}}, @{n='w';e={$_.WorkingSet64}}, @{n='s';e={ try { [long](($_.StartTime).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds } catch { $null } }}
    $out.WriteLine('PROCS ' + ($rows | ConvertTo-Json -Compress))
  } catch { }

  try {
    # The adapter table is registry state that only changes when hardware or a
    # driver does; re-read it every minute rather than every sample.
    if ($null -eq $adapters -or ($tick % 20) -eq 0) {
      $adapters = @{}
      Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\DirectX' -ErrorAction SilentlyContinue | ForEach-Object {
        $props = Get-ItemProperty $_.PSPath
        if ($props.Description -and $props.AdapterLuid) {
          $key = ('0x{0:x8}_0x{1:x8}' -f (($props.AdapterLuid -shr 32) -band 0xFFFFFFFF), ($props.AdapterLuid -band 0xFFFFFFFF)).ToLower()
          $adapters[$key] = $props.Description
        }
      }
    }
    $samples = @((Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | Where-Object CookedValue -gt 0 | ForEach-Object {
      if ($_.InstanceName -match '^pid_(\d+)_luid_(0x[0-9a-fA-F]+)_(0x[0-9a-fA-F]+)') {
        [pscustomobject]@{ pid = [int]$Matches[1]; luid = ($Matches[2] + '_' + $Matches[3]).ToLower(); bytes = [long]$_.CookedValue }
      }
    })
    $out.WriteLine('GPUMEM ' + (@{ adapters = $adapters; samples = $samples } | ConvertTo-Json -Compress -Depth 3))
  } catch { }

  # quser exits non-zero with no sessions, which is normal. Its output is
  # multi-line and stays text so the existing parser is unchanged; wrapping it
  # in JSON is what keeps it to one line on the wire.
  if (($tick % 4) -eq 0) {
    try {
      $quser = (& quser 2>$null | Out-String)
      if ($quser) { $out.WriteLine('OWNERS ' + (@{ text = $quser } | ConvertTo-Json -Compress)) }
    } catch { }
  }

  $out.Flush()
  $tick++
  Start-Sleep -Seconds ${LOOP_SECONDS}
}
`;
}

const handlers = {};
for (const tag of TAGS) handlers[tag] = [];

let child = null;
let respawnTimer = null;
let stopped = false;

function start() {
  if (child || stopped || process.platform !== 'win32') return;

  const encoded = Buffer.from(buildScript(process.pid), 'utf16le').toString('base64');

  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });

  // A payload line carries the whole process table, so it can run to tens of
  // kilobytes; readline reassembles chunk splits for us.
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const space = line.indexOf(' ');
    if (space === -1) return;
    const tag = line.slice(0, space);
    const list = handlers[tag];
    if (!list || list.length === 0) return;
    let payload;
    try {
      payload = JSON.parse(line.slice(space + 1));
    } catch {
      return; // a truncated or interleaved line is dropped, not fatal
    }
    for (const fn of list) {
      try { fn(payload); } catch { }
    }
  });

  const onGone = () => {
    if (child) child = null;
    scheduleRespawn();
  };
  child.on('exit', onGone);
  child.on('error', onGone);
}

function scheduleRespawn() {
  if (stopped || respawnTimer) return;
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    start();
  }, RESPAWN_MS);
  respawnTimer.unref();
}

// Subscribing is what starts the host, so a build that never reads these
// samples never pays for the PowerShell process.
function subscribe(tag, fn) {
  if (!handlers[tag]) throw new Error('unknown tag: ' + tag);
  handlers[tag].push(fn);
  start();
}

function stop() {
  stopped = true;
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  if (child) { child.kill(); child = null; }
}

// The loop also exits on its own once it sees the parent gone, which covers
// the cases where this never runs.
process.on('exit', stop);

module.exports = { subscribe, stop, LOOP_SECONDS };
