# guiTOP — Session Handoff

_Last updated: 2026-07-31 (second session that day). Read this + `CLAUDE.md` once at session start._

## RESUME HERE — 2026-07-31 (session 2)

**DO NOT PUSH ANYTHING.** Bryan's explicit instruction at the close of this session: nothing
goes to GitHub on this repo or any other, and the CLAUDE.md edits below are not to be committed.
`main` is **ahead 6 unpushed** (`47b8eaa` from the prior session plus the five below), with
`CLAUDE.md` and `status.md` modified and `guiHTOP-framework-plan.md` untracked. Leave it that way
until he says otherwise.

**What this session was about.** Bryan reported that Task Manager still showed `guiTOP.exe (264)`
after the previous session's PowerShell fix. It did, and the previous diagnosis was only a third
of the story: the PowerShell parade was ~70/min out of ~310/min. The rest was `nvidia-smi` itself.

`fetchLocal()` ran `execFile('nvidia-smi', ...)` **twice per 1s tick** (one `--query-gpu`, one
`--query-compute-apps`). On Windows each console child also allocates a `conhost.exe`, so steady
state was **4 process creations per second, ~240/min**. Fixed with `nvidia-smi -l 1` loop mode —
one long-lived child per query — in new `src/collectors/nvidia-stream.js`. Measured after: **0 new
children in 100s** on the installed build, against ~240/min before. The only spawns left are the
45s cswap poll (cmd + conhost + cswap + 2 python ≈ 5 per poll), left deliberately.

**Shipped and installed: v0.3.7.** Steady state is 2 `nvidia-smi` + 1 PowerShell for the app's
life. 9/9 suites. Startup registry entry verified pointing at the installed path
(`electron.app.guiTOP` → `...\Programs\guitop\guiTOP.exe`); the stray dev-path entry is gone, so
no re-tick was needed this time.

**A bug shipped in 0.3.6 and was fixed in 0.3.7 — read this before touching the framing.**
`-l` prints the CSV header **once**, not per iteration, so there is no delimiter between samples,
and compute-app rows vary in count so lines cannot be counted. `timestamp` is a valid field on
both queries and was used as the boundary marker — but **rows of one iteration are NOT uniformly
stamped.** `nvidia-smi` re-stamps as it walks the devices: a real 22-row iteration arrives as 21
rows at `.298` and the last row at `.302`. Testing stamps for **equality** split that into a
21-row sample and a 1-row sample, and the process table showed whichever landed last. Now grouped
by a **500 ms window** on the parsed stamps (spread is ~3 ms, gap between iterations is 1000 ms),
comparing the stamps themselves rather than our read times, so a stalled event loop cannot split a
sample either.

**How that bug got past verification, so it does not happen again:** the "all rows share a
timestamp" claim was checked against a 3-row `--query-gpu` output and the **first three rows** of
`--query-compute-apps`. `/gpu/backends` reported "no nulls" and looked perfectly healthy
throughout. It was caught only by comparing the app's `processCount` against `nvidia-smi`'s own
row count — app 21 (and once 1) vs tool 22. **A shape check does not catch a count that is
quietly short. Sample a full period, and compare counts against the source tool.**

**Commits on `main`, all local:**
- `600cc8b` perf: the `-l 1` loop-mode rework
- `3bb1889` chore: v0.3.6
- `1d097cd` fix: the timestamp-window framing fix
- `171fbf8` chore: v0.3.7
- `15b94d2` harden: close the readline interface in `cleanup()`, so a child that exits with rows
  still buffered in stdout cannot publish a torn half-sample
- plus `47b8eaa` (v0.3.5 PowerShell host) still unpushed from the previous session

**Closed out: v0.3.8 is what is installed and running**, built after `15b94d2` so the hardening is
in the shipped build (0.3.7 did not have it). Verified: 2 long-lived `nvidia-smi` children, and the
app's `processCount` equal to `nvidia-smi`'s own row count (23 and 23).

**Uncommitted:** the `package.json` bump to **0.3.8** (deliberately left uncommitted at Bryan's
"don't commit" instruction — `package-lock.json` still says 0.3.7, so reconcile both when this is
eventually committed), `CLAUDE.md` (a `## Local LLM Delegation` block appended — see below),
`status.md` itself, and the untracked `guiHTOP-framework-plan.md` that has been sitting there for
days.

**Tests:** `test/nvidia-stream.test.js`, 38 assertions, framing only. The singleton spawns real
children, so `latest()` staleness is verified live rather than unit-tested. The regression test
pins the real observed shape: a 22-row iteration whose last row is stamped 4 ms later must stay
one sample.

**Outside this repo, same session:**
- **The SessionStart local-LLM probe hook had a real bug.** llama.cpp binds its port immediately
  but answers **HTTP 503 until the model is resident** (minutes for a 27B Q8_0), and
  `Invoke-RestMethod -ErrorAction Stop` throws on a 503 exactly as on connection-refused — so the
  hook's single `catch` reported a loading box as DOWN. `.100` was declared down 26 seconds into a
  model load, and the hold-for-the-session rule wasted it for hours. `~/.claude/hooks/probe-local-llm.ps1`
  now classifies UP / LOADING / BUSY / DOWN. Discriminator, verified under PowerShell 5.1: a 503
  throws `WebException` **with** `$_.Exception.Response`; a refused port throws with **no**
  Response object. All four branches tested against a local stand-in server.
- **The local-LLM delegation rules are now restated in all ten project `CLAUDE.md` files**, behind
  `<!-- BEGIN/END LOCAL-LLM-DELEGATION v1 -->` markers, because a project CLAUDE.md overrides the
  global one. Re-sync by replacing between the markers; do not hand-edit the copies. **None of
  those ten files is committed.**

**Still open, unchanged by this session:** `amd-smi` remains the only unvalidated parser;
`real-hardware.test.js` still pins sysfs fan at 31 pending a `pwm1` capture from Apollo; the
hardcoded date-stamped `anthropic-beta` header in `claude-usage-oauth.js`; the Linux `add-token`
stdin path has never executed anywhere; at 520px the bars skin's `⚡` is still an emoji dependency.

## Earlier handoff — v0.3.3 era (historical, superseded by the section above)

**Note:** this section was already stale before this session — it describes v0.3.3 as current,
while v0.3.4, v0.3.5, v0.3.6 and v0.3.7 have since shipped. Kept for the AMD/Apollo detail.

**v0.3.3 is committed and pushed to `main`.** Tests 8/8, 229 assertions. Three commits:
`b3d05ae` the AMD pwm1 fan fix, `42ce06d` the app work (AUTO chip, icon, window state,
0600 session key), `f31c464` docs. Version and `package-lock.json` both at 0.3.3.

**Tagged, released and shipped.** `v0.3.3` is tagged and published as a GitHub release —
"AMD fan percentage from PWM, AUTO chip, hardened session key", 2026-07-28,
https://github.com/an80sPWNstar/guiTOP/releases/tag/v0.3.3 — carrying all three installers:
`guiTOP.Setup.0.3.3.exe` (78,986,195 bytes), `guiTOP-0.3.3.AppImage` (111,336,143 bytes)
and `guitop_0.3.3_amd64.deb` (77,370,560 bytes).

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

**ELF-in-the-installer defect: FIXED.** `"!node_modules/cpu-features/**"` added to
electron-builder `files`, `.exe` rebuilt and the release asset replaced via
`gh release upload --clobber` (78,986,195 bytes, ~130KB smaller — the dropped `.node`).
`ssh2` was verified to load and connect with the module fully absent: a remote SSH host still
reported its 3 GPUs. It only ever provided hardware-AES detection for cipher ordering, which is
unmeasurable against a few hundred bytes of CSV per second.

Note the exclusion is platform-agnostic, so future **Linux** builds drop it too. The published
`.AppImage` and `.deb` were built before the change and still contain it — harmless, they hold
the correct ELF. Not worth rebuilding for.

Should Windows AMD support ever be attempted, the MSVC toolchain becomes a hard prerequisite
(`CLAUDE.md` notes it needs a native addon over LibreHardwareMonitor or AMD ADLX). `npm rebuild
--build-from-source` fails on this box for that reason, and its absence is also why
`electron-rebuild` silently used a prebuilt binary and let the ELF through.

**Linux GUI IS NOW VALIDATED — on .70, not in WSL.** The repeatable rig: build in the WSL checkout,
`scp` the AppImage to `pogibry@192.168.50.70`, `rm -rf squashfs-root && ./guiTOP-*.AppImage
--appimage-extract`, then `xvfb-run -a -s "-screen 0 1600x900x24" ./squashfs-root/guitop
--no-sandbox` and drive the `/screenshot` endpoint over SSH. That box already has `xvfb-run` and
libfuse2, 138G free. Run the `guitop` binary directly — `AppRun` fails with `/guitop: No such file
or directory` because APPDIR is unset. `viz_main_impl` GPU-init errors under xvfb are benign; the
app stays up, unlike under WSLg.

Two traps in that rig, both hit on 2026-07-30:
- **`scp` from WSL to .70 used to hang forever — FIXED 2026-07-30.** The WSL home had no `~/.ssh`
  keys at all, so it fell back to a password prompt a non-interactive shell can never answer.
  WSL now has its own `id_ed25519` (`wsl-bryan@bryan-dt`), appended to .70's `authorized_keys`
  as a third key alongside the two Windows ones, with a matching `~/.ssh/config` entry. Deliberately
  a separate key, not a copy of the Windows one, so it can be revoked without cutting Windows off.
  Verified with a non-interactive `scp -o BatchMode=yes`. Copy straight from the WSL checkout now.

  Pass `-o BatchMode=yes` regardless: it turns any future auth gap into an immediate
  `Permission denied` instead of a silent hang that reads like a slow transfer.
- **`pgrep -f 'squashfs-root/guitop'` kills the ssh session running it**, because the remote
  `bash -c` command line contains that string and so matches itself. Bracket the first character
  — `pgrep -af '[s]quashfs-root/guitop'` — the same trick used for `ps | grep`.

Verified there at commit `bb27d07`: all 3 Tesla P100s detected via nvidia-smi (only `fanSpeed`
null, correct for P100), bars + gauges render, the CSS thermometer replaces the tofu box, and the
gauge side-arcs are no longer buried. llama.cpp on that box was undisturbed throughout.

**Found during that pass, FIXED 2026-07-30:** at a 520px-wide window the bars skin's "Show
Processes" button overlapped the status bar. The cause was not cosmetic and not confined to bars.
`.status-bar` was `position: fixed` and `.tab-panel` compensated with a magic `padding-bottom`,
which only clears an overlay at maximum scroll — at scroll-top, where `/screenshot` captures, the
button sat 11px behind the bar. Wide widths hid it because the multi-column grid does not overflow.
Enlarging the padding could never fix that class of bug; it only moves the bad scroll window.

With the Claude strip docked **bottom** the same defect was worse: the strip was also
`position: fixed`, 60px tall when it wraps at 520px, and the button landed fully inside it with the
page not scrollable at all.

The fix promotes the corvette skin's already-verified viewport-filling column to global: `body` is
a flex column at `height: 100vh` with `overflow: hidden`, `.tab-panel.active` is the only scroller
(`flex: 1 1 auto; min-height: 0; overflow-y: auto`), and the status bar and both docks are ordinary
flow items with `flex-shrink: 0`. A new `--status-bar-h` names the 26px that had been duplicated.
Corvette's duplicated rules were deleted as now-global, its distinctive overrides kept verbatim.

**`min-height: 0` on the panel is load-bearing** — it is the column-direction cousin of the
documented `flex-shrink: 0` trap. Without it the flex item refuses to shrink below max-content
height and the column overflows the viewport again.

Verified in the real app on Windows at 3 skins x dock top/bottom/off x 520/1200/1240px, procs
shown and hidden: status bar flush at the viewport bottom, zero overlaps from `/debug/strip`, the
process table scrolling inside the panel. **This also closes the bottom-dock sweep** that had been
open since the strip layout fix — the bottom dock renders correctly at every width tested.

**Also verified on Linux**, against the shipped v0.3.4 AppImage on .70 under the xvfb rig: bars at
520x680 with the strip docked bottom — the exact configuration that was broken — renders the strip
directly above the status bar, both flush, all three P100s drawn, `/debug/strip` reporting zero
overlaps. The strip reads `--` there because cswap is not installed on that box, which is correct
behaviour rather than a fault. llama.cpp was serving throughout and its VRAM was unchanged after.

**Historical note — WSL could not do this.** The v0.3.3 AppImage launches under WSLg, the main
process runs, the dev server binds 17580 and `/gpu/backends` returns correct mock data — then
Chromium dies with `FATAL: GPU process isn't usable. Goodbye.` after 15-25s. Three flag
combinations tried (`--disable-gpu`, `--in-process-gpu`, `--use-gl=swiftshader`); all fail to
create a GL context under WSLg. So **no Linux rendering has ever been verified** — no skin, no
strip layout. WSL cannot answer this, and it also has no real `/sys/class/drm` amdgpu tree and
only a virtualized `nvidia-smi`. The proposed answer is `xvfb-run` on .70 (real Linux, real
NVIDIA) driving the existing `/screenshot` endpoint — headless, no desktop needed.

The bottom-dock sweep, open since the strip layout fix, is now done — see the layout rework above.

Fixed 2026-07-30, uncommitted: the two hardcoded `cmd.exe` cswap call sites in main.js
(`runCswapCmd` and the `add-token` `spawn`) now go through `cswapCmd`, so the Claude strip is no
longer Windows-only. The two sites had used opposite argument conventions — one passed bare args,
the other pre-baked `/c cswap` into its own array — and both now hand cswap-cmd the subcommand
alone. Windows behaviour is byte-identical. The Linux `add-token` stdin path has still never
executed anywhere; it needs a Linux box with cswap installed.

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
- **Linux build round-trip — SOLVED, and it had already bitten us silently.** Do NOT build Linux
  from the `E:\` tree. Clone to WSL-native ext4 instead: `git clone /mnt/e/vs_code_projects/guiTOP
  ~/build/guiTOP`, then `npm install && npm run build:linux` there. Separate `node_modules`, so
  `E:\` is never touched and there is no round-trip to remember. Also far faster than drvfs.

  This was never a WSL limitation — it was one working tree with one `node_modules` shared by two
  platforms. Dual-boot or a bind-mounted container would break identically.

  **The old advice was not followed at some point and nobody noticed.** On 2026-07-27,
  `node_modules/cpu-features/build/Release/cpufeatures.node` in the Windows tree was found to be
  a Linux ELF binary dated 07/20, and it shipped inside the v0.3.3 Windows installer (and almost
  certainly v0.3.2's too). It fails to load on Windows — *"is not a valid Win32 application"* —
  but `ssh2` treats `cpu-features` as optional and falls back cleanly, so SSH monitoring works and
  nothing surfaced. Silent degradation, invisible for a week.

  **Check after any Linux build:** the first 4 bytes of that `.node` must be `4D 5A` (`MZ`,
  Windows PE), not `7F 45 4C 46` (ELF). `npm rebuild cpu-features --build-from-source` fails on
  this box — no MSVC toolchain. Unresolved; see the open items at the top.
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
- **Build output**: `dist\guiTOP Setup 0.3.3.exe` (75MB), `dist/guiTOP-0.3.3.AppImage` (106MB),
  `dist/guitop_0.3.3_amd64.deb` (74MB) — published as `guiTOP.Setup.0.3.3.exe`,
  `guiTOP-0.3.3.AppImage`, `guitop_0.3.3_amd64.deb`. All unsigned.
- **Release**: https://github.com/an80sPWNstar/guiTOP/releases/tag/v0.3.3

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
