// Claude usage strip — per-account Claude Code token usage (session / week / reset).
// One meter-pair row per cswap account, all live at once; no single-account view
// and no chips — the row's name is the switch affordance. Brand sits left of the
// rows, AUTO right, so the strip is exactly as tall as the account list.
// Static markup uses classes only (CSP forbids inline style attrs); dynamic colors via element.style.
const ClaudeUsageStrip = (() => {
  // seg/glow/val/accent per skin; bg/border/fonts live in main.css via body.skin-* vars
  // fableSeg/fableGlow: the skin's seg color re-hued to blue at the same
  // saturation/lightness, so the fable bar reads as its own meter without
  // breaking the skin's tone.
  const THEME = {
    bars:     { seg: '#1a7fc0', glow: '#3a9fd8', val: '#3a9fd8', accent: '#4C9AFF', fableSeg: '#1a56c0', fableGlow: '#3a7dd8' },
    gauges:   { seg: '#1f9e5a', glow: '#3fc079', val: '#3fc079', accent: '#4C9AFF', fableSeg: '#1f5e9e', fableGlow: '#3f8ac0' },
    corvette: { seg: '#2ecc40', glow: '#5fe870', val: '#ffb000', accent: '#FFB000', fableSeg: '#2e7dcb', fableGlow: '#5fa4e8' },
  }
  const SEG_COUNT = 20

  function render() {
    return `<div class="cu-strip"><div class="cu-brand"><span class="cu-brand-name">CLAUDE</span><span class="cu-brand-sub">USAGE</span></div><div class="cu-all" data-role="all-meters"></div><div class="cu-auto" data-role="auto"><span class="cu-dot" data-role="auto-dot"></span><span class="cu-label">Auto</span><span class="cu-val" data-role="auto-val">--</span></div></div>`
  }

  // One 5H/7D meter pair per account, built per row so data-roles don't collide
  // across rows (they're scoped by querying inside the row element). The fable
  // readout only ever has data for the active account (it rides the usage
  // payload, not the swap payload), so it lives in the row and stays hidden
  // everywhere else.
  function acctRowHtml() {
    const segs = '<div class="cu-seg"></div>'.repeat(SEG_COUNT)
    const meter = (label, role) =>
      `<div class="cu-meter cu-meter--acct"><span class="cu-label">${label}</span>` +
      `<div class="cu-track" data-role="${role}">${segs}</div>` +
      `<span class="cu-val" data-role="${role}-val">--</span><span class="cu-unit">%</span>` +
      `<span class="cu-readout cu-readout-inline"><span class="cu-val" data-role="${role}-reset">--</span></span></div>`
    // The fable meter is the same bar as the others; only its label text is
    // dynamic (the model name arrives in the usage payload).
    const fable =
      `<div class="cu-meter cu-meter--acct" data-role="fable" style="display:none">` +
      `<span class="cu-label" data-role="fable-label">Fable</span>` +
      `<div class="cu-track" data-role="sf">${segs}</div>` +
      `<span class="cu-val" data-role="sf-val">--</span><span class="cu-unit">%</span>` +
      `<span class="cu-readout cu-readout-inline"><span class="cu-val" data-role="sf-reset">--</span></span></div>`
    return `<div class="cu-acct-row"><span class="cu-acct-name"></span>${meter('Session', 's5')}${meter('Week', 's7')}${fable}</div>`
  }

  function paintBar(track, pct, theme) {
    const count = track.children.length
    const lit = Math.max(0, Math.min(100, pct)) / 100 * count

    for (let i = 0; i < count; i++) {
      const seg = track.children[i]
      const frac = (i + 1) / count

      let c = theme.seg
      let gc = theme.glow
      if (frac > 0.90) {
        c = '#ff2e3e'
        gc = '#ff5a68'
      } else if (frac > 0.82) {
        c = '#ff5a1e'
        gc = '#ff8a4a'
      } else if (frac > 0.72) {
        c = '#ff9a2e'
        gc = '#ffb85a'
      }

      if (i + 1 <= lit) {
        seg.style.background = c
        seg.style.boxShadow = `0 0 7px ${gc}, 0 0 2px ${gc}`
      } else {
        seg.style.background = 'rgba(255,255,255,0.07)'
        seg.style.boxShadow = 'none'
      }
    }
  }

  function valColor(p, theme) {
    if (p >= 95) return '#FF4757'
    if (p >= 80) return '#FFC857'
    return theme.val
  }

  // resetAt is an absolute epoch-ms timestamp — recomputed against Date.now()
  // on every call so repeated repaints (independent of the data poll) tick down live.
  function fmtReset(resetAt) {
    if (resetAt == null) return '--'
    const m = Math.max(0, Math.round((resetAt - Date.now()) / 60000))
    return `${Math.floor(m / 60)}H ${m % 60}M`
  }

  function update(root, data, skin, swap) {
    const t = theme(skin)

    const brandName = root.querySelector('.cu-brand-name')
    brandName.style.color = t.accent
    brandName.style.textShadow = `0 0 8px ${t.accent}55`

    const allEl = root.querySelector('[data-role="all-meters"]')
    const accounts = (swap && swap.ok && Array.isArray(swap.accounts) && swap.accounts.length > 0)
      ? swap.accounts
      // No swap payload (cswap missing or its poll failed): the usage payload
      // still describes the active account, so show it as a single unnamed row
      // rather than an empty strip.
      : (data && data.ok ? [{
          number: '', alias: 'active', active: true,
          fiveHourPct: data.sessionPct, fiveHourResetMs: data.sessionResetAt,
          sevenDayPct: data.weekPct, sevenDayResetMs: data.weekResetAt,
        }] : [])
    renderAcctRows(allEl, accounts, data, t)

    updateAuto(root, swap, t)
  }

  function renderAcctRows(allEl, accounts, data, t) {
    const sig = accounts.map(a => a.number + ':' + a.alias + ':' + (a.active ? 1 : 0)).join('|')
    if (allEl.dataset.sig !== sig) {
      allEl.dataset.sig = sig
      allEl.innerHTML = accounts.map(() => acctRowHtml()).join('')
    }
    const rows = allEl.children
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i]
      const row = rows[i]
      const name = row.querySelector('.cu-acct-name')
      name.textContent = ((a.active ? '▸ ' : '') + a.number + ' ' + String(a.alias).toUpperCase()).trim()
      name.style.color = a.active ? t.accent : ''

      // The name doubles as the cswap switch control (chips used to do this).
      name.style.cursor = a.active ? '' : 'pointer'
      name.title = a.active ? '' : 'switch to this account'
      name.onclick = a.active ? null : () => {
        if (window.guiTOP.cswapSwitch) window.guiTOP.cswapSwitch(a.number)
      }

      // usageStatus !== 'ok' means cswap could not fetch it; pcts are null and
      // the bar reads empty, so dim the whole row to say "no data", not "0%".
      const na = a.usageStatus ? a.usageStatus !== 'ok' : false
      row.classList.toggle('cu-acct-row--na', na)

      paintAcctMeter(row, 's5', a.fiveHourPct, a.fiveHourResetMs, t)
      paintAcctMeter(row, 's7', a.sevenDayPct, a.sevenDayResetMs, t)
      paintFable(row, a.active && data && data.ok ? data.fable : null, t)
    }
  }

  function paintAcctMeter(row, role, pct, resetMs, t) {
    const track = row.querySelector(`[data-role="${role}"]`)
    const val = row.querySelector(`[data-role="${role}-val"]`)
    const reset = row.querySelector(`[data-role="${role}-reset"]`)
    if (pct == null) {
      paintBar(track, 0, t)
      val.textContent = '--'
      val.style.color = ''
      val.style.textShadow = 'none'
    } else {
      paintBar(track, pct, t)
      const c = valColor(pct, t)
      val.textContent = pct
      val.style.color = c
      val.style.textShadow = `0 0 6px ${c}66`
    }
    reset.textContent = fmtReset(resetMs)
    reset.style.color = t.val
    reset.style.textShadow = `0 0 6px ${t.val}55`
  }

  function paintFable(row, fable, t) {
    const el = row.querySelector('[data-role="fable"]')
    if (!fable) {
      el.style.display = 'none'
      return
    }
    el.style.display = ''
    row.querySelector('[data-role="fable-label"]').textContent = fable.name
    paintAcctMeter(row, 'sf', fable.pct, fable.resetAt, { ...t, seg: t.fableSeg, glow: t.fableGlow })
  }

  function updateAuto(root, swap, t) {
    const autoEl = root.querySelector('[data-role="auto"]')
    if (!swap || !swap.ok) {
      autoEl.style.display = 'none'
      return
    }
    autoEl.style.display = ''

    const dot = root.querySelector('[data-role="auto-dot"]')
    if (swap.autoOn) {
      dot.style.background = t.seg
      dot.style.boxShadow = `0 0 6px ${t.seg}`
    } else {
      dot.style.background = 'rgba(255,255,255,0.15)'
      dot.style.boxShadow = 'none'
    }

    const val = root.querySelector('[data-role="auto-val"]')
    val.textContent = swap.autoOn ? (swap.autoSinceMin != null ? `ON · ${swap.autoSinceMin}M` : 'ON') : 'OFF'
    val.style.color = t.val
    val.style.textShadow = `0 0 6px ${t.val}55`
  }

  function theme(skin) { return THEME[skin] || THEME.gauges }

  return { render, update, theme }
})()
