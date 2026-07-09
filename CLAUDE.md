# guiTOP

## What This Is
A Windows desktop app that provides a GUI for GPU monitoring (a "GUI for nvitop"). It shows
live NVIDIA GPU stats as a **native dashboard** of custom widgets (gauges, bars, cards) — not
embedded terminals. Two tabs:
1. **Single** — one chosen machine's GPUs.
2. **Multi** — a grid of multiple machines on the local network at once.

The window is **resizable**. A per-host **process table is available but hidden by default**,
revealed via a toggle.

This project deliberately inherits the architecture, conventions, and standards of its sibling
**tempsLCD-web** (`~/workspace/projects/_reference_tempsLCD`, an Electron hardware-stats widget).
Reuse from it wherever it saves time; see "Reuse Map" below.

## Tech Stack
- **Runtime:** Electron (Chromium + Node.js) — same major line as tempsLCD-web (v31).
- **Language:** JavaScript. Renderer is plain HTML/CSS/JS.
- **Main process:** `main.js` — creates the resizable BrowserWindow, owns the collector service, pushes data over IPC.
- **IPC bridge:** `preload.js` — `contextBridge` exposes a narrow `window.guiTOP` API. `contextIsolation: true`, `nodeIntegration: false`.
- **Renderer:** `renderer/` — tabbed UI, GPU cards, process table.
- **Data source:** **`nvidia-smi` over SSH** (and locally for the host we run on). No nvitop or Python required on monitored machines — only the NVIDIA driver. SSH transport via `ssh2`.
- **Build target:** Windows `.exe` via electron-builder. **Dev happens on the Linux box `family-llm`** (which is also the first monitor target — 3× Tesla P100).

## Project Structure
Mirror tempsLCD-web's layout. Short, focused files; core logic decoupled from UI.
```
guiTOP/
├── package.json            # electron + ssh2 + electron-builder; "start" / "dev" scripts
├── main.js                 # Electron main — resizable BrowserWindow, owns collectors, IPC push
├── preload.js              # contextBridge: window.guiTOP.{onData, listHosts, ...}
├── src/
│   ├── collectors/
│   │   ├── nvidia-smi.js   # the nvidia-smi query strings + a runner (local exec / ssh exec)
│   │   ├── parse.js        # parse CSV output -> structured readings; handles [N/A] -> null
│   │   ├── ssh.js          # ssh2 transport: connect, exec one command, return stdout
│   │   ├── service.js      # PER-HOST poll loop (default 1s), emits {host, gpus, processes, error}
│   │   └── mock.js         # synthetic provider (same shape) for dev without GPUs/hosts
│   └── config/
│       └── hosts.js        # load + VALIDATE the host list (hostname/ip/user/port)
├── renderer/
│   ├── index.html          # tabbed shell (Single | Multi), CSP-locked
│   ├── renderer.js         # subscribes to data, routes to the active tab
│   └── widgets/
│       ├── gpu-card.js     # one GPU: util/mem/temp/power gauges
│       └── process-table.js# compute-apps table — HIDDEN by default + toggle
├── styles/                 # design tokens (borrow from _reference_tempsLCD/design_system/tokens)
└── assets/                 # fonts/icons borrowed as needed
```

## Architecture

### Window
- **Resizable**, framed, normal desktop window (NOT the frameless always-on-top widget tempsLCD uses). Sensible min size; remember last size/position if cheap to do.
- `--dev` flag opens detached DevTools.

### Data Flow
1. **Main process** runs `src/collectors/service.js` once **per configured host**.
2. Each host service polls on an interval (default 1s), running two `nvidia-smi` queries (GPU stats + compute-apps) over its transport (local or SSH), parsing via `parse.js`.
3. Main pushes per-host payloads to the renderer: `win.webContents.send('gpu-data', payload)`.
4. **Renderer** subscribes via `window.guiTOP.onData(cb)`; the Single tab shows the selected host, the Multi tab lays out all hosts in a grid.

### Data Contract
Per poll, per host:
```js
{
  host: "family-llm",                 // label
  ok: true,                           // false if the poll/SSH failed
  error: null,                        // string when ok === false (show in the card, don't crash)
  ts: 1750000000000,                  // epoch ms (stamped in main)
  gpus: [
    { index, name, utilization, memoryUsed, memoryTotal,
      temperature, powerDraw, powerLimit, fanSpeed, clockSm }  // numbers; null when [N/A]/unparseable
  ],
  processes: [
    { gpuIndex, pid, processName, usedMemory }                 // joined to gpu via uuid map
  ]
}
```
- **P100s report `fan.speed` as `[N/A]`** — any unparseable numeric field MUST become `null`, never `NaN`, and the UI must render null gracefully (e.g. "—").
- A host that errors (SSH down, no driver) renders its card in an error state; it must not break other hosts.

## Code Standards

### Security (highest priority)
Inherited from tempsLCD-web, plus SSH/remote-exec rules unique to guiTOP.
- Keep `contextIsolation: true`, `nodeIntegration: false`; expose only narrow APIs via `contextBridge`.
- Keep a strict CSP in the renderer (`default-src 'self'`). No remote resources; inline nothing that a CSP would forbid.
- **Validate all external input:** nvidia-smi stdout, host-config JSON, file paths. Treat command output as untrusted (a process name could contain anything) — never inject it into HTML without escaping, never `eval` it.
- **No shell injection in the SSH/exec layer:** build commands as **fixed, hard-coded `nvidia-smi` query strings**. Never interpolate host/user/any dynamic value into a shell string. Use argument arrays / library exec APIs, not string concatenation into a shell.
- **Credentials:** prefer SSH keys / ssh-agent. **Never store passwords in plaintext**, never write them to config files or logs, never commit them. If a password is ever needed interactively, use it transiently and discard it. (A key install on the Windows host was explicitly declined by the user — do not re-attempt without being asked.)
- **Host config validation:** validate hostname/IP format, port range (1–65535), username charset before use. Reject anything that looks like a shell metacharacter.
- Sanitize any file paths (skins/config): reject `..` segments and absolute paths; enforce expected extension.
- Hex color validation (if skins reuse it): `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`.

### Code Quality
- Clean, minimal, human-readable — no boilerplate walls or mystery abstractions.
- Straightforward implementations over clever patterns.
- Clear naming; comments only when the WHY is non-obvious.
- Short, focused files; core logic decoupled from UI.
- Match the surrounding code's style when extending borrowed files.

### Local-LLM Worker Workflow
This project delegates well-scoped coding to the **local model** (Qwen3.6 on `:8080`) to save Claude tokens; Claude orchestrates, integrates, and VERIFIES every result.
- Drive it with thinking OFF: request body must include `"chat_template_kwargs": {"enable_thinking": false}`. The `/no_think` token does not work on this build.
- Delegate self-contained units (a parser, one widget, one pure function) with the exact I/O spec and real example data. Keep each task within ~700 output tokens to avoid truncation.
- **Never ship its output unverified** — execute/test it. Watch for its known failure modes (over-engineering, shadowing built-ins like `parseInt`, truncation at the token cap).
- Helper: `scratchpad/ask_local.py` (thinking-off by default, extracts first code block).

### Token Efficiency
- Do NOT re-read files already in context.
- Sub-agents / the local model get specific file paths and specs, not "read everything".
- Prefer Grep/Glob over reading whole files to search. Responses short and direct.

## Reuse Map (from `~/workspace/projects/_reference_tempsLCD`)
- **Scaffold:** `main.js`, `preload.js` — Electron window + secure IPC pattern (adapt window to resizable+tabbed).
- **Collector loop:** `src/sensors/service.js` — 1s poll + provider pattern + graceful fallback. Adapt to per-host + nvidia-smi.
- **Widgets/skins:** `renderer/skins/gauges.js`, `renderer/widgets/` — gauges/bars. GPU = blue is already their convention.
- **Design tokens:** `design_system/tokens/*.css` (colors, typography, spacing, effects, materials).
- **Assets:** `assets/fonts`, `assets/icons` as needed.
- Their custom skills in `.claude/commands/` (`/dev`, `/build-phase`, `/audit`) exist and may be carried over if useful.

## Commands
- Run: `npm start`
- Dev (DevTools): `npm run dev`
- Package: electron-builder → Windows `.exe` (configured later).

## Troubleshooting
### Electron won't launch from the Claude Code shell
The Claude Code shell sets `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node
(`require('electron')` returns a path string; `app` is undefined → `Cannot read properties of
undefined (reading 'whenReady')`). Launch from a separate terminal, or `unset
ELECTRON_RUN_AS_NODE` first. (Same gotcha documented in tempsLCD-web.)

### Dev on Linux, target Windows
Develop/run on `family-llm` (Linux); it doubles as the first monitor target (local nvidia-smi).
Windows `.exe` packaging is done via electron-builder. The Windows PC `bryan-dt`
(192.168.50.100) is both a future monitor target and where the reference project originated.

### Incomplete Electron binary after install
If `node_modules/electron/dist/` is missing the binary, the postinstall download stalled — see
tempsLCD-web's CLAUDE.md for the manual-extract fix.
