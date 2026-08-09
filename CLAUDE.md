# guiTOP

## What This Is
A Windows/Linux desktop app that provides a GUI for NVIDIA GPU monitoring (a "GUI for nvitop").
Shows live GPU stats as a native dashboard of custom widgets. Two tabs:
1. **Single** — one chosen machine's GPUs.
2. **Multi** — a grid of multiple machines at once.

Includes a **Claude usage strip** — live cswap-driven token usage meters (session/week) + per-account
swap chips, dockable top/bottom/off. Display name respects privacy (GUITOP_DISPLAY_NAME env var).

Resizable window. Per-host process table hidden by default, revealed via toggle.

## Tech Stack
- **Runtime:** Electron 31 (Chromium + Node.js)
- **Language:** JavaScript. Renderer is plain HTML/CSS/JS.
- **Main process:** `main.js` — creates BrowserWindow, owns collectors, pushes data over IPC.
- **IPC bridge:** `preload.js` — `contextBridge` exposes `window.guiTOP` API.
- **Data source:** `nvidia-smi` over SSH (and locally). SSH transport via `ssh2`.
- **Build targets:** Windows `.exe` (NSIS), Linux AppImage + `.deb`. Native modules **must** match target OS.
- **Skin system:** Bars, Gauges, C4 Corvette — switched via dropdown or `/skin/<name>` endpoint.

## Project Structure
```
guiTOP/
├── package.json            # electron + ssh2 + electron-builder
├── main.js                 # Electron main — window, collectors, IPC, dev HTTP server
├── preload.js              # contextBridge: window.guiTOP.{onData, onClaudeUsage, onClaudeSwap, ...}
├── src/
│   ├── collectors/
│   │   ├── nvidia-smi.js   # nvidia-smi query strings + runner
│   │   ├── amd-smi.js      # amd-smi (ROCm 6+) + legacy rocm-smi parsers
│   │   ├── amd-sysfs.js    # bare amdgpu sysfs reader (no ROCm needed)
│   │   ├── vendor.js       # per-host backend detection, cached
│   │   ├── parse.js        # CSV → structured GPU readings
│   │   ├── ssh.js          # ssh2 transport: connect, exec, return stdout
│   │   ├── service.js      # Per-host poll loop, emits {host, gpus, processes}
│   │   ├── mock.js         # Synthetic GPU data for dev
│   │   ├── claude-usage.js # Polls cswap list --json → session/week pct matching online account
│   │   ├── claude-usage-oauth.js # Same meters, sourced from a logged-in claude.ai session
│   │   ├── claude-web.js   # claude.ai login/logout flow behind the OAuth collector
│   │   ├── claude-swap.js  # Polls cswap list --json → per-account 5h/7d pct + display name
│   │   ├── cswap-cmd.js    # Per-platform cswap invocation (cmd.exe shim on Windows only)
│   │   ├── win-ps-host.js  # One long-lived PowerShell child; streams tagged JSON samples
│   │   ├── win-gpu-mem.js  # Windows per-process VRAM via perf counters (nvidia-smi reports N/A)
│   │   └── win-proc-stats.js # Windows USER/CPU%/MEM%/TIME for the process table
│   └── config/
│       └── hosts.js        # Load + validate host list
├── renderer/
│   ├── index.html          # Tabbed shell (Single | Multi), CSP-locked
│   ├── renderer.js         # Subscribes to data, routes to active tab, Claude strip
│   └── widgets/
│       ├── gpu-card.js     # GPU gauge card
│       ├── gpu-card-bars.js# Bar-based GPU skin
│       ├── gpu-card-corvette.js # C4 Corvette GPU skin
│       ├── process-table.js# Process table with sortable columns
│       └── claude-usage-strip.js # Claude usage UI strip widget
├── styles/main.css         # Obsidian Glass theme + per-skin vars + Claude strip CSS
├── tools/gpu-probe.js      # Standalone hardware capture (no deps, no Electron)
├── test/                   # *.test.js fixtures, run by `npm test`
└── assets/fonts/           # DSEG, Orbitron, Rajdhani, Share Tech Mono
```

## Architecture

### Data Flow
1. Main process runs `service.js` once per configured host (1s poll).
2. On the first poll, `vendor.js` probes the host for available GPU backends
   (nvidia-smi / amd-smi / rocm-smi / amdgpu sysfs) and caches the answer.
   Each detected backend is then polled over local or SSH transport and the
   results merged (see AMD GPU Support below).
3. Main pushes per-host payloads: `win.webContents.send('gpu-data', payload)`.
4. Separately: `claude-usage.js` and `claude-swap.js` poll `cswap list --json` every 45s
   (or the OAuth collector replaces the former — see Claude Usage Sources). `cswap-cmd.js`
   decides how to invoke the CLI per platform; only Windows needs the `cmd.exe` shim.
5. Renderer subscribes via `window.guiTOP.onData()` / `onClaudeUsage()` / `onClaudeSwap()`.

### Claude Usage Strip
- **claude-usage.js**: calls `cswap list --json`, extracts active account's `fiveHour.pct` → sessionPct, `sevenDay.pct` → weekPct, `fiveHour.resetsAt` → resetMs.
- **claude-swap.js**: same cswap call, extracts per-account 5h/7d pct + alias.
- **Display name**: `GUITOP_DISPLAY_NAME` env var set in main.js; defaults to an80sPWNstar. Falls back to email prefix if unset.
- **Widget**: `renderClaudeStrip()` in renderer.js. Dock cycles top → bottom → off.
- **Dev endpoint**: `GET /claude/toggle` — cycles dock position.
- **AUTO chip**: `cswap auto` is a foreground loop with no daemon, pidfile or lockfile, so the only way to know it runs is to look for the process. `detectAuto()` in `claude-swap.js` matches the COMMAND LINE, never the process name: `uv`-installed tools run as `python.exe` with the shim path in their arguments. Windows uses one `Get-CimInstance Win32_Process` call (~230 ms), other platforms use `pgrep -af cswap`, which reports no start time so `autoSinceMin` is null there. A detection that cannot run reports "not detected" rather than an error.

## Claude Usage Sources

Two interchangeable sources feed the same session and week meters; which one runs is chosen by the `useOAuthClaude` setting in `settings.json`. The default, false, runs `claude-usage.js`, polling the cswap CLI every 45 seconds. True runs `claude-usage-oauth.js`, which calls `https://api.anthropic.com/api/oauth/usage` every 5 minutes, backing off to 30 seconds while no token is available or after a failure with no cached reading.

The OAuth collector reads an access token from the Claude CLI credential store, trying five candidate paths — `~/.claude/.credentials.json` first, then the Roaming and Local AppData variants for Claude and Claude Code — and expects the field `claudeAiOauth.accessToken`. It sends that token as a Bearer header alongside a hardcoded, date-stamped `anthropic-beta: oauth-2025-04-20`. That header is a maintenance liability: it will need updating if the API revs.

Its payload adds `via: 'oauth'` so the renderer can tell the sources apart, reports `sessionPct`/`weekPct` plus `sessionResetAt`/`weekResetAt`, and can carry a per-model weekly window under a `fable` key. `todayTokens` is always null on this path. A missing credential file is reported as `ok: false` with `missingToken: true` rather than as an error, so the UI can distinguish "not logged in" from "request failed". Toggling the setting at runtime stops the live collector and starts the other one — no restart needed, and no check that an OAuth token exists before switching. Which source is live is not exposed over the dev API; read the `useOAuthClaude` key in `settings.json`.

## Claude Web Session

`claude-web.js` implements an optional claude.ai browser login, exposed to the renderer through the `claude:login`, `claude:logout` and `claude:status` IPC handlers. Login opens a 1000x700 BrowserWindow on `https://claude.ai/login`, having first cleared any existing `sessionKey` cookie so a stale session cannot be mistaken for a fresh login. The window's User-Agent is overridden with a normal Chrome string, with the Electron and guiTOP tokens stripped, because Cloudflare rejects the default Electron agent. Popups via `window.open` are blocked. Capture watches the `cookie-changed` event for `sessionKey` and also polls every 500 milliseconds in case the event is missed; the whole flow times out after 5 minutes.

The captured `sessionKey` is encrypted with Electron `safeStorage` and written to `claude-web.json` in userData, always at mode `0600` — the file holds a full account credential and the default mode would leave it readable by every local account.

There is nowhere safe to put the key when the OS has no keyring, which on Linux means any box with no keyring daemon running. `safeStorage.isEncryptionAvailable()` returning false therefore triggers a one-time consent dialog, defaulting to refusal. Refusing is not an error: the key stays in a module-level variable so the session works until the app exits, `status()` reports `keyStorage: 'memory'`, and the Settings dialog says the login will not be saved. Accepting writes it in plaintext and reports `keyStorage: 'plaintext'`. An existing plaintext key counts as prior consent and is not re-asked. A refused save also clears any key already on disk, so a stale credential cannot silently log the next launch in as the previous session. On Windows DPAPI is always available, so this path never runs there.

After login the organization id is discovered by fetching `/api/organizations` in a hidden BrowserWindow, preferring an organization of type `team` among those with the `chat` capability, and stored alongside the key; failing to discover it is non-fatal and login still reports success. That hidden fetch re-plants the `sessionKey` cookie before loading, times out after 30 seconds, and treats the strings `Just a moment` and `Enable JavaScript and cookies to continue` in the response body as a Cloudflare challenge — matching on English challenge text is fragile.

Logout deletes `claude-web.json`, removes the `sessionKey` cookies, and clears localStorage, sessionStorage and cacheStorage for `https://claude.ai`.

## Window State, Tray and Startup

Preferences live in `settings.json` under the Electron userData directory: `launchAtStartup`, `minimizeToTray`, `useOAuthClaude`, `windowBounds` and `windowMaximized`. Window geometry is saved on resize, move, maximize and unmaximize, debounced by 500 milliseconds. The saved size is `getNormalBounds`, the restored un-maximized size, so a window closed while maximized still has a sane size to return to.

On launch, saved coordinates are honoured only if the rectangle still intersects the work area of a display that currently exists; otherwise only width and height are applied and the OS places the window. This stops a window last closed on a monitor that is now unplugged from opening off-screen. A malformed saved size falls back to 960 by 680, and sizes below the 320 by 200 minimum are rejected.

The tray is created at startup and cannot be toggled without a restart. Its menu is Show, Hide, Settings and Quit; Settings sends an `open-settings` message to the renderer rather than opening anything in the main process. Double-clicking the tray icon toggles window visibility. With `minimizeToTray` enabled and a tray present, closing the window hides it instead of quitting and `window-all-closed` does not quit the app; with the setting off, or with no tray, closing quits. `launchAtStartup` calls `app.setLoginItemSettings({ openAtLogin })`, which takes effect immediately as a system setting but only changes behaviour at the next login.

Toggling that checkbox is the only thing that ever writes a startup entry. Electron registers whichever executable is currently running, so re-applying the setting on launch — which the app used to do — silently repointed the user's entry at whatever copy happened to start: a `dist` folder, or `node_modules/electron`. That is how a stray `electron.app.Electron` entry appeared in `HKCU\...\Run` pointing at the dev binary. Startup now calls `syncLoginItemSetting()`, which reads `app.getLoginItemSettings()` and corrects `settings.json` to match, so the registry is the source of truth and the checkbox reflects what is actually configured after an entry is disabled in Task Manager or dropped by an uninstall. Both functions no-op when `app.isPackaged` is false, so a dev run can never claim the entry; note that an unpacked `dist` build *is* packaged by that test, so running one and ticking the box does register that path.

The window and tray icon come from `assets/images/app-icon.ico` on Windows and `assets/images/app-icon.png` elsewhere, because Electron does not read `.ico` on Linux. The PNG is the 256 pixel image unpacked from the same ICO.

## GPU Sampling on the Local Host

The local host previously called `execFile('nvidia-smi', ...)` twice per second, once for `--query-gpu` and once for `--query-compute-apps`. Every console child on Windows allocates a `conhost.exe`, so the steady state created four processes per second, roughly 240 a minute, all attributed to `guiTOP` — the same defect class as the PowerShell parade below, and considerably larger. The fix uses `nvidia-smi`'s own loop mode, `-l 1`, which repeats one query forever on a single process. Two long-lived children now serve every tick from `src/collectors/nvidia-stream.js`.

Remote hosts are unaffected because they run the same fixed query strings over SSH and never spawned anything locally. The local implementation had to solve a framing problem because `-l` prints the CSV header once, not per iteration, leaving no delimiter between samples. Compute-app rows also vary in count, so lines cannot be counted to separate iterations. `timestamp` is a valid query field on both queries, and every row of one iteration carries the same value while two iterations never share one. The timestamp leads the field list, marks the boundary, and is stripped again, so what `parse.js` receives is byte-identical to the one-shot output.

Rows are **not** uniformly stamped within an iteration, which cost a release to learn: `nvidia-smi` re-stamps as it walks the devices, so a 22-row `--query-compute-apps` iteration arrives as 21 rows at `.298` and the last row at `.302`. Testing the stamps for equality therefore split one sample in two and the process table showed whichever landed last. Rows belong to the same iteration while their timestamps are within 500 ms of the group's first, a window far above the few milliseconds an iteration spans and far below the second between them. The comparison is between the timestamps themselves rather than the times we read them, so a stalled event loop cannot split a sample either.

A group is published when a row past that window arrives, or after 400 ms of silence. An iteration with no compute processes emits no rows at all, which is indistinguishable from a stalled child. A proc sample older than 4 seconds is therefore reported as no processes rather than serving the last non-empty list forever. The one-shot pair remains the fallback for the first tick and for a child that has died and not yet respawned, with respawn occurring after 5 seconds.

Unlike the PowerShell script, which polls for its parent and exits, `nvidia-smi` has no such check, so an orphan would query the driver every second forever. The streams are killed on process exit, and a hard kill leaves the child to notice its stdout pipe has closed on the next write. Measured on a 3-GPU Windows box, no new child process appeared in 75 seconds of running, against about 240 a minute before. The only spawns left are the 45 second `cswap` poll.

## Windows Process Telemetry

Two collectors exist only because `nvidia-smi` on Windows cannot supply fields it supplies on Linux. Both sample independently of the 1 second GPU loop, both swallow their own errors and serve the last good reading, and both are looked up by pid from `service.js`.

Neither one spawns anything. All three Windows samples come from a single long-lived PowerShell child owned by `win-ps-host.js`, which streams one tagged JSON line per sample on stdout: `PROCS` and `GPUMEM` every 3 seconds, `OWNERS` every fourth loop. Collectors call `subscribe(tag, fn)` and receive the parsed payload; subscribing is what starts the host, so a platform that never reads these samples never pays for the process.

This replaced a per-tick `execFile('powershell.exe', ...)` in each collector. Booting a PowerShell runtime costs far more than any of these queries, and at two 3-second samplers plus a 10-second `quser` it started and destroyed a runtime and its `conhost` roughly 70 times a minute for as long as the app was open — measured at 17 `powershell.exe` spawns per 30 seconds. Task Manager attributes the entire parade to guiTOP and grades its startup impact accordingly, which is how this was found. The steady state is now one PowerShell process for the lifetime of the app.

The script is passed with `-EncodedCommand` (UTF-16LE base64), so no shell quoting is involved. Its only interpolated value is `process.pid`, which the loop polls to notice its parent is gone and exit; `before-quit` also calls `stop()`. If the child dies for any other reason it is respawned after 5 seconds. A payload line carries the whole process table — tens of kilobytes — so stdout is read through `readline` rather than by splitting chunks.

`win-gpu-mem.js` fills per-process VRAM, which `nvidia-smi` reports as `N/A` under WDDM. Its sample reads the `\GPU Process Memory(*)\Dedicated Usage` performance counter and maps adapter LUIDs to adapter names from `HKLM\SOFTWARE\Microsoft\DirectX`. That adapter table is registry state that only changes when hardware or a driver does, so the loop re-reads it once a minute instead of every sample. Counter instances are named `pid_<pid>_luid_<hi>_<lo>`, so the pid and the adapter both come out of the instance name. `lookup(pid, gpuName)` sums every LUID belonging to that adapter name and returns megabytes.

`win-proc-stats.js` fills the USER, CPU%, MEM% and TIME columns of the process table. It reads `Id`, `UserName`, `SessionId`, `CPU`, `WorkingSet64` and `StartTime` from `Get-Process`, and computes CPU percent from the delta in cumulative CPU seconds between two samples, requiring at least half a second between them. `Get-Process -IncludeUserName` needs elevation, so it is attempted and falls back to a plain `Get-Process`, which leaves `UserName` null. The `OWNERS` sample runs `quser` to build a session-id to user-name map, and the lookup merges that name in when the primary path gave none. `quser` exits non-zero when there are no sessions, which is a normal state and not treated as failure; its output stays raw text inside a JSON string so the existing parser is unchanged and the line protocol still gets one line.

`claude-swap.js` still spawns its own PowerShell for AUTO-chip detection, but only on its 45 second poll. Folding it in would mean adding `CommandLine` to the 3 second process query, which is the field that makes that payload large.

## Host CPU and RAM

`src/collectors/host-stats.js` supplies the machine-level pair nvitop shows above its GPU panels.
It is reported once per host, beside the host name, and never on a GPU card: the numbers describe
the box, so repeating them on every card would say the same thing three times.

Neither path spawns a process. The local host reads `os.cpus()` and `os.totalmem()`/`os.freemem()`,
which works on every platform and is why Windows needs no PowerShell here. Remote hosts add one
fixed command to the existing per-tick SSH calls, `cat /proc/stat /proc/meminfo 2>/dev/null; true`
— both files in one call so the CPU and memory halves describe the same instant, and the forced
zero exit because `ssh.js` rejects a non-zero status and `cat` fails on a host with no `/proc`,
which is a normal state rather than an error. A non-Linux or unreachable host reports `sys: null`
and the renderer draws no meters. The sample never rejects; a host whose GPU backend is broken
still shows CPU and RAM.

CPU percent is a **rate**, and the kernel only exposes cumulative jiffies, so it needs two samples.
The previous one lives in the per-host poll-loop state, which means a freshly added host, a host
that just came back from an outage, and a host whose counters went backwards after a reboot all
report `null` for one tick rather than a fabricated `0%` — 0% is a claim that the machine is idle.
`iowait` counts as idle, matching `top` and nvitop.

A Linux host reads its own `/proc/stat` and `/proc/meminfo` even when it is the local machine, so
local and remote produce identical figures; `os.*` is the fallback for everything else. Memory is
not what motivates that. Node 18's `os.freemem()` on Linux already returns `MemAvailable` exactly
— measured at 27699256 kB against the same value in `/proc/meminfo` — so the two agreed anyway.
That is a libuv implementation choice rather than a documented guarantee, and it varies by
platform.

CPU is the difference that shows up today: `os.cpus()` reports user, nice, sys, idle and irq, and
has no `iowait` or `steal` column at all, while this collector counts `iowait` as idle the way
`top` and nvitop do. A box waiting on disk therefore reads busier through `os.cpus()` — those
jiffies are absent from the total rather than counted as idle — and a VM losing time to its
hypervisor reads busier still. Verified on a Linux box: the `/proc` path reported 37922600 kB used
against `free -k`'s 37923356 kB in the same second.

On Windows `os.freemem()` is available physical memory, the quantity Task Manager subtracts for
"In use", so that path is right as it stands. macOS is unconfirmed — libuv reports free pages
there, which excludes inactive and purgeable memory and would read fuller than Activity Monitor,
but there is no Mac to check it on and no mac build target yet.

The two sources count in different units — `/proc/stat` in jiffies, `os.cpus()` in milliseconds —
so the CPU baseline is tagged with its source and discarded if the source changes mid-session,
which happens if `/proc` becomes unreadable and the sampler falls back.

The widget is `renderer/widgets/host-meters.js` — one widget, not three. Every skin-specific value
is an `--hm-*` custom property in `main.css`, the same arrangement the Claude strip uses for
`--cu-*`, so Bars gets its cyan/indigo and Orbitron, Corvette gets amber DSEG14 on a recessed
panel with square bar ends, and Gauges gets the default teal/amber. The shell is built once and
only the numbers and bar widths change per tick.

## Commands
| Command | What |
|---------|------|
| `npm start` | Run (Windows) |
| `npm run dev` | Run with DevTools |
| `npm test` | Run all `test/*.test.js` (no framework, no deps) |
| `npm run probe` | Capture real GPU backend output on this machine |
| `electron . --mock-amd` | Run with AMD-shaped mock data (sparse fields) |
| `npm run build` | Windows NSIS .exe (Windows only, needs wine from WSL) |
| `npm run build:win` | Windows .exe from WSL (delegates to PowerShell) |
| `npm run build:linux` | Linux AppImage + .deb (from WSL/Linux) |
| `npm run build:dir` | Unpacked Windows build — fast check that packaging/icons resolve |
| `curl localhost:17580/screenshot` | Screenshot API |
| `curl localhost:17580/claude/toggle` | Toggle Claude strip |
| `curl localhost:17580/skin/bars\|gauges\|corvette` | Switch skin |
| `curl localhost:17580/tab/single\|multi` | Switch tab |
| `curl localhost:17580/host/<index>` | Switch the Single tab to host N |
| `curl localhost:17580/procs/toggle` | Toggle the process table |
| `curl "localhost:17580/resize?w=&h="` | Resize the window (self-verify responsive layout) |
| `curl localhost:17580/gpu/backends` | Which backend each host resolved to + null metrics |
| `curl localhost:17580/debug/strip` | Claude strip geometry + element overlap check |
| `curl localhost:17580/debug/gauges` | Gauges skin geometry dump |
| `curl localhost:17580/debug/corvette` | Corvette skin geometry dump |
| `curl localhost:17580/debug/claude-config` | Opens the Claude accounts modal, reports display + row count |
| `curl localhost:17580/debug/settings` | Opens Settings, reports whether it fits the window and Close is on screen |

## Build Notes
- **Cross-compile Windows from WSL**: use `npm run build:win` (PowerShell delegation). Direct `npm run build` fails — needs wine.
- **Linux build from WSL**: `npm run build:linux`. Requires Linux-native ssh2 (`npm install` from WSL).
- **After Linux build**: restore Windows modules via `powershell.exe -Command 'npm install'` or next Windows build will fail.
- **Python 3.13**: needs `pip install setuptools` on Windows (distutils removed).
- **Claude Code shell**: sets `ELECTRON_RUN_AS_NODE=1` — clear it before launching: `$env:ELECTRON_RUN_AS_NODE = $null`.

## AMD GPU Support

AMD GPU support is restricted to Linux. Three backends exist: `amd-smi` for ROCm 6.0 and newer, the `amdgpu` sysfs interface which requires only the kernel driver, and `rocm-smi`, a legacy tool deprecated since ROCm 3.9. The preference order is `amd-smi`, then `amdgpu` sysfs, then `rocm-smi`. The sysfs backend precedes `rocm-smi` because it exposes the same fields the parser reads, costs a file read instead of spawning a Python process on every one-second poll, and does not shift its layout between ROCm releases. Only `amd-smi` provides per-process rows; neither sysfs nor `rocm-smi` does.

Installation does not guarantee functionality. Detection reports every backend it finds, and the poll loop walks them best-first, keeping the first that actually returns a card. The winning backend is remembered per host so the steady state is a single call, and it is forgotten as soon as it stops returning cards, so the list is re-walked. This prevents a broken tool from taking a whole host down. Observed on a ROCm 7.2 machine: `rocm-smi` was present in `PATH` but aborted mid-query with an assertion failure inside `get_od_clk_volt_info`, reached through the overdrive clock and voltage table. That previously marked the host unreachable even though the sysfs tree held complete, correct telemetry. The `rocm-smi` query no longer requests that table at all, since none of its values are parsed.

Since all AMD tools describe the same physical cards, exactly one may serve a host or every card would be listed twice. NVIDIA is independent and is always polled alongside. On hybrid hosts results merge with offset indices so display indices stay unique, while the per-vendor index is preserved in `nativeIndex`. Every GPU object includes a `vendor` field set to either `'nvidia'` or `'amd'`. DRM card numbering is neither dense nor guaranteed to start at zero — an observed machine had its only GPU at `card1` — so the sysfs backend renumbers the cards it keeps to 0..N-1 and stores the real DRM number in `drmCard`.

Field coverage varies between consumer Radeon and Instinct cards, and the `amd-smi` JSON schema is unstable across ROCm versions. Parsing is therefore defensive: unexpected payloads result in an empty list rather than an exception, and missing individual metrics resolve to `null` instead of discarding the entire card. A `product_name` file is not guaranteed — an observed discrete RX 9070 XT had none — in which case the card is named from its PCI device id.

`rocm-smi` reports several metrics twice under different keys, so branch order matters where the parser matches on substrings. Fan speed arrives as both `Fan speed (level)` (raw PWM, 0-255) and `Fan speed (%)`; the percent key is matched first and the level is only converted (`level / 255`) when no percent key is present. `real-hardware.test.js` re-parses the same capture with its keys reversed to keep that independent of whatever order the tool emits.

Windows AMD support is intentionally omitted. Neither `amd-smi` nor `rocm-smi` ships for Windows. While existing Windows performance counters can provide GPU utilization and per-process VRAM usage, they cannot report temperature, power, clock speeds, or total VRAM. This would result in incomplete card representations. Full Windows support would require a native addon integrating LibreHardwareMonitor or the AMD ADLX SDK.

## Capturing Real Hardware Output

Parsers were developed against documented schemas and synthetic fixtures. Verify new fields against real hardware output before relying on them.

Status: the **sysfs** reader and the **rocm-smi** parser are both pinned to real captures from a Sapphire RX 9070 XT (Navi 48, gfx1201, discrete — an earlier note misidentified this machine as a Radeon 8060S APU) on ROCm 7.2, in `test/real-hardware.test.js`. Every field both produced was correct apart from the fan-percent branch order fixed alongside that capture. The **amd-smi** parser has still never run against real hardware; `amd-smi` was absent on that box. A capture from an Instinct or a ROCm 6 machine would close the last gap.

Fan percent has two possible bases and the card exposes both. `fan1_input / fan1_max` is a ratio of tachometer RPM; `pwm1 / pwm1_max` is the duty cycle actually being driven. RPM does not scale linearly with duty, so on the same card at the same instant they read 31% and 35%. A matched-moment capture settled which one AMD's own tools show: `rocm-smi`'s `Fan speed (level)` was the integer 89, byte-identical to `pwm1`, with `pwm1_max` at 255 — it reads the file rather than deriving anything. The sysfs reader therefore prefers PWM and falls back to the RPM ratio only when `pwm1_max` is missing, since assuming a divisor of 255 is how a fan meter ends up reading 200%. It is deliberately **not** gated on `pwm1_enable`, which does not exist on that card; requiring it would force the RPM fallback on exactly the hardware the fix targets.

One cosmetic disagreement remains: `rocm-smi` numbers the card `card0` while the DRM tree exposes it as `card1`; each backend renumbers densely on its own, so this is harmless but will confuse anyone comparing raw output.

Run the following command on the target AMD machine to generate a human-readable summary:

```bash
node tools/gpu-probe.js
```

For machine-readable output, use:

```bash
node tools/gpu-probe.js --json
```

Or save directly to a file:

```bash
node tools/gpu-probe.js --json > gpu-probe.json
```

An npm alias is also available:

```bash
npm run probe
```

The probe tool is a standalone Node.js script with no external dependencies and does not require Electron. It queries `nvidia-smi`, `amd-smi`, and `rocm-smi`, executing static, metric, process, and list queries. It also dumps the entire `amdgpu` sysfs tree, including `hwmon` data.

**Privacy Note**: The capture includes process names, PIDs, and PCI IDs. It does not include other machine identifiers. Review the output file before sharing.

## Testing

Run the test suite with:

```bash
npm test
```

This executes all `*.test.js` files in the `test/` directory in isolated processes. The suite uses no test framework or external dependencies.

Current test suites:

*   `test/amd-smi.test.js`: Validates `amd-smi` and `rocm-smi` parsers against fixtures for both modern nested (value/unit) and legacy flat JSON shapes.
*   `test/amd-sysfs.test.js`: Validates the sysfs reader.
*   `test/real-hardware.test.js`: Pins both the sysfs reader and the `rocm-smi` parser to real captures from the same machine (Sapphire RX 9070 XT, Navi 48, gfx1201, ROCm 7.2, GPU at `card1`, no `product_name`). It re-parses the `rocm-smi` capture with its keys reversed, since several metrics arrive under two keys and substring matching must not depend on emission order. It also guards that the `rocm-smi` query stays off the overdrive clock table that aborts on ROCm 7.2.
*   `test/fallback.test.js`: Validates backend slot planning and the best-first fallback walk — a present-but-broken tool must not take a host down while a working backend sits behind it.
*   `test/merge.test.js`: Validates mixed-vendor index merging logic.
*   `test/commands.test.js`: Guards the integrity of fixed remote command strings.
*   `test/claude-web.test.js`: Covers where the claude.ai session key ends up — encrypted, plaintext-by-consent, or memory-only after refusal — plus file mode, prior-consent handling, stale-key clearing and logout. `electron` is stubbed in the module cache, since this is main-process code that cannot be driven headlessly.
*   `test/host-stats.test.js`: Covers the `/proc/stat` and `/proc/meminfo` parsers and the CPU
    delta arithmetic, with most of its weight on the states that must read as `null` rather than
    `0%`: a first tick, a repeated tick, counters that went backwards after a reboot, and the tick
    after an unreadable sample. Also guards the forced zero exit on the remote command.
*   `test/cswap.test.js`: Validates the per-platform cswap invocation and `cswap auto` detection — command-line matching against real `uv`-launched command lines, and both PowerShell date serialisations.

**Exit Code Handling**: `ssh.js` rejects connections when a remote command exits with a non-zero status. Both the backend probe command and the final sysfs dump command conclude with shell tests that legitimately fail on healthy machines. Both commands must explicitly force a zero exit code. `commands.test.js` asserts this behavior.

**Debug Endpoints**: See the Commands table for the full list on port `17580`. The four that report state rather than driving the UI:

*   `GET /gpu/backends`: Reports the resolved backend for each host and lists any null metrics per GPU.
*   `GET /debug/strip`: Reports the Claude usage strip geometry and identifies any overlapping elements.
*   `GET /debug/gauges` and `GET /debug/corvette`: Dump per-skin element geometry, for checking a layout at a given window size without eyeballing a screenshot.
*   `GET /debug/claude-config`: Despite the name, this *drives* the UI rather than reporting state — it clicks the Claude accounts button and reports whether the modal opened and how many account rows it holds.
*   `GET /debug/settings`: Also drives the UI. Settings has no in-app button, so this sends the same `open-settings` message the tray does, then reports the card and viewport rectangles, whether the card fits, whether Close is on screen, and whether the scroll region has more content than it shows. Resize first (`/resize?w=&h=`) to test a size.

## Modal Sizing

A `.modal-overlay` centres its card, so a card taller than the window is clipped at the top **and**
bottom at once — the title and the buttons leave the screen together, and a dialog with no visible
Close is a dead end. The window minimum is 320x200, which is shorter than several of these dialogs,
so every `.modal-card` carries `max-height: 86vh` with `overflow-y: auto`.

Settings gets more than that, because it grows a section whenever a feature gains a toggle. It is a
flex column with `overflow: hidden`; the title and the footer holding Close are `flex-shrink: 0`,
and only `.modal-scroll` between them scrolls. Close therefore stays on screen at any window size.
`min-height: 0` on that scroll region is load-bearing for the same reason it is on the tab panel: a
column flex item is laid out at its content height and will not shrink below it unless told to.

Its inline `style` attributes were replaced with classes at the same time. They were dead: the CSP
is `style-src 'self'` with no `unsafe-inline`, which blocks style attributes as well as style
elements, so every `style="..."` in that markup had been silently ignored. Dynamic styling goes
through `element.style` from JS, which the CSP does allow.

Measured at 407x198, one step off the minimum: card 367x171, fits the viewport, Close visible,
scroll region showing 33px of 355px of content.

**Mock Data**: Launch the application with the `--mock-amd` flag to test the UI against sparse AMD telemetry. This mode feeds mock data shaped like AMD outputs, deliberately omitting fan speed and, on certain cards, power cap data.

## Window Layout

The window is a flex column at `height: 100vh` with `overflow: hidden` on `body`. Nothing is
`position: fixed`. The tab bar, the Claude strip in either dock, and the status bar are ordinary
flow items with `flex-shrink: 0`, and `.tab-panel.active` is the only scrolling element
(`flex: 1 1 auto; min-height: 0; overflow-y: auto`). The status bar height lives in
`--status-bar-h` rather than being repeated at each use.

This replaced a fixed-position status bar that the panel compensated for with a magic
`padding-bottom`. Padding only clears an overlay at maximum scroll, so at scroll-top any element
at the end of the panel sat behind the bar — visible at narrow widths, where the grid drops to one
column and the content overflows. A fixed bottom dock had the same defect, worse.

`min-height: 0` on the scrolling panel is load-bearing. It is the column-direction cousin of the
`flex-shrink: 0` trap recorded for the Claude strip: a flex item is laid out at its max-content
size and will not shrink below it, so without that declaration the column overflows the viewport
and the overlay behaviour returns.

## Code Standards
- contextIsolation: true, nodeIntegration: false. Narrow contextBridge API.
- Strict CSP in renderer (`default-src 'self'`).
- No shell injection: fixed nvidia-smi query strings, no dynamic interpolation.
- Validate all external input. HTML-escape all renderer data.
- Credentials: prefer SSH keys. Passwords via Electron safeStorage, never plaintext.
- Clean, minimal, human-readable. Short focused files. Match surrounding style.

<!-- BEGIN LOCAL-LLM-DELEGATION v1 -- canonical block, identical in every project. Source of truth: ~/.claude/CLAUDE.md. Re-sync by replacing between these two markers. -->
## Local LLM Delegation

A project `CLAUDE.md` overrides the global one, so the operative rules are restated here rather
than left to be inherited. Full detail, measurements and history live in `~/.claude/CLAUDE.md`.

**Cost order, cheapest first: local Qwen boxes `.70` + `.100` (BOTH FREE) > Haiku > Opus.**
Latency does not matter — a slow free path beats a fast paid one. Delegate by default; keep on
Opus only final go/no-go gates, orchestration decisions, and ambiguous design calls. **Report
every delegation:** which box, what was sent, rough tokens in/out. State explicitly when a task
used no local LLM at all.

- `.100` = `http://192.168.50.100:8080` (1 slot, ~42 tok/s, **primary**). `.70` =
  `http://192.168.50.70:8080` (2 slots, ~10-17 tok/s). 3 slots total; batch 4+ tasks in threes.
  Call with curl or node `fetch` — these are not pluggable into the Agent tool.
- **Always send `"chat_template_kwargs": {"enable_thinking": false}`** or the reply comes back
  empty (Qwen spends the whole `max_tokens` budget on `reasoning_content`).
- **The SessionStart probe reports four states: UP / LOADING / BUSY / DOWN.** Hold its result for
  the session; do not re-probe before each call. But:
  - **LOADING is not down.** llama.cpp binds its port immediately and answers **HTTP 503 until the
    model is resident** — minutes, for a 27B Q8_0. A box shown LOADING or DOWN gets **one**
    re-probe before the first real delegation. Never write off a box for a whole session on the
    strength of one probe line.
  - **`0/N slots idle` = BUSY**, not down: the call queues, and it is still free.
  - **Bryan asking why a box is unused IS a re-probe trigger.** Re-probe, then answer — do not
    explain the held result back to him.
- **DRY splits by literal density, not code-vs-prose.** Anything that must reproduce identifiers
  verbatim (codegen, diff and code review, error/log analysis): **no** `dry_multiplier`, **no**
  `repeat_penalty`, `temperature: 0`. Free-form prose with no repeated literals: `"dry_multiplier":
  0.8`. DRY corrupts repeated tokens — renamed identifiers, dropped tokens, mangled file paths.
- **CODEGEN = skeleton only.** Send the target file with real imports, signatures and comments and
  `// TODO:` bodies: *"fill only the TODO bodies, change nothing else, return the complete file."*
  Free-form "write this module" fails (restarts mid-file, duplicate imports). Prepend a
  ~100-token house-rules block for repo style — the model cannot know local lint/naming rules.
- **REVIEWS:** `max_tokens` 8192+, inputs <=3k (one sliced file or a plan — never a whole diff;
  value drops sharply as input grows). Force a line format, and **include one worked example line
  with REAL content**: a format made of bare field names gets echoed literally, e.g.
  `1. 138 -- problem -- fix -- confidence(high)`. **Never name a finding count**, not even
  "up to N, stop when out, never pad" — the number is the anchor and the model pads to it. Cap on
  my side, after the response.
- **Local review is a candidate generator, never a verdict** (~40% precision, sometimes 0 of 12).
  Verify every finding against the source before acting. **The same prompt on both boxes is not a
  second opinion** — same model and quant produce near-identical lists; vary the *lens* instead
  (correctness / boundary conditions / "what did the author verify on only one machine").
- **Vision** is reliable for transcription (read a table, a count, a value) and unreliable for
  judgement (it called by-design text truncation an overlap). Take and read screenshots myself
  regardless; never accept a model's description of an image as the finding.
- **Failure protocol:** if a result looks wrong, fix **my** prompt or params and retry first —
  every "the model can't do it" so far has turned out to be my setup. If it still fails, STOP and
  report exactly what was tried. Quietly doing the work myself instead is not an acceptable
  outcome. Same for transport errors: diagnose, retry once, then report.
<!-- END LOCAL-LLM-DELEGATION v1 -->
