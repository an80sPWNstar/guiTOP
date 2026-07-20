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
└── assets/fonts/           # DSEG, Orbitron, Rajdhani, Share Tech Mono
```

## Architecture

### Data Flow
1. Main process runs `service.js` once per configured host (1s poll).
2. Each host poll runs nvidia-smi over local or SSH transport.
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
| `npm run build` | Windows NSIS .exe (Windows only, needs wine from WSL) |
| `npm run build:win` | Windows .exe from WSL (delegates to PowerShell) |
| `npm run build:linux` | Linux AppImage + .deb (from WSL/Linux) |
| `curl localhost:17580/screenshot` | Screenshot API |
| `curl localhost:17580/claude/toggle` | Toggle Claude strip |
| `curl localhost:17580/skin/bars\|gauges\|corvette` | Switch skin |
| `curl localhost:17580/tab/single\|multi` | Switch tab |

## Build Notes
- **Cross-compile Windows from WSL**: use `npm run build:win` (PowerShell delegation). Direct `npm run build` fails — needs wine.
- **Linux build from WSL**: `npm run build:linux`. Requires Linux-native ssh2 (`npm install` from WSL).
- **After Linux build**: restore Windows modules via `powershell.exe -Command 'npm install'` or next Windows build will fail.
- **Python 3.13**: needs `pip install setuptools` on Windows (distutils removed).
- **Claude Code shell**: sets `ELECTRON_RUN_AS_NODE=1` — clear it before launching: `$env:ELECTRON_RUN_AS_NODE = $null`.

## Code Standards
- contextIsolation: true, nodeIntegration: false. Narrow contextBridge API.
- Strict CSP in renderer (`default-src 'self'`).
- No shell injection: fixed nvidia-smi query strings, no dynamic interpolation.
- Validate all external input. HTML-escape all renderer data.
- Credentials: prefer SSH keys. Passwords via Electron safeStorage, never plaintext.
- Clean, minimal, human-readable. Short focused files. Match surrounding style.
