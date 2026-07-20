# Claude Usage Strip — Implementation Handoff

A single account-wide "Claude usage" status strip for the guiTOP GPU dashboard (Electron). One entry for the whole interface — NOT per-GPU. Open `ClaudeUsageStrip.dc.html` in a browser for a live reference (skin dropdown + toggle button included).

## What it is

A slim horizontal strip showing four metrics:

| Metric | Example | Notes |
|---|---|---|
| Session usage | 62% | % of the 5-hour rolling limit |
| Weekly usage | 41% | % of the weekly limit |
| Reset | 1H 47M | time until the 5-hour window resets |
| Tokens today | 2.4M | total tokens across models |

Each % metric renders as a 20-segment LED bar + numeric readout. The strip can dock at the **top** (directly under the app's header bar) or **bottom** (footer), toggled by a `CLAUDE ▴/▾` button in the header next to the skin dropdown. The button cycles: **top → bottom → off**. It is lit in the skin accent color when on, dimmed when off, and the arrow shows the current dock position (▴ top, ▾ bottom).

## Layout spec

Strip container: `display:flex; align-items:center; gap:24px; flex-wrap:wrap; padding:8px 20px;` with a 1px border on the content-facing edge (border-bottom when docked top, border-top when docked bottom). Contents left→right:

1. Brand label: `CLAUDE` (brand font, 900, 11px, letter-spacing 2px, accent color, glow `0 0 8px <accent>55`) + `USAGE` (9px, dim color, letter-spacing 2px)
2. Session meter: label (9px uppercase dim) + segmented bar (flex:1, min 170px, max 280px) + value (digit font 12px) + `%` unit (9px dim, separate span — see font note)
3. Week meter: same construction
4. Reset readout: label + value in digit font
5. Tokens Today readout: label + value in digit font

Segmented bar track: `height:11px; background:rgba(0,0,0,0.4); padding:2px 3px; box-shadow:inset 0 1px 3px rgba(0,0,0,0.6);` radius 3px (0 for Terminal skin). 20 segments, `gap:2px`, each `flex:1; border-radius:1px`.

## Threshold behavior (matches the GPU bars)

Two mechanisms, both required:

1. **Segment position coloring** (in `segBar`): segments above 72% of the track are amber `#ff9a2e`, above 82% deep-orange `#ff5a1e`, above 90% red `#ff2e3e` — regardless of fill level. Lit segments get a glow `0 0 7px <glow>, 0 0 2px <glow>`; unlit segments are `rgba(255,255,255,0.07)`.
2. **Value coloring**: the numeric readout is the skin's normal value color below 80%, warning `#FFC857` at ≥80%, critical `#FF4757` at ≥95%.

## Skin theming table

The strip re-skins with all five dashboard skins. Values (bg / border / dim / seg base / seg glow / value color / digit font / brand font / radius) are in the `cuTheme` map inside `ClaudeUsageStrip.dc.html` — copy them verbatim. Accent colors: Ice Redline `#4C9AFF`, Corvette `#FFB000`, Gauges `#4C9AFF`, Outrun `#22D3FF`, Terminal `#00DC82`.

⚠️ **Ice Redline (`bars`) is provisional** — that skin is still being redesigned. Implement its row as-is but expect the values to change; keep the theme map centralized so it's a one-line update.

## Fonts

- **DSEG14 Classic** (Corvette digits): `https://cdn.jsdelivr.net/npm/dseg@0.46.0/css/dseg.css`. DSEG fonts **cannot render `%` or `°`** — always put units in a separate span using a normal font. DSEG14 (not DSEG7) is required here because reset/token values contain letters (`1H 47M`, `2.4M`).
- **Share Tech Mono, Orbitron, Rajdhani**: Google Fonts.
- For offline/production Electron use, vendor the font files locally and replace the CDN links with `@font-face` (same approach as documented in the C4 Corvette handoff).

## Toggle button spec

Sits in the header row immediately left of "Manage Hosts" (right side, next to the skin dropdown). `padding:7px 12px; border-radius:6px; font-size:11px; font-weight:600;`
- On: `background:<accent>22; border:1px solid <accent>88; color:<accent>`
- Off: `background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.45)`
- Arrow span: `font-size:16px; line-height:0; vertical-align:-2px;` content `▴` (U+25B4) top / `▾` (U+25BE) bottom / empty when off.

Persist the dock state (`top`/`bottom`/`off`) across app restarts (settings/localStorage).

## Wiring real data

The demo returns mock values from `getClaudeUsage()`. In the Electron app, replace with a poller (30–60s interval) reading Claude Code local usage the way `ccusage` does:

- Source: JSONL transcript files under `~/.claude/projects/**/*.jsonl` (each assistant message carries `message.usage` with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, plus a `timestamp`).
- **Session %**: sum tokens inside the current 5-hour billing window (windows start at the first message after the previous window ends, on the hour), divide by the plan's session token budget.
- **Weekly %**: same aggregation over the rolling 7-day window.
- **Reset**: window start + 5h − now, formatted `xH yM`.
- **Tokens today**: sum since local midnight, formatted compact (`2.4M`, `830K`).
- De-duplicate entries by `message.id` + `requestId` (retries produce duplicates).

Run the aggregation in the main process, push to the renderer over IPC alongside the existing GPU polling.

## Files

- `ClaudeUsageStrip.dc.html` — live reference implementation (all markup, theming map, segBar logic, toggle behavior)
- `support.js` — runtime for the reference file (only needed to view it; not part of the Electron implementation)
