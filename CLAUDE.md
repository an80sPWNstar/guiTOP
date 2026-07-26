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
│   │   └── claude-swap.js  # Polls cswap list --json → per-account 5h/7d pct + display name
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
4. Separately: `claude-usage.js` and `claude-swap.js` poll `cswap list --json` every 45s.
5. Renderer subscribes via `window.guiTOP.onData()` / `onClaudeUsage()` / `onClaudeSwap()`.

### Claude Usage Strip
- **claude-usage.js**: calls `cswap list --json`, extracts active account's `fiveHour.pct` → sessionPct, `sevenDay.pct` → weekPct, `fiveHour.resetsAt` → resetMs.
- **claude-swap.js**: same cswap call, extracts per-account 5h/7d pct + alias.
- **Display name**: `GUITOP_DISPLAY_NAME` env var set in main.js; defaults to an80sPWNstar. Falls back to email prefix if unset.
- **Widget**: `renderClaudeStrip()` in renderer.js. Dock cycles top → bottom → off.
- **Dev endpoint**: `GET /claude/toggle` — cycles dock position.

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
| `curl localhost:17580/screenshot` | Screenshot API |
| `curl localhost:17580/claude/toggle` | Toggle Claude strip |
| `curl localhost:17580/skin/bars\|gauges\|corvette` | Switch skin |
| `curl localhost:17580/tab/single\|multi` | Switch tab |
| `curl localhost:17580/gpu/backends` | Which backend each host resolved to + null metrics |
| `curl localhost:17580/debug/strip` | Claude strip geometry + element overlap check |

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

Field coverage varies between consumer Radeon and Instinct cards, and the `amd-smi` JSON schema is unstable across ROCm versions. Parsing is therefore defensive: unexpected payloads result in an empty list rather than an exception, and missing individual metrics resolve to `null` instead of discarding the entire card. APUs often lack a `product_name` file, in which case the card is named from its PCI device id.

Windows AMD support is intentionally omitted. Neither `amd-smi` nor `rocm-smi` ships for Windows. While existing Windows performance counters can provide GPU utilization and per-process VRAM usage, they cannot report temperature, power, clock speeds, or total VRAM. This would result in incomplete card representations. Full Windows support would require a native addon integrating LibreHardwareMonitor or the AMD ADLX SDK.

## Capturing Real Hardware Output

Parsers were developed against documented schemas and synthetic fixtures. Verify new fields against real hardware output before relying on them.

Status: the **sysfs** reader is now pinned to a real capture (Radeon 8060S / Strix Halo APU, ROCm 7.2) in `test/real-hardware.test.js`, and every field it produced was correct. The **amd-smi** and **rocm-smi** parsers have still never run against real hardware — that machine had neither tool working (`amd-smi` absent, `rocm-smi` aborting). Captures from an Instinct or a ROCm 6 box would close that gap.

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
*   `test/real-hardware.test.js`: Pins the sysfs reader to a real capture (Radeon 8060S / Strix Halo APU, ROCm 7.2, GPU at `card1`, no `product_name`) and guards that the `rocm-smi` query stays off the overdrive clock table that aborts on ROCm 7.2.
*   `test/fallback.test.js`: Validates backend slot planning and the best-first fallback walk — a present-but-broken tool must not take a host down while a working backend sits behind it.
*   `test/merge.test.js`: Validates mixed-vendor index merging logic.
*   `test/commands.test.js`: Guards the integrity of fixed remote command strings.

**Exit Code Handling**: `ssh.js` rejects connections when a remote command exits with a non-zero status. Both the backend probe command and the final sysfs dump command conclude with shell tests that legitimately fail on healthy machines. Both commands must explicitly force a zero exit code. `commands.test.js` asserts this behavior.

**Debug Endpoints**: Two endpoints are available on port `17580` for debugging:

*   `GET /gpu/backends`: Reports the resolved backend for each host and lists any null metrics per GPU.
*   `GET /debug/strip`: Reports the Claude usage strip geometry and identifies any overlapping elements.

**Mock Data**: Launch the application with the `--mock-amd` flag to test the UI against sparse AMD telemetry. This mode feeds mock data shaped like AMD outputs, deliberately omitting fan speed and, on certain cards, power cap data.

## Code Standards
- contextIsolation: true, nodeIntegration: false. Narrow contextBridge API.
- Strict CSP in renderer (`default-src 'self'`).
- No shell injection: fixed nvidia-smi query strings, no dynamic interpolation.
- Validate all external input. HTML-escape all renderer data.
- Credentials: prefer SSH keys. Passwords via Electron safeStorage, never plaintext.
- Clean, minimal, human-readable. Short focused files. Match surrounding style.
