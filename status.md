# guiTOP — Session Handoff

_Last updated: 2026-07-25 v0.3.1. Read this + `CLAUDE.md` once at session start._

## RESUME HERE — open item

**AMD parsers have never run against real AMD hardware.** They were written from AMD's
documented schemas plus synthetic fixtures. A friend of the user is testing v0.3.1 on real
AMD hardware.

To close this out, get a capture from that machine and tune against it:
```bash
node tools/gpu-probe.js --json > gpu-probe.json
```
Highest-risk fields, in order:
1. **fan speed** — cards report RPM, percent, or raw 0–255 PWM depending on model. `pickFan()`
   in `src/collectors/amd-smi.js` guesses by range; a wrong guess yields `null`, not a wrong number.
2. **power cap key name** — `limit.max_power` on ROCm 6; other versions differ.
3. **VRAM units** — MB in some ROCm versions, raw bytes in others. `toMib()` falls back to a
   "greater than 1,000,000 means bytes" heuristic when no unit string is present.

Everything degrades to `null` rather than throwing, so the failure mode is a blank field.

Also deferred (do these together in one release, per user):
- **App icon**: `assets/images/app-icon.ico` is committed but electron-builder has no `icon`
  key, so all builds log "default Electron icon is used". User accepts the generic icon for now.
- **AUTO cswap-daemon detection**: still hardcoded off (open since 2026-07-17).

## Current State

### v0.3.1 — AMD GPU support (Linux) + Claude strip layout fix (this session)
- AMD GPUs collected alongside NVIDIA on Linux. Three backends, auto-detected per host and
  cached: `amd-smi` (ROCm 6+), `rocm-smi` (legacy fallback), bare `amdgpu` sysfs (no ROCm needed).
- New: `src/collectors/amd-smi.js`, `amd-sysfs.js`, `vendor.js`, `tools/gpu-probe.js`, `test/`.
- Mixed NVIDIA+AMD on one host works: both poll, results merge, later backends shift past
  earlier ones so display indices stay unique (`nativeIndex` keeps the per-vendor index).
- `npm test` — 107 assertions, 4 suites, no framework, no deps.
- Fixed: Claude usage strip overlapped itself (nowrap text had default `flex-shrink: 1`, shrank
  below content width and spilled onto neighbours; strip's own `cqw` gap/padding queried an
  outer container since an element cannot query itself → dock is now the query container).
  Verified 0 overlaps 480–1600px × 3 skins × both docks via new `/debug/strip`.
- Fixed: corvette skin blanked the power readout when `powerLimit` was null (the common case on
  consumer AMD). Now shows draw, bar scaled to a 350W nominal ceiling.
- New dev endpoints on :17580 — `/gpu/backends`, `/debug/strip`.
- Architecture and usage documented in `CLAUDE.md` (AMD GPU Support / Capturing Real Hardware
  Output / Testing sections).

### v0.3.0 — real cswap account management (prior session)
- Real cswap account management, fable meter, live countdowns, responsive strip.

### v0.2.3 — Claude usage + Linux builds
- Claude usage strip: replaced local JSONL scanner with `cswap list --json` polling
- Session/Week percentages now match online Claude account (not local transcript heuristics)
- Display name: `GUITOP_DISPLAY_NAME=an80sPWNstar` set in main.js (privacy)
- Linux builds: AppImage + .deb; scripts `build:win` (WSL→PowerShell), `build:linux` (native)

### v0.2.2 — Claude usage strip
- Full Claude usage + swap strip integration (15 files)
- Session/week/reset/today meters + per-account cswap chips
- Dockable: top/bottom/off, persisted in localStorage; skinned for all three themes

### Inherited (prior)
- Three skins: Bars, Gauges, C4 Corvette (dropdown selector)
- Process table with sortable columns (GPU|PID|USER|CPU%|MEM%|TIME|PROCESS|VRAM)
- Host management UI: Add/Remove/Reconnect with SSH fingerprint verification
- Dev HTTP server on port 17580: screenshot, skin/tab/host/claude endpoints
- Electron 31, ssh2 transport, safeStorage for passwords

## Gotchas (bit us, don't re-learn)
- **`ssh.js` rejects on non-zero remote exit.** Any probe command ending in a shell test that
  legitimately fails (no amdgpu card, no `pp_dpm_sclk`) marks the WHOLE HOST down. Both fixed
  commands end `; true`; `test/commands.test.js` guards it.
- **Non-AMD DRM cards.** NVIDIA and Intel also create `/sys/class/drm/cardN`, so the sysfs
  backend only reports cards whose `uevent` says `DRIVER=amdgpu`.
- **Stale packaged `guiTOP.exe`** (`C:\Users\Bryan\AppData\Local\Programs\guitop\`) grabs :17580
  and shadows the dev instance — the dev server then silently loses the port and serves the OLD
  routes. Kill it before dev launch.
- **Linux build round-trip.** `npm install` from WSL swaps native modules to Linux; you MUST run
  `npm install` from Windows again afterwards or the Windows app breaks. Verify by checking a
  REMOTE SSH host still reports GPUs (that exercises ssh2/cpu-features).
- **`--mock-amd`** feeds AMD-shaped mock data with deliberate gaps (no fan%, no power cap on some
  cards) to test the UI against sparse telemetry without AMD hardware.

## Disk Layout
- **Source**: `E:\vs_code_projects\guiTOP\`
- **WSL path**: `/mnt/e/vs_code_projects/guiTOP/`
- **GitHub**: `an80sPWNstar/guiTOP` — **PUBLIC** as of 2026-07-25 (user confirmed intentional)
- **gh CLI**: installed at `C:\Program Files\GitHub CLI\gh`, authed via `GH_TOKEN` env (scope
  `repo`). Use it for releases — the GitHub MCP tools have no release endpoints.
- **Build output**: `dist\guiTOP Setup 0.3.1.exe` (75MB), `dist/guiTOP-0.3.1.AppImage` (103MB),
  `dist/guitop_0.3.1_amd64.deb` (71MB). All unsigned.
- **Release**: https://github.com/an80sPWNstar/guiTOP/releases/tag/v0.3.1

## Git
```
an80sPWNstar/guiTOP, branch main
Commits this session:
  366ac84 chore: sync package-lock version to 0.3.1
  f36fb40 feat: AMD GPU support (Linux) + Claude strip layout fix (v0.3.1)   [tag v0.3.1]
```
Note: tag `v0.3.1` points at f36fb40, one commit before the lockfile sync. Deliberate — the
tag was already pushed and the lockfile version field is cosmetic.

Left untracked on purpose: `guiHTOP-framework-plan.md` (sibling project doc).
`scratchpad/` is now in `.gitignore`.

## Sibling Project
- **guiHTOP** at `E:\vs_code_projects\guiHTOP\` — same architecture, monitors Linux /proc stats
- 2026-07-19: ported Claude usage/swap integration to guiHTOP (3 new files + 4 wired)
- AMD support has NOT been ported there (guiHTOP monitors CPU/proc, not GPUs)
