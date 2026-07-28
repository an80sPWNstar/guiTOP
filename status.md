# guiTOP — Session Handoff

_Last updated: 2026-07-27. Read this + `CLAUDE.md` once at session start._

## RESUME HERE

**v0.3.3 is committed and pushed to `main`.** Tests 8/8, 229 assertions. Three commits:
`b3d05ae` the AMD pwm1 fan fix, `42ce06d` the app work (AUTO chip, icon, window state,
0600 session key), `f31c464` docs. Version and `package-lock.json` both at 0.3.3.

**Not done and deliberately not started: no git tag, no GitHub release, no installers built.**
Ask before doing any of those. v0.3.1 and v0.3.2 both shipped installers via a GitHub release,
so a tester expecting one will not find it yet.

Apollo has been sent the relay: what changed, the two requests below, and the note that
`amd-smi` remains the last unvalidated parser.

**Fan-percent question: ANSWERED and FIXED (2026-07-27).** Apollo confirmed from a
matched-moment hwmon capture on the RX 9070 XT (`/sys/class/hwmon/hwmon2`, `0000:2d:00.0`):
`pwm1` = 89, `pwm1_max` = 255, 89/255 = 34.9% = the 35% `rocm-smi` reports, and `rocm-smi`'s
`Fan speed (level)` is the integer 89 — literally `pwm1`, not derived. The RPM ratio was off
by the predicted ~4 points. `src/collectors/amd-sysfs.js` now prefers `pwm1 / pwm1_max` and
falls back to `fan1_input / fan1_max` only when `pwm1_max` is absent.

Two traps in that fix, both load-bearing:
- **`pwm1_enable` does not exist on this card.** Do not gate the PWM path on it — that would
  force the RPM fallback on exactly the hardware the fix targets. (`pwm1_min` and `fan1_min`
  do exist, both 0.)
- **Read `pwm1_max`, never hardcode 255.** It happens to be 255 here. Guessing a divisor is
  how a fan meter ends up reading 200%.

Still worth having when he next runs it: a full `node tools/gpu-probe.js --json` with `pwm1`
in it, so `test/real-hardware.test.js` can pin the sysfs fan value at 35 instead of the 31 the
pre-pwm1 capture forces.

Also open, all three unanswered by the user:
- Tag + GitHub release + installers for v0.3.3 (see above).
- `fetchUsage` in `src/collectors/claude-web.js` is exported and never called — dead code.
- The **bottom** dock was never swept for the strip layout fix; only the top dock was verified.
- main.js still has two hardcoded `cmd.exe` cswap call sites (`runCswapCmd`, and the `spawn`
  for `add-token`) that never moved to `cswapCmd`, so they stay Windows-only.

**Separate project spun off:** `E:\vs_code_projects\lanllm` — a skill to make local-LLM
delegation one step, plus a `PreToolUse` hook denying paid subagents until the free boxes have
been probed. Scaffold only, one commit, no remote. Build it in its OWN session, not here;
`KICKOFF.md` in that repo holds the brief.

Still-unvalidated: the **amd-smi** parser has never run against real hardware (`amd-smi` was
absent on the only AMD box we have access to). Unverified guesses live in
`src/collectors/amd-smi.js`: `pickFan()` (RPM vs percent vs raw PWM), the power-cap key name,
and `toMib()`'s "over 1,000,000 means bytes" fallback. A capture from an Instinct card or a
ROCm 6 machine would close it. **rocm-smi is now proven** — see below.

### Session 2026-07-27 — second capture, then four fixes while waiting

Two files arrived: `E:\Downloads\gpu-probe-v032.json` and `E:\Downloads\rocm-smi-working-capture.json`
(the latter hand-run, because our probe only issued `--showallinfo`, which is exactly the call
that aborts there — now fixed with a `rocm-smi.narrowed` probe).

1. **The 07-26 hardware identification was WRONG.** That machine is a discrete **Sapphire RX
   9070 XT** (Navi 48, gfx1201, PCI `1002:7550`), not a Radeon 8060S / Strix Halo APU. Corrected
   in `CLAUDE.md` and `test/real-hardware.test.js`. Consequence: "APUs have no product_name" was
   the wrong lesson — a *discrete* card had none either.
2. **`parseRocmSmi` was correct on every real field except one key-order dependency.** The card
   emits BOTH `Fan speed (level)` (raw PWM 0-255 = 89) and `Fan speed (%)` (= 35), and a bare
   `k.includes('fan speed')` let whichever arrived last win — 89 would have rendered as 89% fan.
   Percent is now matched first, level only used as `level / 255`. The test re-parses the same
   capture with its keys reversed so nothing can depend on emission order again.
3. **App icon wired** (deferred item, done). electron-builder had no `icon` key. Now `win.icon` +
   `linux.icon`, and `main.js` picks `.ico` on Windows / `.png` elsewhere for BrowserWindow and
   Tray, because Electron does not read `.ico` on Linux. Every entry in that ICO is PNG-encoded,
   so `assets/images/app-icon.png` was unpacked from its 256px entry — no new art. Verified the
   icon bytes are present in the built `guiTOP.exe`.
4. **Window geometry persistence** (deferred item, done). Debounced 500ms save of `getNormalBounds`
   + maximized flag; saved coordinates honoured only if the rect still intersects a live display's
   `workArea`. Verified: 1240x764 and 800x600 both survive a restart, off-screen coords recover.
5. **cswap AUTO detection** (open since 07-17, was hardcoded `autoOn: false`). `cswap auto` is a
   foreground loop — no daemon, no pidfile — so detection has to find the process.
   **KEY FACT: `uv`-installed tools run as `python.exe` with the shim path in the command line,
   so the process NAME tells you nothing; the COMMAND LINE must be matched.** One
   `Get-CimInstance Win32_Process` call, measured 230ms. `wmic` is gone from current Windows.
   `pgrep -af cswap` elsewhere (no start time there, so `autoSinceMin` is null).
   **GOTCHA: `powershell.exe` is Windows PowerShell 5.1, whose `ConvertTo-Json` serialises a
   DateTime as `/Date(1769...)/` — `new Date()` on that yields Invalid Date.** Both that and the
   PS7 ISO form are handled and tested. Live-verified against a real `cswap auto --dry-run`.
6. **Cross-platform bug:** `cmd.exe /c cswap` was hardcoded at 4 call sites, so the Claude strip
   was dead on the Linux AppImage/.deb builds. Centralised in `src/collectors/cswap-cmd.js`.
7. **claude.ai session key hardened.** `writeStore` had no mode, so `claude-web.json` landed at
   0644 — world-readable, and that applied to the ENCRYPTED blob too. Now 0600 always. When
   `safeStorage` reports no keyring (Linux with no keyring daemon; never on Windows/DPAPI) a
   one-time consent dialog appears, defaulting to REFUSE; refusing keeps the key in memory for
   that run only, and also clears any key already on disk so a stale credential cannot silently
   log the next launch in as the previous session. Prior plaintext counts as consent. Settings
   shows encrypted / plaintext / memory. `test/claude-web.test.js` stubs `electron` in
   `require.cache` to drive this headlessly.
8. **Claude strip wrap regression, caused by item 5 and now fixed.** `autoOn` had been false
   forever, so that field always read `OFF`; `ON · 23M` pushed the strip past its width budget
   and — per the 07-25 "text never shrinks, the strip wraps" rule — AUTO wrapped alone onto a
   second row, which reads as a layout bug. Fixed in three parts: `TOKENS TODAY` now hides when
   `todayTokens` is null (neither usage source fills it since the JSONL heuristic died, so it was
   ~110px showing `--`), the gap cap dropped to 18px, and divider + chips + AUTO were grouped
   into a `.cu-swap` cluster that wraps as a unit.
   **THE REAL TRAP, worth remembering: a flex item with `flex-shrink: 0` is laid out at its
   max-content width, so an inner `flex-wrap` NEVER triggers and the cluster overflows instead
   of wrapping.** Two fixes were wasted before spotting that. `.cu-swap` is deliberately
   shrinkable; the chips and AUTO inside keep their own `flex-shrink: 0`.
   Verified with `/debug/strip` (`stripHeight` 38 = one row) across 1400 → 320px, on all three
   skins, with both real data and `GUITOP_SWAP_MOCK=1` (3 accounts, AUTO ON): single row down to
   900px with the real single account, no overflow and no overlap at ANY width. Was breaking at
   1240px before.

### Verification gotcha found this session

`GET /screenshot` does NOT return the PNG. It writes it to `%TEMP%\guitop-screenshot.png` and
returns `{"ok":true,"path":...}` — 82 bytes of JSON. Saving the response body gives an 82-byte
file that is not an image. Read the file at that path instead.

### What the earlier capture (2026-07-26) taught us

Same machine as above (correctly identified as the RX 9070 XT this time), CachyOS, ROCm 7.2,
rocm-smi 4.0.0. Capture kept at `E:\Downloads\gpuprobe.json`; distilled into
`test/real-hardware.test.js`.

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
5. **This card has no `product_name`** (originally written up as an APU trait — it is not, the
   card is discrete), so it names itself from its PCI id and displays as "AMD GPU 7550" rather
   than "Radeon RX 9070 XT". Cosmetic, left alone. If it ever matters, the
   fix is a one-shot lookup in `/usr/share/hwdata/pci.ids` (present on most distros) cached
   per host; do NOT interpolate the device id into a shell command.

Both items that were deferred here — the app icon and AUTO cswap detection — are DONE as of
2026-07-27, uncommitted. See the session notes above.

## Current State

### v0.3.2 — AMD fixes from the first real-hardware capture (this session)
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
- **DRY corrupts literals when delegating prose to a local LLM.** Release notes came back with
  `gpu-prove.js`, `guiTOP Setup 0.2.exe` — filenames mangled because `dry_multiplier` penalises
  repeated token runs. Any output containing exact filenames, versions or flags must be generated
  with DRY off (temp 0), same rule the global CLAUDE.md already gives for code.

## Disk Layout
- **Source**: `E:\vs_code_projects\guiTOP\`
- **WSL path**: `/mnt/e/vs_code_projects/guiTOP/`
- **GitHub**: `an80sPWNstar/guiTOP` — **PUBLIC** as of 2026-07-25 (user confirmed intentional)
- **gh CLI**: installed at `C:\Program Files\GitHub CLI\gh`, authed via `GH_TOKEN` env (scope
  `repo`). Use it for releases — the GitHub MCP tools have no release endpoints.
- **Build output**: `dist\guiTOP Setup 0.3.2.exe` (75MB), `dist/guiTOP-0.3.2.AppImage` (103MB),
  `dist/guitop_0.3.2_amd64.deb` (71MB). All unsigned.
- **Release**: https://github.com/an80sPWNstar/guiTOP/releases/tag/v0.3.2

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
