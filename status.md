# guiTOP — Build Status / Session Handoff

_Last updated: 2026-06-24. Read this + `CLAUDE.md` once at session start. Don't re-derive what's below._

## Where you are
This project is developed on **Windows** (`bryan-dt`, E:\vs_code_projects\guiTOP). The remote
Linux box **family-llm** (3× Tesla P100) is a monitored target via SSH. The reference project
`_reference_tempsLCD` lives on family-llm at `~/workspace/projects/_reference_tempsLCD` — NOT
accessible from this Windows machine.

## Electron on Windows
- node_modules had **Linux binaries** from prior dev on family-llm. Fixed by deleting
  `node_modules/electron/dist/` and manually downloading `electron-v31.7.7-win32-x64.zip`
  from GitHub releases, extracting into dist/. Wrote `path.txt` with `electron.exe`.
- **ELECTRON_RUN_AS_NODE** — Claude Code shell sets this, breaks Electron. Must clear it before
  launch: `$env:ELECTRON_RUN_AS_NODE = $null` then `Start-Process` with direct electron.exe path.
- Launch command (from PowerShell):
  ```
  $env:ELECTRON_RUN_AS_NODE = $null
  Start-Process -FilePath "E:\vs_code_projects\guiTOP\node_modules\electron\dist\electron.exe" `
    -ArgumentList "E:\vs_code_projects\guiTOP", "--dev" `
    -WorkingDirectory "E:\vs_code_projects\guiTOP"
  ```
- Kill: `Get-Process -Name "electron" | Stop-Process -Force -Confirm:$false`
- **IMPORTANT**: Never tell user to restart/open/close the app — always do it directly.

## What guiTOP is
A resizable Windows desktop **native dashboard** (custom widgets, NOT embedded terminals) that shows
NVIDIA GPU stats. Two tabs: (1) **Single** chosen host, (2) **Multi**-host grid. Data via
**`nvidia-smi` over SSH** (local exec for localhost). Per-host **process table is hidden by default**
with a toggle. Full spec, architecture, data contract, and security rules are in **`CLAUDE.md`** —
follow them.

## DONE (verified)

### Data Layer (built on family-llm, verified there)
- `package.json` — Electron + ssh2.
- `src/collectors/nvidia-smi.js` — fixed-string queries; `execFile` with arg array (no shell injection).
- `src/collectors/parse.js` — parses CSV from nvidia-smi. P100 `fanSpeed` → `null` (not NaN).
- `src/collectors/ssh.js` — ssh2 transport with **password auth** and **host key verification**.
  `testConnect()` for pre-flight checks. `fingerprint()` computes SHA256. Supports agent + password
  auth (tries agent first, falls back to password). Unknown host keys surfaced to UI for acceptance.
  Known key mismatch = hard reject (MITM warning).
- `src/collectors/service.js` — per-host poll loop (1s default). Error-isolated.
- `src/collectors/mock.js` — synthetic provider with realistic ranges.
- `src/config/hosts.js` — load + validate host list. Rejects shell metachars. **Persistence**:
  `loadSavedHosts()`/`saveHostList()` to `hosts.json` in Electron userData. `loadKnownHosts()`/
  `saveKnownHost()` for SSH fingerprints in `known_hosts.json`. `DEFAULT_HOSTS` uses `os.hostname()`
  for the local machine label (not hardcoded).
- `preload.js` — `window.guiTOP` API: `onData`, `onHostList`, `getHosts`, `addHost`, `removeHost`,
  `editHost`.

### Main Process
- `main.js` — resizable BrowserWindow (960×680, min 640×400). Dynamic host management:
  - `activeHosts[]` + `rawHosts[]` (persisted without passwords) + `hostPasswords{}` (memory only)
  - `add-host` IPC: validates, test-connects (with fingerprint verification flow), starts collector,
    persists. Two-phase: unknown key → return fingerprint → user accepts → re-call with accepted FP.
  - `edit-host` IPC: updates password in memory, restarts collector.
  - `remove-host` IPC: stops collector, removes from list, persists.
  - Passwords **never** written to disk. Session-only. On restart, remote hosts need re-auth via
    Manage Hosts → Reconnect.

### Renderer / UI
- `renderer/index.html` — tabbed shell (Single | Multi), strict CSP. Includes:
  - **Add Host modal**: hostname, username, password, port, label fields. Shows SHA256 fingerprint
    for unknown hosts with accept/reject flow. Button states: Add → Connecting... → Accept & Add.
  - **Manage Hosts modal**: lists all hosts with status (Connected/Error/Waiting), error detail,
    Reconnect button (inline password entry), Remove button.
- `renderer/renderer.js` — tab switching, host selector, data subscription, manage/add host logic.
- `renderer/widgets/gpu-card.js` — **Redesigned with SVG ring gauges**:
  - Two ring gauges per card: Utilization (green→blue→amber by load) and Temperature (green→amber→red)
  - Thick 7px strokes with SVG blur glow filters, tinted tracks
  - Colored center values matching the ring color
  - Below rings: stat bars for VRAM (amber), Power (orange), Fan (yellow), Clock (cyan)
  - Each bar has: colored glowing dot, colored label, tinted track, glowing fill, colored value
  - Card top border color matches GPU utilization state
  - Error cards with red accent
- `renderer/widgets/process-table.js` — compute-apps table with GPU index badges.
- `styles/main.css` — **"Obsidian Glass" theme**: dark glass cards with gradient backgrounds,
  colored accents everywhere, hover glow effects (no bounce/translate), glowing tab indicator,
  backdrop-blur modals, custom scrollbars, tabular-nums throughout.

### Infrastructure
- `.claude/commands/` — `/dev`, `/build-phase`, `/audit` skills.
- `CLAUDE.md` — project rules/standards/structure.

### Verified Working
- **Live GPU data from family-llm over SSH** — password auth + host key acceptance flow works.
- **Local GPU monitoring on Windows** — uses `os.hostname()` for label.
- **Add/Remove/Reconnect hosts** — full lifecycle via UI.
- **Both tabs functional** — Single and Multi views render live data.

## Current Visual State
The GPU cards have SVG ring gauges and colored stat bars, but the user has NOT confirmed the
visual design is satisfactory yet. The latest iteration added heavier colors (thick ring strokes,
SVG glow filters, colored labels/values/dots/bars, tinted bar tracks, dynamic color shifts by
load/temp). **User could not share screenshots in the last session** — visual review is the first
priority for next session. Ask user to describe what they see or share a screenshot.

## NEXT (in order)
1. **Visual review** — get user feedback on current design. May need more iteration on colors,
   layout, gauge sizing, or overall aesthetic.
2. **Polish**: window size/position persistence, better multi-tab layout, per-host process tables
   in Multi tab.
3. **Package**: electron-builder → Windows `.exe`.

## Hosts Config
- **Local**: auto-detected via `os.hostname()` (shows as `BRYAN-DT` on Windows)
- **Remote**: `family-llm` added via Add Host modal (SSH password auth, fingerprint accepted)
- Hosts persist in `%APPDATA%/guitop/hosts.json` (Electron userData)
- Known SSH fingerprints in `%APPDATA%/guitop/known_hosts.json`
- Passwords are **session-only** (memory) — on app restart, use Manage Hosts → Reconnect

## Windows host notes
`bryan-dt` @ **192.168.50.100**, user `bryan` (admin), OpenSSH server. SSH key install was
**declined by the user — do not re-attempt unless asked**.
