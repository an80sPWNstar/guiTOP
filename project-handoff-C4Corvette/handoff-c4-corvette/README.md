# 80's C4 Corvette GPU Skin — Claude Code Handoff

A retro Chevrolet C4 Corvette digital-dash skin for the guiTOP GPU-monitoring dashboard.
This package documents everything needed to lift the **C4 Corvette skin only** out of the
prototype and rebuild/extend it. (The sibling "Ice Redline" skin is intentionally NOT included.)

## Where the source lives
- Prototype file: `guiTOP Dashboard.dc.html` (project root).
- The Corvette skin is the block guarded by `<sc-if value="{{ isCorvette }}">` in the template,
  plus the `isCorv` branch inside `enrichGpu(g, skin)` and the helpers listed below in the
  logic class.
- It is authored as a **Design Component (DC)** — a `.dc.html` file with a `<x-dc>` template +
  a `class Component extends DCLogic` logic block, assembled by the local `support.js` runtime.
  It opens directly in a browser.

## Visual target
See `reference-coolant-temp.png` and `reference-speedo.png` (the real C4 cluster the skin
imitates): a green curved bar-graph speedometer, an amber seven-segment COOLANT TEMP module with
a red level bar + wavy coolant glyph, and a green fuel gauge with F / ½ / E markers.

## Fonts (required)
Loaded via CDN in `<helmet>`:
```html
<link href="https://cdn.jsdelivr.net/npm/dseg@0.46.0/css/dseg.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@500;700;900&family=Rajdhani:wght@500;600;700&display=swap" rel="stylesheet">
```
- `DSEG7-Classic`  → the digits (GPU LOAD %, GPU TEMP number). Seven-segment.
- `DSEG14-Classic` → the letters (STATUS/ACTIVE/IDLE/E/F/GPU LOAD). Fourteen-segment.
- Family names use a HYPHEN (`DSEG14-Classic`), not a space — the space form silently falls back.
- NEVER put `%` or `°` inside a DSEG font (it can't render them). Put those in a small
  `Share Tech Mono` span beside the segmented digits.
- These DSEG fonts are a substitute for GM's real C4 vacuum-fluorescent display (that exact font
  is not publicly available). Flag this to end users.

## Design system
The prototype is bound to the **tempsLCD Design System**
(`_ds/tempslcd-design-system-4b29cd5e-d96a-411d-a01e-c370d9bc9fdc/`). The Corvette skin only
really needs its color tokens + the DSEG/Google fonts above; it uses hardcoded C4 hex values for
the dash colors (below) rather than tokens.

## C4 color palette (hardcoded in the skin)
```
Amber (labels, wordmark, border)   #FFB000 / #ffae1a / #ff8a1e
Green (low / good, fuel + wedge)   #2ecc40  (glow #5fe870)
Amber-mid (wedge/PWR mid)          #ffcc00 / #c8a018 (glow #e6c04a)
Orange (warning)                   #ff8a1e / #ff6a1e / #ff9a2e
Red (redline / critical / temp)    #ff2e3e / #ff3b30 (glow #ff5a68 / #ff6a5a)
Card bg                            #0a0805    Module bg #0d0a04
Module border                      2px solid #6a4a10 (GPU LOAD box uses #7a4a10)
Shell bg (page)                    #050505    Accent #FFB000
```

## Layout of one GPU card (Corvette)
- **Header:** index badge + GPU name, with the **host name on a second line under the GPU name**
  (small, dim amber). No temp box in the header.
- **Body row** (`display:flex; gap:16px; align-items:stretch`):
  - **Left group** (`flex:1`): a 0–100 scale column (amber numbers) + the **wedge load gauge**.
    - Wedge = 24 horizontal bars stacked bottom(0)→top(100) via `flex-direction:column-reverse`
      + `align-items:flex-start`; each bar width = `14 + 86*t^1.6` % (shortest at 0, longest at
      100 → the curved green speedo wedge). Color by POSITION: green → amber → orange → red.
    - **GPU LOAD readout** box is absolutely positioned bottom-right INSIDE the wedge box:
      amber DSEG7 integer + a small Share Tech Mono `%`, with a "GPU LOAD" label + divider above.
  - **Right column** (`width:152px; display:flex; flex-direction:column;
    justify-content:space-between; padding-bottom:6px`):
    - **TOP — GPU TEMP module** (the C4 COOLANT TEMP look): a thin red vertical segment bar
      (fills with temperature) + big amber DSEG7 temp number + small `°C` + a 2-line wavy
      coolant-symbol SVG glyph, with a "GPU TEMP" label beneath.
    - **BOTTOM — fuel-style STATUS gauge:** a 42px-wide green segmented column (top ~12% turns
      red = redline) with amber **F / ½ / E** markers to its right, and an ACTIVE/IDLE/HIGH LOAD
      label beneath (color dims when idle).
- **VRAM / PWR rows:** segmented LED bars — VRAM base green `#2ecc40`, PWR base amber `#c8a018`,
  both escalating to orange/red at the high end.

### Alignment requirement (IMPORTANT, still to be verified)
The bottom of the GPU LOAD box and the bottom of the fuel-gauge box must line up horizontally.
Because the right column's stacked content is taller than the wedge, the wedge box + left scale
column were changed from a fixed `height:200px` to `align-self:stretch; min-height:200px` so both
columns resolve to the same row height and each inner box (pinned 6px from its column's bottom)
lands on the same line. **This was not visually confirmed before handoff — verify it, and if the
two bottoms still differ, either keep the stretch approach or trim the right-column content to
≤200px so the row height stays 200 with a fixed wedge.**

## Logic / data model
`enrichGpu(g, skin)` turns a raw GPU record into display fields. Raw record shape:
```js
{ index, name, host, utilization, memoryUsed, memoryTotal, temperature,
  powerDraw, powerLimit, fanSpeed, clockSm }
```
Corvette-relevant derived fields (isCorv branch): `utilPct`, `tempNum` (String), `utilWedge`
(position-colored wedge segments), `vramSeg` / `powerSeg` (segmented bars), `tempColSeg` (red
temp bar), `fuelSeg` (green fuel column, red at top), `statusLabel` ("HIGH LOAD"/"ACTIVE"/"IDLE"),
`stateColor` / `stateGlow`.

Helper functions in the logic class the skin depends on:
- `col(pct, stops, count)` — generic vertical segmented column; `stops` = `[{from, c, gc}]`
  sorted by `from` (fraction 0–1); returns `[{bg, glow}]`. Used for `tempColSeg` and `fuelSeg`.
- `wedgeSegments(pct, count, skin)` — the curved load wedge; corvette branch colors by position.
- `segBar(pct, color, count, glowColor)` — horizontal LED bar (VRAM/PWR) with amber→orange→red
  threshold escalation at high fill.

Mock data lives in `getHostsRaw()` (two hosts: FAMILY-LLM ×3 Tesla P100, BRYAN-DT = RTX 4090 +
3080). No live data / SSH — this is a UI mockup.

## How to run
Open `guiTOP Dashboard.dc.html` in a browser and pick **80's C4 Corvette** from the skin dropdown
(top right). To isolate the skin as its own component, copy the `isCorvette` block + the helpers
above into a new `C4Corvette.dc.html` (see the "next steps" note below).

## Package contents
```
handoff-c4-corvette/
├── README.md              ← this file
├── C4Corvette.dc.html     ← STANDALONE component (corvette markup + only its helpers)
├── support.js             ← DC runtime (required; C4Corvette.dc.html loads it)
├── reference-coolant-temp.png
└── reference-speedo.png
```
`C4Corvette.dc.html` is self-contained: single/multi-host tabs + host picker + the C4 card grid,
with a trimmed logic class (`col`, `wedgeSegments`, `segBar`, `enrichGpu`, `getHostsRaw`). It does
NOT depend on the other four skins or the full prototype. Open it directly in a browser.

## Fonts offline (currently CDN)
The DSEG fonts load from jsDelivr and the base fonts from Google Fonts (see `<helmet>` in
`C4Corvette.dc.html`). To run fully offline, vendor them:
1. `npm pack dseg@0.46.0` (or download from https://github.com/keshikan/DSEG) → copy
   `css/dseg.css` + the `DSEG7-Classic` / `DSEG14-Classic` woff/ttf files into `./fonts/`, then
   change the CDN `<link>` to `./fonts/dseg.css`.
2. Self-host Share Tech Mono / Orbitron / Rajdhani from Google Fonts and swap the `<link>` for a
   local `@font-face` stylesheet.
Nothing else in this component reaches the network. It uses hardcoded C4 hex values, so the
tempsLCD token CSS files are NOT required for this skin (they matter only if you re-integrate it
into the full multi-skin dashboard).

## Done
1. ✅ Standalone `C4Corvette.dc.html` extracted (independent of the other four skins).
2. Fonts still on CDN — offline vendoring steps documented above (optional).
3. Confirm the GPU LOAD ↔ fuel-gauge bottom alignment when you run it (see the alignment note).
