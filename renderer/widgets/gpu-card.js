// GPU card widget — car dashboard cluster gauges.
// Layout: (VRAM side-L) [GPU Usage full] [Power full] (Temp side-R)
// Side gauges face outward. All drawing self-contained.

const GpuCard = (() => {
  const MAIN_SIZE = 240
  const SIDE_W = 88
  const SIDE_H = 162

  // ── Drawing primitives ──────────────────────────
  function clamp01(v) { return Math.max(0, Math.min(1, v)) }

  function disc(ctx, cx, cy, r, fill) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = fill; ctx.fill()
  }

  function arcStroke(ctx, cx, cy, r, a0, a1, stroke, lw, cap, ccw) {
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1, !!ccw)
    ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.lineCap = cap || 'butt'; ctx.stroke()
  }

  function lineDraw(ctx, x0, y0, x1, y1, stroke, lw) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1)
    ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.lineCap = 'butt'; ctx.stroke()
  }

  function textDraw(ctx, str, x, y, fill, font, align, baseline) {
    ctx.fillStyle = fill; ctx.font = font
    ctx.textAlign = align || 'center'; ctx.textBaseline = baseline || 'middle'
    ctx.fillText(String(str), x, y)
  }

  function prepareCanvas(canvas, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr)
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw; canvas.height = ph
      canvas.style.width = cssW + 'px'
      canvas.style.height = cssH + 'px'
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    return ctx
  }

  function drawChromeKnob(ctx, cx, cy, size) {
    const cap = ctx.createRadialGradient(cx - 1, cy - 1, 0, cx, cy, size)
    cap.addColorStop(0, '#fff'); cap.addColorStop(0.4, '#ccc'); cap.addColorStop(1, '#555')
    disc(ctx, cx, cy, size, cap)
    disc(ctx, cx, cy, size * 0.35, '#222')
  }

  // ── Sport gauge (GPU Usage / Power) ─────────────
  function drawSportGauge(canvas, opts) {
    const {
      value, min = 0, max = 100,
      label = '', unit = '',
      accentColor = '#2e6bff',
      size = 200,
    } = opts

    const ctx = prepareCanvas(canvas, size, size)
    const s = size, cx = s / 2, cy = s / 2, r = s / 2 - 6
    const startAngle = Math.PI * 0.75
    const endAngle = Math.PI * 2.25
    const v = value != null ? value : 0
    const pct = clamp01((v - min) / (max - min))
    const valAngle = startAngle + pct * (endAngle - startAngle)

    // Chrome outer ring
    const chrome = ctx.createLinearGradient(cx - r - 6, cy - r - 6, cx + r + 6, cy + r + 6)
    chrome.addColorStop(0, '#888'); chrome.addColorStop(0.4, '#ddd')
    chrome.addColorStop(0.6, '#fff'); chrome.addColorStop(1, '#666')
    disc(ctx, cx, cy, r + 5, chrome)

    // Dark face
    const face = ctx.createRadialGradient(cx, cy * 0.7, 0, cx, cy, r)
    face.addColorStop(0, '#1e2535'); face.addColorStop(0.6, '#0d1220'); face.addColorStop(1, '#080c16')
    disc(ctx, cx, cy, r, face)

    // Dot texture
    ctx.save()
    ctx.beginPath(); ctx.arc(cx, cy, r - 2, 0, Math.PI * 2); ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.025)'
    for (let row = 0; row < s; row += 6) {
      for (let col = (row % 12 === 0 ? 0 : 3); col < s; col += 6) {
        const dx = col - cx, dy = row - cy
        if (dx * dx + dy * dy < (r - 4) * (r - 4)) {
          ctx.beginPath(); ctx.arc(col, row, 0.8, 0, Math.PI * 2); ctx.fill()
        }
      }
    }
    ctx.restore()

    // Track + value arc (2x thick)
    arcStroke(ctx, cx, cy, r - 12, startAngle, endAngle, 'rgba(255,255,255,0.07)', 8, 'round')
    if (pct > 0) {
      ctx.shadowColor = accentColor; ctx.shadowBlur = 12
      arcStroke(ctx, cx, cy, r - 12, startAngle, valAngle, accentColor, 8, 'round')
      ctx.shadowBlur = 0
    }

    // Ticks + scale numbers
    const numMajor = 8
    for (let i = 0; i <= numMajor * 5; i++) {
      const a = startAngle + (i / (numMajor * 5)) * (endAngle - startAngle)
      const isMajor = i % 5 === 0
      const outer = r - 18, inner = isMajor ? r - 32 : r - 24
      lineDraw(ctx, cx + Math.cos(a) * outer, cy + Math.sin(a) * outer,
        cx + Math.cos(a) * inner, cy + Math.sin(a) * inner,
        isMajor ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.25)', isMajor ? 1.8 : 0.8)
      if (isMajor) {
        const tv = Math.round(min + (i / (numMajor * 5)) * (max - min))
        textDraw(ctx, tv, cx + Math.cos(a) * (r - 46), cy + Math.sin(a) * (r - 46),
          'rgba(255,255,255,0.75)', `600 ${Math.round(s * 0.085)}px Rajdhani, sans-serif`)
      }
    }

    // Needle — thick tapered
    ctx.save()
    ctx.translate(cx, cy); ctx.rotate(valAngle)
    const nLen = r - 26
    const ng = ctx.createLinearGradient(0, 0, nLen, 0)
    ng.addColorStop(0, 'rgba(255,255,255,0.9)'); ng.addColorStop(0.7, accentColor); ng.addColorStop(1, 'rgba(255,255,255,0.2)')
    ctx.beginPath()
    ctx.moveTo(-r * 0.15, 3.5); ctx.lineTo(nLen, 0.5); ctx.lineTo(nLen, -0.5); ctx.lineTo(-r * 0.15, -3.5); ctx.closePath()
    ctx.fillStyle = ng; ctx.shadowColor = accentColor; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0
    ctx.restore()

    // Chrome center knob
    drawChromeKnob(ctx, cx, cy, s * 0.06)

    // Label at bottom of gauge face
    textDraw(ctx, label, cx, cy + r * 0.65, 'rgba(255,255,255,0.45)',
      `700 ${Math.round(s * 0.065)}px Rajdhani, sans-serif`)

    // Unit symbol with glow
    ctx.shadowColor = accentColor; ctx.shadowBlur = 14
    textDraw(ctx, unit, cx, cy + r * 0.82, accentColor,
      `700 ${Math.round(s * 0.09)}px Rajdhani, sans-serif`)
    ctx.shadowBlur = 0
  }

  // ── Side gauge (VRAM left / Temp right) ─────────
  function drawSideGauge(canvas, opts) {
    const {
      value, min = 0, max = 100,
      labelStart = '', labelEnd = '',
      accentColor = '#F5A623',
      side = 'left',
    } = opts

    const w = SIDE_W, h = SIDE_H
    const ctx = prepareCanvas(canvas, w, h)
    const cy = h / 2
    const r = h / 2 - 10
    const cx = side === 'left' ? w - 6 : 6

    const v = value != null ? value : 0
    const pct = clamp01((v - min) / (max - min))

    const startAngle = side === 'left' ? Math.PI / 2 : -Math.PI / 2
    const endAngle = startAngle + Math.PI
    const valAngle = startAngle + pct * Math.PI

    // Chrome bezel
    const chrome = ctx.createLinearGradient(0, cy - r, w, cy + r)
    chrome.addColorStop(0, '#777'); chrome.addColorStop(0.4, '#ccc')
    chrome.addColorStop(0.6, '#eee'); chrome.addColorStop(1, '#555')
    disc(ctx, cx, cy, r + 4, chrome)

    // Dark face
    const face = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    face.addColorStop(0, '#1a2030'); face.addColorStop(0.6, '#0d1220'); face.addColorStop(1, '#080c16')
    disc(ctx, cx, cy, r, face)

    // Dot texture
    ctx.save()
    ctx.beginPath(); ctx.arc(cx, cy, r - 2, 0, Math.PI * 2); ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    for (let row = 0; row < h; row += 8) {
      for (let col = 0; col < w; col += 8) {
        const dx = col - cx, dy = row - cy
        if (dx * dx + dy * dy < (r - 4) * (r - 4)) {
          ctx.beginPath(); ctx.arc(col, row, 0.6, 0, Math.PI * 2); ctx.fill()
        }
      }
    }
    ctx.restore()

    // Track arc (25% thicker: 3 → 3.75)
    arcStroke(ctx, cx, cy, r - 8, startAngle, endAngle, 'rgba(255,255,255,0.06)', 3.75, 'round')

    // Value arc with glow (25% thicker)
    if (pct > 0.005) {
      ctx.shadowColor = accentColor; ctx.shadowBlur = 8
      arcStroke(ctx, cx, cy, r - 8, startAngle, valAngle, accentColor, 3.75, 'round')
      ctx.shadowBlur = 0
    }

    // Ticks
    for (let i = 0; i <= 20; i++) {
      const a = startAngle + (i / 20) * Math.PI
      const isMajor = i % 5 === 0
      const outer = r - 11, inner = isMajor ? r - 22 : r - 16
      lineDraw(ctx, cx + Math.cos(a) * outer, cy + Math.sin(a) * outer,
        cx + Math.cos(a) * inner, cy + Math.sin(a) * inner,
        isMajor ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.2)', isMajor ? 1.2 : 0.6)
    }

    // Start / end labels — well clear of inner gauge bezel
    const lr = r - 42
    const sOff = 0.38
    textDraw(ctx, labelStart,
      cx + Math.cos(startAngle + sOff) * lr, cy + Math.sin(startAngle + sOff) * lr,
      'rgba(255,255,255,0.75)', `700 ${Math.round(r * 0.28)}px Rajdhani, sans-serif`)
    textDraw(ctx, labelEnd,
      cx + Math.cos(endAngle - sOff) * lr, cy + Math.sin(endAngle - sOff) * lr,
      'rgba(255,255,255,0.75)', `700 ${Math.round(r * 0.28)}px Rajdhani, sans-serif`)

    // Needle — thicker
    ctx.save()
    ctx.translate(cx, cy); ctx.rotate(valAngle)
    const nLen = r - 14
    ctx.beginPath()
    ctx.moveTo(-r * 0.1, 2); ctx.lineTo(nLen, 0.4); ctx.lineTo(nLen, -0.4); ctx.moveTo(-r * 0.1, -2); ctx.closePath()
    ctx.fillStyle = accentColor
    ctx.shadowColor = accentColor; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0
    ctx.restore()

    // Chrome center knob (same as sport gauges)
    drawChromeKnob(ctx, cx, cy, r * 0.09)
  }

  // ── HTML helpers ────────────────────────────────
  function esc(str) {
    const el = document.createElement('span')
    el.textContent = str
    return el.innerHTML
  }

  function tempColor(t) {
    if (t == null) return '#FF4757'
    if (t < 45) return '#00D4AA'
    if (t < 65) return '#FFC857'
    return '#FF4757'
  }

  function utilColor(u) {
    if (u == null) return '#00D4AA'
    if (u < 50) return '#00D4AA'
    if (u < 85) return '#4C9AFF'
    return '#F5A623'
  }

  // ── Card rendering ──────────────────────────────
  function render(gpu) {
    return `
      <div class="gpu-card">
        <div class="gpu-header">
          <span class="gpu-index-badge">${gpu.index}</span>
          <span class="gpu-name">${esc(gpu.name || 'Unknown GPU')}</span>
        </div>
        <div class="gauge-row">
          <div class="gauge-col gauge-col-side gauge-col-left">
            <canvas class="gauge-vram gpu-gauge-half"></canvas>
            <div class="gauge-label">VRAM</div>
            <div class="gauge-value gauge-value-vram"></div>
          </div>
          <div class="gauge-col gauge-col-center">
            <canvas class="gauge-util gpu-gauge-lg"></canvas>
          </div>
          <div class="gauge-col gauge-col-center">
            <canvas class="gauge-power gpu-gauge-lg"></canvas>
          </div>
          <div class="gauge-col gauge-col-side gauge-col-right">
            <canvas class="gauge-temp gpu-gauge-half"></canvas>
            <div class="gauge-label">TEMP</div>
            <div class="gauge-value gauge-value-temp"></div>
          </div>
        </div>
      </div>`
  }

  function drawGauges(cardEl, gpu) {
    cardEl.style.borderTopColor = utilColor(gpu.utilization)
    const utilCanvas = cardEl.querySelector('.gauge-util')
    const powerCanvas = cardEl.querySelector('.gauge-power')
    const vramCanvas = cardEl.querySelector('.gauge-vram')
    const tempCanvas = cardEl.querySelector('.gauge-temp')

    if (utilCanvas) {
      drawSportGauge(utilCanvas, {
        value: gpu.utilization,
        min: 0, max: 100,
        label: 'GPU LOAD', unit: '%',
        accentColor: utilColor(gpu.utilization),
        size: MAIN_SIZE,
      })
    }

    if (powerCanvas) {
      const powColor = gpu.powerDraw != null && gpu.powerLimit
        ? (gpu.powerDraw / gpu.powerLimit > 0.85 ? '#FF4757' : '#FF9500')
        : '#FF9500'
      drawSportGauge(powerCanvas, {
        value: gpu.powerDraw != null ? Math.round(gpu.powerDraw) : null,
        min: 0, max: gpu.powerLimit || 350,
        label: 'POWER', unit: 'W',
        accentColor: powColor,
        size: MAIN_SIZE,
      })
    }

    if (vramCanvas) {
      const memPct = gpu.memoryUsed != null && gpu.memoryTotal
        ? gpu.memoryUsed / gpu.memoryTotal : 0
      const memColor = memPct > 0.9 ? '#FF4757' : memPct > 0.7 ? '#FFC857' : '#F5A623'
      drawSideGauge(vramCanvas, {
        value: gpu.memoryUsed,
        min: 0, max: gpu.memoryTotal || 1,
        labelStart: 'E', labelEnd: 'F',
        accentColor: memColor,
        side: 'left',
      })
      const vramVal = cardEl.querySelector('.gauge-value-vram')
      if (vramVal) {
        vramVal.textContent = gpu.memoryUsed != null
          ? `${Math.round(gpu.memoryUsed / 1024 * 10) / 10}G`
          : '—'
        vramVal.style.color = memColor
      }
    }

    if (tempCanvas) {
      drawSideGauge(tempCanvas, {
        value: gpu.temperature,
        min: 0, max: 100,
        labelStart: '0', labelEnd: '100',
        accentColor: tempColor(gpu.temperature),
        side: 'right',
      })
      const tempVal = cardEl.querySelector('.gauge-value-temp')
      if (tempVal) {
        tempVal.textContent = gpu.temperature != null ? `${gpu.temperature}°` : '—'
        tempVal.style.color = tempColor(gpu.temperature)
      }
    }
  }

  function renderError(hostLabel, errorMsg) {
    return `
      <div class="gpu-card gpu-card-error">
        <div class="gpu-header">
          <span class="gpu-name">${esc(hostLabel)}</span>
        </div>
        <div class="error-body">
          <div class="error-icon">!</div>
          <div class="error-msg">${esc(errorMsg)}</div>
        </div>
      </div>`
  }

  return { render, renderError, drawGauges }
})()
