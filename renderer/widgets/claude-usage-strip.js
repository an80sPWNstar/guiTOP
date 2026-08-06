// Claude usage strip — account-wide Claude Code token usage (session / week / reset / today).
// Static markup uses classes only (CSP forbids inline style attrs); dynamic colors via element.style.
const ClaudeUsageStrip = (() => {
  // seg/glow/val/accent per skin; bg/border/fonts live in main.css via body.skin-* vars
  const THEME = {
    bars:     { seg: '#1a7fc0', glow: '#3a9fd8', val: '#3a9fd8', accent: '#4C9AFF' },
    gauges:   { seg: '#1f9e5a', glow: '#3fc079', val: '#3fc079', accent: '#4C9AFF' },
    corvette: { seg: '#2ecc40', glow: '#5fe870', val: '#ffb000', accent: '#FFB000' },
  }
  const SEG_COUNT = 20

  function meterHtml(label, role, resetRole) {
    const segs = '<div class="cu-seg"></div>'.repeat(SEG_COUNT)
    const reset = resetRole ? `<span class="cu-readout cu-readout-inline"><span class="cu-label">${resetRole === 'reset' ? '5H' : '7D'}</span><span class="cu-val" data-role="${resetRole}">--</span></span>` : ''
    return `<div class="cu-meter"><span class="cu-label">${label}</span><div class="cu-track" data-role="${role}">${segs}</div><span class="cu-val" data-role="${role}-val">--</span><span class="cu-unit">%</span>${reset}</div>`
  }

  function render() {
    return `<div class="cu-strip"><div class="cu-brand"><span class="cu-brand-name">CLAUDE</span><span class="cu-brand-sub">USAGE</span></div>${meterHtml('Session', 'session', 'reset')}${meterHtml('Week', 'week', 'week-reset')}<div class="cu-readout" data-role="fable-readout" style="display:none"><span class="cu-label" data-role="fable-label">Fable</span><span class="cu-val" data-role="fable-val">--</span><span class="cu-unit">%</span><span class="cu-val" data-role="fable-reset">--</span></div><div class="cu-readout" data-role="tokens-readout"><span class="cu-label">Tokens Today</span><span class="cu-val" data-role="tokens">--</span></div><div class="cu-swap"><div class="cu-div" data-role="swap-div"></div><div class="cu-accts" data-role="accts"></div><div class="cu-auto" data-role="auto"><span class="cu-dot" data-role="auto-dot"></span><span class="cu-label">Auto</span><span class="cu-val" data-role="auto-val">--</span></div></div><div class="cu-all" data-role="all-meters" style="display:none"></div></div>`
  }

  // One 5H/7D meter pair per account, built per row so data-roles don't collide
  // across rows (they're scoped by querying inside the row element).
  function acctRowHtml() {
    const segs = '<div class="cu-seg"></div>'.repeat(SEG_COUNT)
    const meter = (label, role) =>
      `<div class="cu-meter cu-meter--acct"><span class="cu-label">${label}</span>` +
      `<div class="cu-track" data-role="${role}">${segs}</div>` +
      `<span class="cu-val" data-role="${role}-val">--</span><span class="cu-unit">%</span>` +
      `<span class="cu-readout cu-readout-inline"><span class="cu-val" data-role="${role}-reset">--</span></span></div>`
    return `<div class="cu-acct-row"><span class="cu-acct-name"></span>${meter('Session', 's5')}${meter('Week', 's7')}</div>`
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

  function fmtTokens(n) {
    if (n == null) return '--'
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1e3) return Math.round(n / 1e3) + 'K'
    return String(n)
  }

  function update(root, data, skin, swap, showAll) {
    const t = theme(skin)

    const brandName = root.querySelector('.cu-brand-name')
    brandName.style.color = t.accent
    brandName.style.textShadow = `0 0 8px ${t.accent}55`

    // "All accounts" mode: stack a full 5H/7D meter pair per account (from the
    // cswap swap payload), instead of the single active-account meters. The
    // whole single view — meters, fable, tokens, chips — is sourced separately
    // and simply hidden; the strip flips to a vertical column via a class.
    const stripEl = root.querySelector('.cu-strip')
    const allEl = root.querySelector('[data-role="all-meters"]')
    const allMode = !!showAll && swap && swap.ok && Array.isArray(swap.accounts) && swap.accounts.length > 0
    stripEl.classList.toggle('cu-strip--all', allMode)
    if (allMode) {
      root.querySelectorAll('.cu-meter:not(.cu-meter--acct)').forEach(m => { m.style.display = 'none' })
      root.querySelector('[data-role="fable-readout"]').style.display = 'none'
      root.querySelector('[data-role="tokens-readout"]').style.display = 'none'
      root.querySelector('.cu-swap').style.display = 'none'
      allEl.style.display = 'flex'
      renderAllMeters(allEl, swap, t)
      return
    }
    allEl.style.display = 'none'
    root.querySelectorAll('.cu-meter:not(.cu-meter--acct)').forEach(m => { m.style.display = '' })
    root.querySelector('.cu-swap').style.display = ''

    const sessionVal = root.querySelector('[data-role="session-val"]')
    const weekVal = root.querySelector('[data-role="week-val"]')
    const resetVal = root.querySelector('[data-role="reset"]')
    const weekResetVal = root.querySelector('[data-role="week-reset"]')
    const tokensVal = root.querySelector('[data-role="tokens"]')

    const fableReadout = root.querySelector('[data-role="fable-readout"]')
    // Neither usage source fills todayTokens — it came from the old JSONL
    // heuristic. An empty readout is ~110px of the width budget that decides
    // whether the strip fits on one row, so it only shows when it has a number.
    const tokensReadout = root.querySelector('[data-role="tokens-readout"]')

    if (!data || !data.ok) {
      sessionVal.textContent = '--'
      weekVal.textContent = '--'
      resetVal.textContent = '--'
      weekResetVal.textContent = '--'
      tokensVal.textContent = '--'
      tokensReadout.style.display = 'none'
      fableReadout.style.display = 'none'
      updateSwap(root, swap, t)
      return
    }

    const sessionTrack = root.querySelector('[data-role="session"]')
    const weekTrack = root.querySelector('[data-role="week"]')

    paintBar(sessionTrack, data.sessionPct, t)
    paintBar(weekTrack, data.weekPct, t)

    const sessionColor = valColor(data.sessionPct, t)
    sessionVal.textContent = data.sessionPct
    sessionVal.style.color = sessionColor
    sessionVal.style.textShadow = `0 0 6px ${sessionColor}66`

    const weekColor = valColor(data.weekPct, t)
    weekVal.textContent = data.weekPct
    weekVal.style.color = weekColor
    weekVal.style.textShadow = `0 0 6px ${weekColor}66`

    resetVal.textContent = fmtReset(data.sessionResetAt)
    resetVal.style.color = t.val
    resetVal.style.textShadow = `0 0 6px ${t.val}55`

    weekResetVal.textContent = fmtReset(data.weekResetAt)
    weekResetVal.style.color = t.val
    weekResetVal.style.textShadow = `0 0 6px ${t.val}55`

    if (data.fable) {
      fableReadout.style.display = ''
      const fableLabel = root.querySelector('[data-role="fable-label"]')
      const fableVal = root.querySelector('[data-role="fable-val"]')
      const fableReset = root.querySelector('[data-role="fable-reset"]')
      fableLabel.textContent = data.fable.name
      const fableColor = valColor(data.fable.pct, t)
      fableVal.textContent = data.fable.pct
      fableVal.style.color = fableColor
      fableVal.style.textShadow = `0 0 6px ${fableColor}66`
      fableReset.textContent = fmtReset(data.fable.resetAt)
      fableReset.style.color = t.val
      fableReset.style.textShadow = `0 0 6px ${t.val}55`
    } else {
      fableReadout.style.display = 'none'
    }

    tokensReadout.style.display = data.todayTokens == null ? 'none' : ''
    tokensVal.textContent = fmtTokens(data.todayTokens)
    tokensVal.style.color = t.val
    tokensVal.style.textShadow = `0 0 6px ${t.val}55`

    updateSwap(root, swap, t)
  }

  function renderAllMeters(allEl, swap, t) {
    const accounts = swap.accounts
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
      name.textContent = (a.active ? '▸ ' : '') + a.number + ' ' + String(a.alias).toUpperCase()
      name.style.color = a.active ? t.accent : ''

      // usageStatus !== 'ok' means cswap could not fetch it; pcts are null and
      // the bar reads empty, so dim the whole row to say "no data", not "0%".
      const na = a.usageStatus ? a.usageStatus !== 'ok' : false
      row.classList.toggle('cu-acct-row--na', na)

      paintAcctMeter(row, 's5', a.fiveHourPct, a.fiveHourResetMs, t)
      paintAcctMeter(row, 's7', a.sevenDayPct, a.sevenDayResetMs, t)
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

  function updateSwap(root, swap, t) {
    const swapDiv = root.querySelector('[data-role="swap-div"]')
    const acctsEl = root.querySelector('[data-role="accts"]')
    const autoEl = root.querySelector('[data-role="auto"]')

    if (!swap || !swap.ok || !swap.accounts || swap.accounts.length === 0) {
      swapDiv.style.display = 'none'
      acctsEl.style.display = 'none'
      autoEl.style.display = 'none'
      return
    }
    swapDiv.style.display = ''
    acctsEl.style.display = ''
    autoEl.style.display = ''

    const accounts = swap.accounts
    const sig = accounts.map(a => a.number + ':' + a.alias + ':' + (a.active ? 1 : 0) + (a.disabled ? 1 : 0)).join('|')
    if (acctsEl.dataset.sig !== sig) {
      acctsEl.dataset.sig = sig
      acctsEl.innerHTML = accounts.map(() => '<div class="cu-chip"><span class="cu-chip-label"></span><div class="cu-chip-bars"><div class="cu-mini"><div class="cu-mini-fill" data-role="mini5"></div></div><div class="cu-mini"><div class="cu-mini-fill" data-role="mini7"></div></div></div></div>').join('')
    }

    const chips = acctsEl.children
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i]
      const chip = chips[i]
      const label = chip.querySelector('.cu-chip-label')
      label.textContent = (a.active ? '▸ ' : '') + a.number + ' ' + String(a.alias).toUpperCase()

      chip.style.cursor = a.active ? '' : 'pointer'
      chip.onclick = a.active ? null : () => {
        if (window.guiTOP.cswapSwitch) window.guiTOP.cswapSwitch(a.number)
      }

      if (a.active) {
        chip.style.border = `1px solid ${t.accent}88`
        chip.style.background = `${t.accent}14`
        label.style.color = t.accent
      } else {
        chip.style.border = ''
        chip.style.background = ''
        label.style.color = ''
      }
      chip.style.opacity = a.disabled ? '0.4' : ''

      // cswap could not fetch this account's usage (e.g. a token that 403s on
      // the usage endpoint). A null pct would otherwise paint an empty bar that
      // reads as 0%; mark it so the mini bars show a distinct "no data" state.
      const na = a.usageStatus ? a.usageStatus !== 'ok' : false
      chip.classList.toggle('cu-chip--na', na)
      chip.title = na ? 'usage unavailable' : ''

      const mini5 = chip.querySelector('[data-role="mini5"]')
      const mini7 = chip.querySelector('[data-role="mini7"]')
      paintMiniFill(mini5, a.fiveHourPct, t)
      paintMiniFill(mini7, a.sevenDayPct, t)
    }

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

  function paintMiniFill(el, pct, t) {
    if (pct == null) {
      el.style.width = '0'
      el.style.boxShadow = 'none'
      return
    }
    const color = pct >= 95 ? '#FF4757' : pct >= 80 ? '#FFC857' : t.seg
    el.style.width = `${pct}%`
    el.style.background = color
    el.style.boxShadow = `0 0 4px ${color}`
  }

  function theme(skin) { return THEME[skin] || THEME.gauges }

  return { render, update, theme }
})()
