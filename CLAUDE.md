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

AMD GPU support is Linux-only. The application attempts to detect and use backends in the following order of preference:

1.  **amd-smi**: The modern tool for ROCm 6.0+.
2.  **rocm-smi**: Legacy tool (deprecated since ROCm 3.9), used only if `amd-smi` is absent.
3.  **amdgpu sysfs**: A bare reader requiring no ROCm installation.

Backend detection runs once per host on its first poll and is cached for the process lifetime. No per-host configuration is required, and the host list format remains unchanged.

A single host may contain both NVIDIA and AMD GPUs. Both backends execute concurrently, and their results are merged into a unified list. Each backend indexes its cards starting from zero; to ensure unique display indices, later backends are offset by the count of GPUs from earlier backends. The original per-vendor zero-based index is preserved in the `nativeIndex` field of each GPU object. Every GPU object includes a `vendor` field set to either `'nvidia'` or `'amd'`.

Process-level GPU data is available only via the `amd-smi` backend. The `rocm-smi` and sysfs backends do not provide process lists.

Windows AMD support is intentionally omitted. Neither `amd-smi` nor `rocm-smi` ships for Windows. While existing Windows performance counters can provide GPU utilization and per-process VRAM usage, they cannot report temperature, power, clock speeds, or total VRAM. This would result in incomplete card representations. Full Windows support would require a native addon integrating LibreHardwareMonitor or the AMD ADLX SDK.

Field coverage varies between consumer Radeon and Instinct cards. Additionally, the `amd-smi` JSON schema is unstable across ROCm versions. Parsing is defensive: unexpected payloads result in an empty list rather than an exception, and missing individual metrics are set to `null` rather than discarding the entire GPU object.

## Capturing Real Hardware Output

Parsers were developed against documented schemas and synthetic fixtures. Verify new fields against real hardware output before relying on them.

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
