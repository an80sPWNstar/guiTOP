# Claude Swap Strip — Implementation Handoff

Extends the **Claude Usage Strip** (see `handoff-claude-usage`) with multi-account awareness from [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`). One account-wide strip for the whole guiTOP interface — NOT per-GPU. Open `ClaudeSwapStrip.dc.html` in a browser for a live reference (skin dropdown + CLAUDE ▴/▾ toggle included).

## What was added over the base strip

After the "Tokens Today" readout, separated by a 1px vertical divider (`width:1px; align-self:stretch; background:<cuBorder>`):

1. **Account chips** — one per cswap account, in a flex row with `gap:8px`. Display only (no click-to-switch).
2. **AUTO status** — auto-switcher state: lit dot + `AUTO` label + `ON · 23M` readout (time since last switch) in the digit font.

## Account chip spec

Container: `display:flex; align-items:center; gap:7px; padding:3px 9px; border-radius:<cuRadius>` (3px, 0 for Terminal skin).
- **Inactive:** `border:1px solid <cuBorder>; background:rgba(255,255,255,0.03)`; label in the skin's dim color.
- **Active:** `border:1px solid <accent>88; background:<accent>14`; label in accent color, prefixed with `▸ ` (U+25B8).

Label: `<marker><slot number> <ALIAS>` — 9px, weight 700, letter-spacing 1px, uppercase, nowrap. Alias comes from cswap (`cswap alias`); fall back to the account email's local part, uppercased.

Mini bars: two stacked (5-hour on top, 7-day below), each `width:34px; height:4px; border-radius:2px; overflow:hidden`, track `rgba(255,255,255,0.08)`. Fill: width = pct, color = skin seg color normally, `#FFC857` at ≥80%, `#FF4757` at ≥95%, with glow `box-shadow:0 0 4px <fill color>`. These are smooth fills, NOT the 20-segment LED bars of the main meters — too small for segments.

## AUTO status spec

- Dot: 6px circle, skin seg color (green family), glow `0 0 6px <color>`. When the auto-switcher is off: `rgba(255,255,255,0.15)`, no glow.
- `AUTO` label: 9px uppercase dim.
- Value: digit font 12px, skin value color — `ON · 23M` (minutes since last switch), `ON` if never switched, `OFF` when disabled. Corvette uses DSEG14 Classic which handles letters; keep `·` outside if it renders as a missing glyph (it renders fine in DSEG14).

## Skin theming

Reuses the base strip's `cuTheme` map verbatim (all five skins; Ice Redline row still provisional — that skin is unfinished). No new theme tokens were introduced: chips derive from `cuBorder`/`cuDim`/accent, bars from `cuTheme.seg` + shared warning/critical colors.

## Wiring real data

Mock data lives in `getAccounts()`. In the Electron app, poll `cswap list --json` (30–60s, main process, push over IPC alongside GPU polling):

```json
{ "schemaVersion": 1, "activeAccountNumber": 2, "accounts": [
  { "number": 2, "email": "you@example.com", "alias": "dev", "active": true,
    "usageStatus": "ok",
    "usage": { "fiveHour": { "pct": 25.0, "resetsAt": "..." },
               "sevenDay": { "pct": 16.0, "resetsAt": "..." } } } ] }
```

Mapping: `number` → slot digit · `alias` (additive field, may be absent — fall back to email local part) → chip label · `active` → marker/highlight · `usage.fiveHour.pct` / `usage.sevenDay.pct` → mini bars. Notes:
- Rows may carry additive `"disabled": true` — if present, render the chip at 40% opacity.
- API-key accounts have no `usage` object — render empty tracks.
- `usageFetchedAt`/`usageAgeSeconds` tell you how stale a row is; cswap serves last-known numbers when the usage API is unreachable.
- The schema is additive (`schemaVersion: 1`); ignore unknown fields.

Auto-switch status: `cswap auto --json` emits one JSON event per line (`poll`, `switch`, `no-switch`, `account-quarantined`, `all-exhausted`, `error`). Track the timestamp of the last `switch` event for the `ON · xxM` readout. If the user doesn't run `cswap auto`, show `OFF`.

## Files

- `ClaudeSwapStrip.dc.html` — live reference (base strip + account chips + AUTO block, all 5 skins, top/bottom/off toggle)
- `support.js` — runtime for viewing the reference only; not part of the Electron implementation
- Base strip spec (layout, thresholds, fonts, toggle button): `handoff-claude-usage/README.md`
