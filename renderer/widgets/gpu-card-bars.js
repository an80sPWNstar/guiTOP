// GPU card widget — bar-based skin (tempsLCD-style cards).
// Each card: model + clock, GPU index + temp, utilization bar, VRAM bar + power.

const GpuCardBars = (() => {
  function esc(str) {
    const el = document.createElement('span')
    el.textContent = str
    return el.innerHTML
  }

  function fmtVram(used, total) {
    const u = used != null
      ? (used >= 1024 ? (used / 1024).toFixed(1) : Math.round(used) + 'M')
      : '—'
    const t = total != null
      ? (total >= 1024 ? (total / 1024).toFixed(1) + 'G' : Math.round(total) + 'M')
      : '—'
    return u + ' / ' + t
  }

  function tempColor(t) {
    if (t == null) return 'rgba(255,255,255,0.7)'
    if (t < 50) return '#94a3b8'
    if (t < 70) return '#fbbf24'
    return '#ef4444'
  }

  function render(gpu, compact) {
    const cls = compact ? 'bar-card compact' : 'bar-card'
    const utilPct = gpu.utilization ?? 0
    const vram = fmtVram(gpu.memoryUsed, gpu.memoryTotal)
    const temp = gpu.temperature != null ? gpu.temperature + '°C' : '—'
    const tc = tempColor(gpu.temperature)
    const clock = gpu.clockSm != null
      ? (gpu.clockSm / 1000).toFixed(1) + 'Ghz' : ''
    const pwr = gpu.powerDraw != null ? Math.round(gpu.powerDraw) : null
    const pwrLim = gpu.powerLimit ? Math.round(gpu.powerLimit) : null
    const pwrText = pwr != null
      ? pwr + (pwrLim ? '/' + pwrLim : '') + 'W' : ''

    return `
      <div class="${cls}" data-gpu-idx="${gpu.index}">
        <div class="bar-top">
          <span class="bar-model">◆ ${esc(gpu.name || 'GPU')}</span>
          ${clock ? `<span class="bar-clock">⚡ ${clock}</span>` : ''}
        </div>
        <div class="bar-main">
          <span class="bar-label">GPU ${gpu.index}</span>
          <span class="bar-temp" data-val="temp">🌡 ${temp}</span>
        </div>
        <div class="bar-row">
          <div class="bar-track">
            <div class="bar-fill" data-fill="util"></div>
          </div>
          <span class="bar-pct" data-val="util">${utilPct}%</span>
        </div>
        <div class="bar-sub">
          <span class="bar-sub-lbl">VRAM</span>
          <div class="bar-track bar-track-sm">
            <div class="bar-fill bar-fill-mem" data-fill="mem"></div>
          </div>
          <span class="bar-sub-val" data-val="mem">${vram}</span>
          ${pwrText ? `<span class="bar-sub-pwr" data-val="pwr">${pwrText}</span>` : ''}
        </div>
      </div>`
  }

  function update(cardEl, gpu) {
    const utilPct = gpu.utilization ?? 0
    const memPct = (gpu.memoryUsed != null && gpu.memoryTotal)
      ? Math.round(gpu.memoryUsed / gpu.memoryTotal * 100) : 0

    const utilFill = cardEl.querySelector('[data-fill="util"]')
    if (utilFill) utilFill.style.width = utilPct + '%'

    const utilText = cardEl.querySelector('[data-val="util"]')
    if (utilText) utilText.textContent = utilPct + '%'

    const tempEl = cardEl.querySelector('[data-val="temp"]')
    if (tempEl) {
      const t = gpu.temperature
      tempEl.textContent = '🌡 ' + (t != null ? t + '°C' : '—')
      tempEl.style.color = tempColor(t)
    }

    const memFill = cardEl.querySelector('[data-fill="mem"]')
    if (memFill) memFill.style.width = memPct + '%'

    const memText = cardEl.querySelector('[data-val="mem"]')
    if (memText) memText.textContent = fmtVram(gpu.memoryUsed, gpu.memoryTotal)

    const pwrEl = cardEl.querySelector('[data-val="pwr"]')
    if (pwrEl) {
      const p = gpu.powerDraw != null ? Math.round(gpu.powerDraw) : null
      const pl = gpu.powerLimit ? Math.round(gpu.powerLimit) : null
      pwrEl.textContent = p != null ? p + (pl ? '/' + pl : '') + 'W' : ''
    }

    const clockEl = cardEl.querySelector('.bar-clock')
    if (clockEl && gpu.clockSm != null) {
      clockEl.textContent = '⚡ ' + (gpu.clockSm / 1000).toFixed(1) + 'Ghz'
    }
  }

  function renderError(hostLabel, errorMsg) {
    return `
      <div class="bar-card bar-card-error">
        <div class="bar-top">
          <span class="bar-model">◆ ${esc(hostLabel)}</span>
        </div>
        <div class="bar-main">
          <span class="bar-label bar-label-error">Error</span>
        </div>
        <div class="bar-error-msg">${esc(errorMsg)}</div>
      </div>`
  }

  return { render, update, renderError }
})()
