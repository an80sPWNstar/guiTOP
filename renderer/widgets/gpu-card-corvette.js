// GPU card widget — 80's C4 Corvette digital dash skin.
// Retro seven-segment displays, curved wedge load gauge, fuel-style status.

const GpuCardCorvette = (() => {
  function esc(str) {
    const el = document.createElement('span')
    el.textContent = str == null ? '' : str
    return el.innerHTML
  }

  function render(gpu, compact) {
    const idx = gpu.index != null ? gpu.index : 0
    const cls = compact ? 'corvette-card compact' : 'corvette-card'

    let wedge = ''
    for (let i = 0; i < 24; i++) wedge += `<div data-role="wedge-bar" data-idx="${i}"></div>`

    let tempSegs = ''
    for (let i = 0; i < 8; i++) tempSegs += '<div data-role="temp-seg"></div>'

    let fuelSegs = ''
    for (let i = 0; i < 14; i++) fuelSegs += '<div data-role="fuel-seg"></div>'

    let pwrSegs = ''
    for (let i = 0; i < 30; i++) pwrSegs += '<div data-role="pwr-seg"></div>'

    return `
      <div class="${cls}" data-gpu-idx="${idx}">
        <div class="cv-header">
          <div class="cv-idx-badge" data-role="idx">${idx}</div>
          <div class="cv-name-block">
            <div class="cv-gpu-name" data-role="name">${esc(gpu.name)}</div>
            <div class="cv-host-name" data-role="host">${esc(gpu.host)}</div>
          </div>
        </div>
        <div class="cv-body">
          <div class="cv-left">
            <div class="cv-scale">
              <span data-role="scale">100</span>
              <span data-role="scale">80</span>
              <span data-role="scale">60</span>
              <span data-role="scale">40</span>
              <span data-role="scale">20</span>
              <span data-role="scale">0</span>
            </div>
            <div class="cv-wedge">
              ${wedge}
              <div class="cv-load-box">
                <div class="cv-load-label">LOAD</div>
                <div class="cv-load-divider"></div>
                <div class="cv-load-val">
                  <span data-role="util-pct">—</span>
                  <span data-role="util-unit">%</span>
                </div>
              </div>
            </div>
          </div>
          <div class="cv-right">
            <div class="cv-temp-module">
              <div class="cv-temp-inner">
                <div class="cv-temp-col">
                  ${tempSegs}
                </div>
                <div class="cv-temp-readout">
                  <span data-role="temp-num">—</span>
                  <span data-role="temp-unit">&deg;C</span>
                </div>
                <svg class="cv-coolant-svg" width="20" height="15" viewBox="0 0 24 18">
                  <path d="M2 6 q3 -4 6 0 t6 0 t6 0" fill="none"></path>
                  <path d="M2 12 q3 -4 6 0 t6 0 t6 0" fill="none"></path>
                </svg>
              </div>
              <div class="cv-temp-label">TEMP</div>
            </div>
            <div class="cv-fuel-module">
              <div class="cv-fuel-inner">
                <div class="cv-fuel-col">
                  ${fuelSegs}
                </div>
                <div class="cv-fuel-markers">
                  <span class="cv-fuel-f-row"><span data-role="fuel-f">F</span><span data-role="fuel-max-gb"></span></span>
                  <span data-role="fuel-half">&frac12;</span>
                  <span data-role="fuel-e">E</span>
                </div>
              </div>
              <div class="cv-fuel-status" data-role="status-label">—</div>
            </div>
          </div>
        </div>
        <div class="cv-divider"></div>
        <div class="cv-bar-row">
          <span class="cv-bar-label">PWR</span>
          <div class="cv-bar-track">
            ${pwrSegs}
          </div>
          <span class="cv-pwr-readout"><span data-role="pwr-digits">—</span><span data-role="pwr-unit"> W</span></span>
        </div>
      </div>`
  }

  function applySegBar(segs, pct, baseColor, baseGlow) {
    const count = segs.length
    const litThresh = Math.max(0, Math.min(100, pct)) / 100 * count
    for (let i = 0; i < count; i++) {
      const frac = (i + 1) / count
      let c = baseColor, gc = baseGlow
      if (frac > 0.90) { c = '#ff2e3e'; gc = '#ff5a68' }
      else if (frac > 0.82) { c = '#ff5a1e'; gc = '#ff8a4a' }
      else if (frac > 0.72) { c = '#ff9a2e'; gc = '#ffb85a' }
      const lit = (i + 1) <= litThresh
      segs[i].style.background = lit ? c : 'rgba(255,255,255,0.07)'
      segs[i].style.boxShadow = lit ? '0 0 7px ' + gc + ', 0 0 2px ' + gc : 'none'
    }
  }

  function applyCol(segs, pct, stops) {
    const count = segs.length
    const litThresh = Math.max(0, Math.min(100, pct)) / 100 * count
    for (let i = 0; i < count; i++) {
      const frac = (i + 1) / count
      let pick = stops[0]
      for (const s of stops) { if (frac > s.from) pick = s }
      const lit = (i + 1) <= litThresh
      segs[i].style.background = lit ? pick.c : 'rgba(255,255,255,0.07)'
      segs[i].style.boxShadow = lit ? '0 0 7px ' + pick.gc + ', 0 0 2px ' + pick.gc : 'none'
    }
  }

  function update(cardEl, gpu) {
    const util = gpu.utilization != null ? Math.max(0, Math.min(100, gpu.utilization)) : null
    const temp = gpu.temperature != null ? gpu.temperature : null
    const memUsed = gpu.memoryUsed
    const memTotal = gpu.memoryTotal
    const pDraw = gpu.powerDraw
    const pLimit = gpu.powerLimit

    // Card styling
    cardEl.style.background = '#0a0805'
    cardEl.style.border = '1px solid rgba(255,176,0,0.22)'
    cardEl.style.borderRadius = '12px'
    cardEl.style.boxShadow = 'inset 3px 0 0 #ffb000'
    cardEl.style.padding = cardEl.classList.contains('compact') ? '14px 16px' : '22px 24px'

    // Header
    const idxEl = cardEl.querySelector('[data-role="idx"]')
    if (idxEl) {
      idxEl.style.width = '26px'
      idxEl.style.height = '26px'
      idxEl.style.borderRadius = '7px'
      idxEl.style.background = 'rgba(255,176,0,0.08)'
      idxEl.style.border = '1px solid rgba(255,176,0,0.25)'
      idxEl.style.display = 'flex'
      idxEl.style.alignItems = 'center'
      idxEl.style.justifyContent = 'center'
      idxEl.style.fontFamily = "'Orbitron', monospace"
      idxEl.style.fontSize = '11px'
      idxEl.style.fontWeight = '700'
      idxEl.style.color = '#ffb000'
    }

    const nameEl = cardEl.querySelector('[data-role="name"]')
    if (nameEl) {
      nameEl.textContent = gpu.name || 'Unknown GPU'
      nameEl.style.fontFamily = "'Rajdhani', sans-serif"
      nameEl.style.fontSize = '16px'
      nameEl.style.fontWeight = '700'
      nameEl.style.color = 'rgba(255,240,220,0.95)'
      nameEl.style.lineHeight = '1.1'
    }

    const hostEl = cardEl.querySelector('[data-role="host"]')
    if (hostEl) {
      hostEl.textContent = gpu.host || ''
      hostEl.style.fontFamily = "'Rajdhani', sans-serif"
      hostEl.style.fontSize = '11px'
      hostEl.style.color = 'rgba(255,176,0,0.5)'
      hostEl.style.letterSpacing = '0.5px'
      hostEl.style.marginTop = '2px'
    }

    // Scale labels
    cardEl.querySelectorAll('[data-role="scale"]').forEach(s => {
      s.style.fontSize = '10px'
      s.style.color = 'rgba(255,174,26,0.55)'
      s.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
      s.style.lineHeight = '1'
    })

    // Wedge bars
    const wedgeBars = cardEl.querySelectorAll('[data-role="wedge-bar"]')
    wedgeBars.forEach((bar, i) => {
      const t = i / 23
      const widthPct = (14 + 86 * Math.pow(t, 1.6)).toFixed(1)
      bar.style.width = widthPct + '%'
      bar.style.flex = '1'
      bar.style.minHeight = '0'
      bar.style.borderRadius = '0 2px 2px 0'

      const color = t > 0.85 ? '#ff2e3e' : t > 0.70 ? '#ff8a1e' : t > 0.45 ? '#ffcc00' : '#2ecc40'
      const unlit = t > 0.85 ? 'rgba(74,20,20,0.5)' : 'rgba(255,255,255,0.07)'
      const litThresh = util != null ? util / 100 * 24 : 0
      const lit = (i + 1) <= litThresh
      bar.style.background = lit ? color : unlit
      bar.style.boxShadow = lit ? '0 0 8px ' + color + 'aa' : 'none'
    })

    // Wedge container
    const wedge = cardEl.querySelector('.cv-wedge')
    if (wedge) {
      wedge.style.position = 'relative'
      wedge.style.flex = '1'
      wedge.style.display = 'flex'
      wedge.style.flexDirection = 'column-reverse'
      wedge.style.gap = '3px'
      wedge.style.alignSelf = 'stretch'
      wedge.style.minHeight = '200px'
      wedge.style.alignItems = 'flex-start'
      wedge.style.background = 'rgba(0,0,0,0.4)'
      wedge.style.borderRadius = '5px'
      wedge.style.padding = '6px 8px'
      wedge.style.boxSizing = 'border-box'
      wedge.style.boxShadow = 'inset 0 1px 4px rgba(0,0,0,0.7)'
    }

    // GPU LOAD box
    const loadBox = cardEl.querySelector('.cv-load-box')
    if (loadBox) {
      loadBox.style.position = 'absolute'
      loadBox.style.right = '6px'
      loadBox.style.bottom = '6px'
      loadBox.style.background = '#180c0c'
      loadBox.style.border = '2px solid #7a4a10'
      loadBox.style.borderRadius = '6px'
      loadBox.style.padding = '4px 12px 5px'
      loadBox.style.boxShadow = 'inset 0 0 14px rgba(255,140,0,0.28)'
      loadBox.style.textAlign = 'center'
    }

    const loadLabel = cardEl.querySelector('.cv-load-label')
    if (loadLabel) {
      loadLabel.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
      loadLabel.style.fontSize = '10px'
      loadLabel.style.fontWeight = '400'
      loadLabel.style.letterSpacing = '2px'
      loadLabel.style.color = '#ff8a1e'
      loadLabel.style.textShadow = '0 0 8px rgba(255,138,30,0.7)'
      loadLabel.style.marginBottom = '3px'
      loadLabel.style.paddingLeft = '2px'
    }

    const loadDiv = cardEl.querySelector('.cv-load-divider')
    if (loadDiv) {
      loadDiv.style.height = '1px'
      loadDiv.style.background = 'linear-gradient(90deg,transparent,rgba(255,138,30,0.5),transparent)'
      loadDiv.style.marginBottom = '4px'
    }

    const utilPctEl = cardEl.querySelector('[data-role="util-pct"]')
    if (utilPctEl) {
      utilPctEl.textContent = util != null ? Math.round(util) : '—'
      utilPctEl.style.fontFamily = "'DSEG7-Classic', 'Share Tech Mono', monospace"
      utilPctEl.style.fontSize = '30px'
      utilPctEl.style.fontWeight = '700'
      utilPctEl.style.color = '#ffae1a'
      utilPctEl.style.textShadow = '0 0 14px rgba(255,174,26,0.75)'
      utilPctEl.style.lineHeight = '1'
    }

    const utilUnit = cardEl.querySelector('[data-role="util-unit"]')
    if (utilUnit) {
      utilUnit.style.fontFamily = "'Share Tech Mono', monospace"
      utilUnit.style.fontSize = '14px'
      utilUnit.style.color = '#ffae1a'
      utilUnit.style.marginTop = '2px'
    }

    // Load val container
    const loadVal = cardEl.querySelector('.cv-load-val')
    if (loadVal) {
      loadVal.style.display = 'flex'
      loadVal.style.alignItems = 'flex-start'
      loadVal.style.justifyContent = 'center'
      loadVal.style.gap = '3px'
    }

    // Scale column
    const scale = cardEl.querySelector('.cv-scale')
    if (scale) {
      scale.style.display = 'flex'
      scale.style.flexDirection = 'column'
      scale.style.justifyContent = 'space-between'
      scale.style.alignSelf = 'stretch'
      scale.style.minHeight = '200px'
      scale.style.padding = '1px 0'
    }

    // Body layout
    const body = cardEl.querySelector('.cv-body')
    if (body) {
      body.style.display = 'flex'
      body.style.gap = '16px'
      body.style.marginBottom = '16px'
      body.style.alignItems = 'stretch'
    }

    const left = cardEl.querySelector('.cv-left')
    if (left) {
      left.style.display = 'flex'
      left.style.gap = '8px'
      left.style.flex = '1'
      left.style.minWidth = '0'
    }

    const right = cardEl.querySelector('.cv-right')
    if (right) {
      right.style.display = 'flex'
      right.style.flexDirection = 'column'
      right.style.justifyContent = 'space-between'
      right.style.alignItems = 'stretch'
      right.style.gap = '10px'
      right.style.width = '152px'
      right.style.flexShrink = '0'
      right.style.paddingBottom = '6px'
      right.style.boxSizing = 'border-box'
    }

    // Header layout
    const header = cardEl.querySelector('.cv-header')
    if (header) {
      header.style.display = 'flex'
      header.style.alignItems = 'flex-start'
      header.style.justifyContent = 'space-between'
      header.style.marginBottom = '14px'
    }

    const nameBlock = cardEl.querySelector('.cv-name-block')
    if (nameBlock) {
      nameBlock.style.display = 'flex'
      nameBlock.style.flexDirection = 'column'
      nameBlock.style.marginLeft = '10px'
    }

    // GPU TEMP module
    const tempModule = cardEl.querySelector('.cv-temp-module')
    if (tempModule) {
      tempModule.style.background = '#0d0a04'
      tempModule.style.border = '2px solid #6a4a10'
      tempModule.style.borderRadius = '8px'
      tempModule.style.padding = '8px 10px'
      tempModule.style.boxShadow = 'inset 0 0 14px rgba(255,140,0,0.18)'
    }

    const tempInner = cardEl.querySelector('.cv-temp-inner')
    if (tempInner) {
      tempInner.style.display = 'flex'
      tempInner.style.alignItems = 'center'
      tempInner.style.gap = '8px'
    }

    const tempCol = cardEl.querySelector('.cv-temp-col')
    if (tempCol) {
      tempCol.style.display = 'flex'
      tempCol.style.flexDirection = 'column-reverse'
      tempCol.style.gap = '2px'
      tempCol.style.height = '44px'
      tempCol.style.width = '9px'
      tempCol.style.background = 'rgba(0,0,0,0.5)'
      tempCol.style.borderRadius = '2px'
      tempCol.style.padding = '2px'
      tempCol.style.boxSizing = 'border-box'
      tempCol.style.flexShrink = '0'
    }

    // Temp segments — all red, per C4 coolant gauge
    const tempSegs = cardEl.querySelectorAll('[data-role="temp-seg"]')
    const tempPct = temp != null ? Math.min(100, Math.max(0, temp)) : 0
    applyCol(tempSegs, tempPct, [{ from: -1, c: '#2ecc40', gc: '#5fe870' }, { from: 0.45, c: '#ffcc00', gc: '#e6c04a' }, { from: 0.70, c: '#ff8a1e', gc: '#ffb85a' }, { from: 0.85, c: '#ff3b30', gc: '#ff6a5a' }])
    tempSegs.forEach(s => {
      s.style.flex = '1'
      s.style.borderRadius = '1px'
    })

    const tempReadout = cardEl.querySelector('.cv-temp-readout')
    if (tempReadout) {
      tempReadout.style.display = 'flex'
      tempReadout.style.alignItems = 'flex-start'
      tempReadout.style.gap = '2px'
      tempReadout.style.flex = '1'
      tempReadout.style.justifyContent = 'center'
    }

    const tempNumEl = cardEl.querySelector('[data-role="temp-num"]')
    if (tempNumEl) {
      tempNumEl.textContent = temp != null ? Math.round(temp) : '—'
      tempNumEl.style.fontFamily = "'DSEG7-Classic', 'Share Tech Mono', monospace"
      tempNumEl.style.fontSize = '32px'
      tempNumEl.style.fontWeight = '700'
      tempNumEl.style.color = '#ffae1a'
      tempNumEl.style.textShadow = '0 0 13px rgba(255,174,26,0.7)'
      tempNumEl.style.lineHeight = '1'
    }

    const tempUnit = cardEl.querySelector('[data-role="temp-unit"]')
    if (tempUnit) {
      tempUnit.style.fontFamily = "'Share Tech Mono', monospace"
      tempUnit.style.fontSize = '13px'
      tempUnit.style.color = '#ffae1a'
      tempUnit.style.marginTop = '1px'
    }

    // Coolant SVG
    const svg = cardEl.querySelector('.cv-coolant-svg')
    if (svg) {
      svg.style.flexShrink = '0'
      svg.querySelectorAll('path').forEach(p => {
        p.setAttribute('stroke', '#ff8a1e')
        p.setAttribute('stroke-width', '1.8')
      })
    }

    const tempLabel = cardEl.querySelector('.cv-temp-label')
    if (tempLabel) {
      tempLabel.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
      tempLabel.style.fontSize = '11px'
      tempLabel.style.letterSpacing = '2px'
      tempLabel.style.color = '#ff8a1e'
      tempLabel.style.textShadow = '0 0 8px rgba(255,138,30,0.6)'
      tempLabel.style.textAlign = 'center'
      tempLabel.style.marginTop = '6px'
    }

    // Fuel module
    const fuelModule = cardEl.querySelector('.cv-fuel-module')
    if (fuelModule) {
      fuelModule.style.background = '#0d0a04'
      fuelModule.style.border = '2px solid #6a4a10'
      fuelModule.style.borderRadius = '8px'
      fuelModule.style.padding = '8px 12px'
      fuelModule.style.boxShadow = 'inset 0 0 14px rgba(255,140,0,0.13)'
    }

    const fuelInner = cardEl.querySelector('.cv-fuel-inner')
    if (fuelInner) {
      fuelInner.style.display = 'flex'
      fuelInner.style.gap = '8px'
      fuelInner.style.justifyContent = 'center'
    }

    const fuelCol = cardEl.querySelector('.cv-fuel-col')
    if (fuelCol) {
      fuelCol.style.display = 'flex'
      fuelCol.style.flexDirection = 'column-reverse'
      fuelCol.style.gap = '2px'
      fuelCol.style.height = '84px'
      fuelCol.style.width = '42px'
      fuelCol.style.background = 'rgba(0,0,0,0.5)'
      fuelCol.style.borderRadius = '3px'
      fuelCol.style.padding = '3px'
      fuelCol.style.boxSizing = 'border-box'
      fuelCol.style.boxShadow = 'inset 0 1px 3px rgba(0,0,0,0.7)'
    }

    // Fuel segments — green with red top zone
    const fuelSegEls = cardEl.querySelectorAll('[data-role="fuel-seg"]')
    const fuelPct = (memUsed != null && memTotal != null) ? Math.round(memUsed / memTotal * 100) : 0
    applyCol(fuelSegEls, fuelPct, [
      { from: -1, c: '#2ecc40', gc: '#5fe870' },
      { from: 0.88, c: '#ff2e3e', gc: '#ff5a68' }
    ])
    fuelSegEls.forEach(s => {
      s.style.flex = '1'
      s.style.borderRadius = '1px'
    })

    // Fuel markers
    const fuelMarkers = cardEl.querySelector('.cv-fuel-markers')
    if (fuelMarkers) {
      fuelMarkers.style.display = 'flex'
      fuelMarkers.style.flexDirection = 'column'
      fuelMarkers.style.justifyContent = 'space-between'
      fuelMarkers.style.padding = '1px 0'
    }

    const fuelFRow = cardEl.querySelector('.cv-fuel-f-row')
    if (fuelFRow) {
      fuelFRow.style.display = 'inline-flex'
      fuelFRow.style.alignItems = 'baseline'
    }
    const fuelF = cardEl.querySelector('[data-role="fuel-f"]')
    if (fuelF) {
      fuelF.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
      fuelF.style.fontSize = '10px'
      fuelF.style.color = '#ffae1a'
    }
    const fuelMaxGb = cardEl.querySelector('[data-role="fuel-max-gb"]')
    if (fuelMaxGb) {
      const totalGB = memTotal ? Math.round(memTotal / 1024) : '—'
      fuelMaxGb.textContent = totalGB + 'G'
      fuelMaxGb.style.marginLeft = '4px'
      fuelMaxGb.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
      fuelMaxGb.style.fontSize = '10px'
      fuelMaxGb.style.color = '#ffae1a'
    }
    const fuelHalf = cardEl.querySelector('[data-role="fuel-half"]')
    if (fuelHalf) {
      fuelHalf.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
      fuelHalf.style.fontSize = '15px'
      fuelHalf.style.fontWeight = '700'
      fuelHalf.style.color = '#ffae1a'
      fuelHalf.style.lineHeight = '1'
    }
    const fuelE = cardEl.querySelector('[data-role="fuel-e"]')
    if (fuelE) {
      fuelE.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
      fuelE.style.fontSize = '10px'
      fuelE.style.color = '#ffae1a'
    }

    // Status label
    const statusEl = cardEl.querySelector('[data-role="status-label"]')
    if (statusEl) {
      statusEl.textContent = 'VRAM'
      statusEl.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
      statusEl.style.fontSize = '10px'
      statusEl.style.letterSpacing = '1px'
      statusEl.style.textAlign = 'center'
      statusEl.style.marginTop = '7px'
      statusEl.style.color = '#ffb000'
      statusEl.style.textShadow = '0 0 9px rgba(255,176,0,0.75)'
    }

    // Divider
    const divider = cardEl.querySelector('.cv-divider')
    if (divider) {
      divider.style.height = '1px'
      divider.style.background = 'rgba(255,176,0,0.12)'
      divider.style.marginBottom = '14px'
    }

    // PWR bar
    const pwrSegs = cardEl.querySelectorAll('[data-role="pwr-seg"]')
    const pwrDigits = cardEl.querySelector('[data-role="pwr-digits"]')
    if (pDraw != null && pLimit) {
      const pwrPct = Math.round(pDraw / pLimit * 100)
      applySegBar(pwrSegs, pwrPct, '#c8a018', '#e6c04a')
      if (pwrDigits) pwrDigits.textContent = Math.round(pDraw)
    } else {
      applySegBar(pwrSegs, 0, '#c8a018', '#e6c04a')
      if (pwrDigits) pwrDigits.textContent = '—'
    }

    // Bar row styling
    cardEl.querySelectorAll('.cv-bar-row').forEach(row => {
      row.style.display = 'flex'
      row.style.alignItems = 'center'
      row.style.gap = '10px'
      row.style.marginBottom = '9px'
    })

    cardEl.querySelectorAll('.cv-bar-label').forEach(lbl => {
      lbl.style.fontSize = '13px'
      lbl.style.fontWeight = '700'
      lbl.style.color = 'rgba(255,176,0,0.6)'
      lbl.style.textTransform = 'uppercase'
      lbl.style.letterSpacing = '0.5px'
      lbl.style.width = '36px'
      lbl.style.flexShrink = '0'
      lbl.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
    })

    cardEl.querySelectorAll('.cv-bar-track').forEach(track => {
      track.style.flex = '1'
      track.style.display = 'flex'
      track.style.gap = '2px'
      track.style.height = '18px'
      track.style.background = 'rgba(0,0,0,0.4)'
      track.style.borderRadius = '3px'
      track.style.padding = '2px 3px'
      track.style.boxSizing = 'border-box'
      track.style.boxShadow = 'inset 0 1px 3px rgba(0,0,0,0.6)'
    })

    const pwrReadout = cardEl.querySelector('.cv-pwr-readout')
    if (pwrReadout) {
      pwrReadout.style.minWidth = '80px'
      pwrReadout.style.textAlign = 'center'
      pwrReadout.style.whiteSpace = 'nowrap'
      pwrReadout.style.background = '#180c0c'
      pwrReadout.style.border = '2px solid #7a4a10'
      pwrReadout.style.borderRadius = '6px'
      pwrReadout.style.padding = '4px 12px 5px'
      pwrReadout.style.boxShadow = 'inset 0 0 14px rgba(255,140,0,0.28)'
    }
    const pwrDigitsEl = cardEl.querySelector('[data-role="pwr-digits"]')
    if (pwrDigitsEl) {
      pwrDigitsEl.style.fontFamily = "'DSEG7-Classic', 'Share Tech Mono', monospace"
      pwrDigitsEl.style.fontSize = '18px'
      pwrDigitsEl.style.color = '#c8a018'
      pwrDigitsEl.style.textShadow = '0 0 8px rgba(200,160,24,0.5)'
    }
    const pwrUnitEl = cardEl.querySelector('[data-role="pwr-unit"]')
    if (pwrUnitEl) {
      pwrUnitEl.style.fontFamily = "'DSEG14-Classic', 'Share Tech Mono', monospace"
      pwrUnitEl.style.fontSize = '18px'
      pwrUnitEl.style.textShadow = '0 0 8px rgba(200,160,24,0.5)'
      pwrUnitEl.style.color = '#ffae1a'
      pwrUnitEl.style.marginLeft = '2px'
    }

    // All seg elements inside bar tracks
    pwrSegs.forEach(s => { s.style.flex = '1'; s.style.borderRadius = '1px' })
  }

  function renderError(hostLabel, errorMsg) {
    return `
      <div class="corvette-card corvette-card-error">
        <div class="cv-header">
          <div class="cv-idx-badge" data-role="idx">!</div>
          <div class="cv-name-block">
            <div class="cv-gpu-name" data-role="name">${esc(hostLabel)}</div>
          </div>
        </div>
        <div class="cv-error-msg" data-role="error-msg">${esc(errorMsg)}</div>
      </div>`
  }

  return { render, update, renderError }
})()
