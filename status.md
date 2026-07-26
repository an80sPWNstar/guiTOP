# guiTOP — Session Handoff

_Last updated: 2026-07-25 v0.3.1. Read this + `CLAUDE.md` once at session start._

## RESUME HERE — open item

**A v0.3.2 release is not built or pushed yet.** The AMD fixes below are committed locally
and verified, but the friend testing on real AMD hardware is still running v0.3.1, which
shows his machine as a **dead host**. He needs a new build to see anything at all.

Remaining validation gap: the **amd-smi** and **rocm-smi** parsers have still never run
against real hardware. The capture we got had `amd-smi` absent and `rocm-smi` aborting, so
only the **sysfs** reader is proven. A capture from an Instinct card or a ROCm 6 box would
close it. Still-unverified guesses live in `src/collectors/amd-smi.js`: `pickFan()` (RPM vs
percent vs raw PWM), the power-cap key name, and `toMib()`'s "over 1,000,000 means bytes"
fallback.

### What the real capture (2026-07-26) taught us

Machine: Radeon 8060S / Strix Halo APU (PCI `1002:7550`), CachyOS, ROCm 7.2, rocm-smi 4.0.0.
Capture kept at `E:\Downloads\gpuprobe.json`; distilled into `test/real-hardware.test.js`.

1. **The sysfs reader was exactly right.** Every field it produced checked out against the
   raw capture: 1698/16304 MiB, 32 C edge, 52 W, 374 W cap, fan 1533/5000 = 31%, 1943 MHz
   (agreeing with the starred `pp_dpm_sclk` line). No unit heuristic was wrong.
2. **`rocm-smi --showallinfo --json` aborts** on ROCm 7.2 — a python assertion inside
   `get_od_clk_volt_info`, reached via the overdrive clock/voltage table. We parse nothing
   from that table. `ROCM_CMD` now asks only for the fields `parseRocmSmi` reads.
3. **That crash used to kill the whole host.** `vendor.js` picked `rocm-smi` because it was in
   `PATH` and an `else if` chain suppressed sysfs entirely; the sole backend then threw and
   `pollBackends` reported the host unreachable — with complete telemetry sitting unread in
   sysfs. Detection now reports *every* backend and the poll loop walks them best-first.
4. **DRM numbering does not start at 0.** The only GPU was `card1`, so it rendered as "GPU 1"
   and the merge offset left a phantom slot. sysfs cards are now renumbered 0..N-1 with the
   real number kept in `drmCard`.
5. **APUs have no `product_name`**, so the card names itself from its PCI id — displays as
   "AMD GPU 7550" rather than "Radeon 8060S". Cosmetic, left alone. If it ever matters, the
   fix is a one-shot lookup in `/usr/share/hwdata/pci.ids` (present on most distros) cached
   per host; do NOT interpolate the device id into a shell command.

Also deferred (do these together in one release, per user):
- **App icon**: `assets/images/app-icon.ico` is committed but electron-builder has no `icon`
  key, so all builds log "default Electron icon is used". User accepts the generic icon for now.
- **AUTO cswap-daemon detection**: still hardcoded off (open since 2026-07-17).

## Current State

### Unreleased — AMD fixes from the first real-hardware capture (this session)
- Backend detection no longer suppresses fallbacks. `vendor.js` reports every backend found;
  `service.js` groups them into slots (one slot = one set of cards = one winning backend) and
  walks each slot best-first, keeping the first backend that actually returns a card. Winner
  remembered per host, forgotten the moment it stops delivering.
- AMD preference order changed to **amd-smi > amdgpu sysfs > rocm-smi**. sysfs was promoted
  above rocm-smi on evidence: same fields, a file read instead of a python spawn every second,
  and a layout that does not move between ROCm releases.
- `ROCM_CMD` narrowed off the overdrive clock table that aborts on ROCm 7.2.
- sysfs GPUs renumbered densely; real DRM number kept in `drmCard`.
- `npm test` — 148 assertions, 6 suites (added `real-hardware.test.js`, `fallback.test.js`).
- Verified NVIDIA is untouched: both hosts still `ok`, indices 0/1/2, no warnings, 27 and 3
  processes. `Family-LLM` is remote, which exercises the ssh2 path through the refactor.

### v0.3.1 — AMD GPU support (Linux) + Claude strip layout fix (prior session)
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
- **A GPU tool being installed does not mean it works.** Never let a single detected backend be
  the only thing standing between a host and "unreachable". This cost us a completely dead host
  on the first real AMD machine we ever saw. `test/fallback.test.js` guards it.
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
