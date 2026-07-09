/* ============================================================================
 * tempsLCD — Car Gauge Skin Library  (framework-free, plain ES module/global)
 * ----------------------------------------------------------------------------
 * Pure <canvas> 2D drawing. No React, no build step, no dependencies.
 * Drop this file into the Electron renderer and call the draw functions from
 * your existing render(payload) loop in renderer/renderer.js.
 *
 * Three skins are provided:
 *   1. drawSportGauge(...)  — single round gauge, "Sport / Cobalt" style
 *   2. drawJdmGauge(...)    — single round gauge, "JDM / Track" style
 *   3. SupercarDashboard    — full instrument-cluster panel (class)
 *
 * Fonts used: 'Rajdhani' (labels/numerals) and 'Orbitron' (digital readouts).
 *   - Orbitron is ALREADY bundled in assets/fonts/.
 *   - Rajdhani is NOT yet bundled — see README "Fonts" before shipping.
 *     If you don't add Rajdhani, the code still runs (falls back to sans-serif),
 *     but it won't match the mockups. Easiest swap: change every 'Rajdhani'
 *     below to 'Orbitron' or another bundled face.
 *
 * Coordinate convention: every function takes a 2D context already scaled for
 * devicePixelRatio by the caller helper `prepareCanvas()`. Use that helper so
 * the gauges stay crisp on HiDPI displays.
 * ==========================================================================*/

(function (root) {
  'use strict';

  // --- HiDPI canvas setup. Call once per draw; returns {ctx, w, h}. ---------
  function prepareCanvas(canvas, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx, w: cssW, h: cssH };
  }

  /* ==========================================================================
   * 1. SPORT / COBALT — single round gauge
   *    chrome ring · dark blue knurled face · glowing accent arc · white needle
   * ------------------------------------------------------------------------ */
  function drawSportGauge(canvas, opts) {
    const {
      value, min = 0, max = 100,
      label = '', unit = '',
      accentColor = '#2e6bff',
      size = 200,
    } = opts;

    const { ctx } = prepareCanvas(canvas, size, size);
    const s = size, cx = s / 2, cy = s / 2, r = s / 2 - 6;
    const startAngle = Math.PI * 0.75;
    const endAngle = Math.PI * 2.25;
    const pct = clamp01((value - min) / (max - min));
    const valAngle = startAngle + pct * (endAngle - startAngle);

    // Chrome outer ring
    const chrome = ctx.createLinearGradient(cx - r - 6, cy - r - 6, cx + r + 6, cy + r + 6);
    chrome.addColorStop(0, '#888'); chrome.addColorStop(0.4, '#ddd');
    chrome.addColorStop(0.6, '#fff'); chrome.addColorStop(1, '#666');
    disc(ctx, cx, cy, r + 5, chrome);

    // Dark blue radial face
    const face = ctx.createRadialGradient(cx, cy * 0.7, 0, cx, cy, r);
    face.addColorStop(0, '#1e2535'); face.addColorStop(0.6, '#0d1220'); face.addColorStop(1, '#080c16');
    disc(ctx, cx, cy, r, face);

    // Perforated dot texture
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r - 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let row = 0; row < s; row += 6) {
      for (let col = (row % 12 === 0 ? 0 : 3); col < s; col += 6) {
        const dx = col - cx, dy = row - cy;
        if (dx * dx + dy * dy < (r - 4) * (r - 4)) {
          ctx.beginPath(); ctx.arc(col, row, 0.8, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.restore();

    // Track + value arc
    arc(ctx, cx, cy, r - 12, startAngle, endAngle, 'rgba(255,255,255,0.07)', 4, 'round');
    if (pct > 0) {
      ctx.shadowColor = accentColor; ctx.shadowBlur = 8;
      arc(ctx, cx, cy, r - 12, startAngle, valAngle, accentColor, 4, 'round');
      ctx.shadowBlur = 0;
    }

    // Ticks + labels
    const numMajor = 8;
    for (let i = 0; i <= numMajor * 5; i++) {
      const a = startAngle + (i / (numMajor * 5)) * (endAngle - startAngle);
      const isMajor = i % 5 === 0;
      const outer = r - 16, inner = isMajor ? r - 28 : r - 22;
      line(ctx, cx + Math.cos(a) * outer, cy + Math.sin(a) * outer,
        cx + Math.cos(a) * inner, cy + Math.sin(a) * inner,
        isMajor ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.25)', isMajor ? 1.5 : 0.8);
      if (isMajor) {
        const tv = Math.round(min + (i / (numMajor * 5)) * (max - min));
        text(ctx, tv, cx + Math.cos(a) * (r - 38), cy + Math.sin(a) * (r - 38),
          'rgba(255,255,255,0.55)', `${Math.round(s * 0.065)}px 'Rajdhani', sans-serif`);
      }
    }

    // Needle
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(valAngle);
    const nLen = r - 22;
    const ng = ctx.createLinearGradient(0, 0, nLen, 0);
    ng.addColorStop(0, 'rgba(255,255,255,0.9)'); ng.addColorStop(0.7, accentColor); ng.addColorStop(1, 'rgba(255,255,255,0.2)');
    ctx.beginPath();
    ctx.moveTo(-r * 0.18, 1.2); ctx.lineTo(nLen, 0); ctx.lineTo(-r * 0.18, -1.2); ctx.closePath();
    ctx.fillStyle = ng; ctx.shadowColor = accentColor; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;
    ctx.restore();

    // Chrome center cap
    const cap = ctx.createRadialGradient(cx - 2, cy - 2, 0, cx, cy, s * 0.07);
    cap.addColorStop(0, '#fff'); cap.addColorStop(0.4, '#ccc'); cap.addColorStop(1, '#555');
    disc(ctx, cx, cy, s * 0.07, cap);
    disc(ctx, cx, cy, s * 0.025, '#222');

    // Value + unit + label
    ctx.shadowColor = accentColor; ctx.shadowBlur = 12;
    text(ctx, Math.round(value), cx, cy + r * 0.35, 'rgba(255,255,255,0.92)', `700 ${Math.round(s * 0.155)}px 'Orbitron', monospace`);
    ctx.shadowBlur = 0;
    text(ctx, unit, cx, cy + r * 0.52, 'rgba(255,255,255,0.35)', `${Math.round(s * 0.07)}px 'Rajdhani', sans-serif`);
    text(ctx, label, cx, cy - r * 0.42, 'rgba(255,255,255,0.25)', `600 ${Math.round(s * 0.07)}px 'Rajdhani', sans-serif`);
  }

  /* ==========================================================================
   * 2. JDM / TRACK — single round gauge
   *    matte bezel · concentric knurl · yellow ticks · red redline · slim needle
   * ------------------------------------------------------------------------ */
  function drawJdmGauge(canvas, opts) {
    const {
      value, min = 0, max = 100,
      label = '', unit = '',
      redlineStart = max * 0.85,
      size = 200,
    } = opts;

    const { ctx } = prepareCanvas(canvas, size, size);
    const s = size, cx = s / 2, cy = s / 2, r = s / 2 - 4;
    const startAngle = Math.PI * 0.72;
    const endAngle = Math.PI * 2.28;
    const pct = clamp01((value - min) / (max - min));
    const valAngle = startAngle + pct * (endAngle - startAngle);
    const redlinePct = (redlineStart - min) / (max - min);
    const redlineAngle = startAngle + redlinePct * (endAngle - startAngle);

    // Matte bezel
    const bez = ctx.createLinearGradient(0, 0, s, s);
    bez.addColorStop(0, '#3a3a3a'); bez.addColorStop(1, '#111');
    disc(ctx, cx, cy, r + 3, bez);
    ring(ctx, cx, cy, r + 0.5, 'rgba(255,255,255,0.12)', 1);

    // Dark face
    const face = ctx.createRadialGradient(cx, cy * 0.8, 0, cx, cy, r);
    face.addColorStop(0, '#1a1a1a'); face.addColorStop(1, '#0a0a0a');
    disc(ctx, cx, cy, r, face);

    // Concentric + radial knurl
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    for (let ri = 10; ri < r; ri += 8) ring(ctx, cx, cy, ri, 'rgba(255,255,255,0.03)', 1);
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 60) {
      line(ctx, cx + Math.cos(a) * 10, cy + Math.sin(a) * 10,
        cx + Math.cos(a) * (r - 18), cy + Math.sin(a) * (r - 18), 'rgba(255,255,255,0.015)', 0.5);
    }
    ctx.restore();

    // Ticks (yellow major, red in redzone) + labels
    const numMajor = 8;
    for (let i = 0; i <= numMajor * 5; i++) {
      const a = startAngle + (i / (numMajor * 5)) * (endAngle - startAngle);
      const isMajor = i % 5 === 0;
      const isRed = i / (numMajor * 5) >= redlinePct;
      const outer = r - 8, inner = isMajor ? r - 24 : r - 16;
      const col = isRed ? '#ff2020' : (isMajor ? 'rgba(255,230,80,0.9)' : 'rgba(255,255,255,0.3)');
      line(ctx, cx + Math.cos(a) * outer, cy + Math.sin(a) * outer,
        cx + Math.cos(a) * inner, cy + Math.sin(a) * inner, col, isMajor ? (isRed ? 2 : 1.5) : (isRed ? 1 : 0.7));
      if (isMajor) {
        const tv = Math.round(min + (i / (numMajor * 5)) * (max - min));
        text(ctx, tv, cx + Math.cos(a) * (r - 34), cy + Math.sin(a) * (r - 34),
          isRed ? '#ff4444' : 'rgba(255,230,80,0.85)', `${Math.round(s * 0.068)}px 'Rajdhani', sans-serif`);
      }
    }

    // Redline arc
    ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 8;
    arc(ctx, cx, cy, r - 12, redlineAngle, endAngle, 'rgba(255,0,0,0.4)', 6, 'butt');
    ctx.shadowBlur = 0;

    // Slim red needle
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(valAngle);
    ctx.beginPath();
    ctx.moveTo(-r * 0.15, 0.7); ctx.lineTo(r - 18, 0); ctx.lineTo(-r * 0.15, -0.7); ctx.closePath();
    ctx.fillStyle = '#ff3030'; ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;
    ctx.restore();

    // Hub
    const hub = ctx.createRadialGradient(cx - 1, cy - 1, 0, cx, cy, s * 0.055);
    hub.addColorStop(0, '#555'); hub.addColorStop(1, '#111');
    disc(ctx, cx, cy, s * 0.055, hub);
    disc(ctx, cx, cy, s * 0.02, '#ff3030');

    // Inset digital readout
    const bw = s * 0.42, bh = s * 0.16, bx = cx - bw / 2, by = cy + r * 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 3); ctx.fill();
    ring(ctx, 0, 0, 0); // no-op guard
    ctx.strokeStyle = 'rgba(255,230,80,0.25)'; ctx.lineWidth = 0.5; ctx.stroke();
    text(ctx, Math.round(value) + unit, cx, by + bh * 0.5, 'rgba(255,230,80,0.9)', `700 ${Math.round(s * 0.13)}px 'Orbitron', monospace`);

    // Label
    text(ctx, label, cx, cy - r * 0.45, 'rgba(255,255,255,0.3)', `600 ${Math.round(s * 0.065)}px 'Rajdhani', sans-serif`);
  }

  /* ==========================================================================
   * 3. SUPERCAR DASHBOARD — full instrument-cluster panel
   *    Designed for a wide widget (default 1280×460).
   *    Usage:
   *       const dash = new SupercarDashboard(canvasEl);   // or {width,height}
   *       dash.render({ cpuTemp, cpuLoad, gpuTemp, gpuLoad, ram, fan, source });
   *    All inputs are plain numbers (already-picked sensor values). `source`
   *    is a string ('HWiNFO' for live, anything else = demo).
   * ------------------------------------------------------------------------ */
  class SupercarDashboard {
    constructor(canvas, { width = 1280, height = 460 } = {}) {
      this.canvas = canvas;
      this.W = width;
      this.H = height;
      this.data = { cpuTemp: 0, cpuLoad: 0, gpuTemp: 0, gpuLoad: 0, ram: 0, fan: 0, source: 'demo' };
    }

    render(data) {
      Object.assign(this.data, data);
      this._draw();
    }

    _draw() {
      const { ctx } = prepareCanvas(this.canvas, this.W, this.H);
      const W = this.W, H = this.H;
      const CX = W / 2, CY = H / 2 - 5;
      const LCX = 272, RCX = W - 272;
      const { cpuTemp, cpuLoad, gpuTemp, gpuLoad, ram, fan, source } = this.data;
      const isLive = source === 'HWiNFO';

      // Background carbon + vignette
      ctx.fillStyle = '#0e0e0e'; ctx.fillRect(0, 0, W, H);
      this._carbon(ctx, 0, 0, W, H);
      const bgV = ctx.createLinearGradient(0, 0, W, 0);
      bgV.addColorStop(0, 'rgba(0,0,0,0.35)'); bgV.addColorStop(0.35, 'rgba(0,0,0,0.08)');
      bgV.addColorStop(0.65, 'rgba(0,0,0,0.08)'); bgV.addColorStop(1, 'rgba(0,0,0,0.35)');
      ctx.fillStyle = bgV; ctx.fillRect(0, 0, W, H);

      // V-shaped cyan dividers
      ctx.save();
      ctx.strokeStyle = 'rgba(0,200,230,0.7)'; ctx.lineWidth = 1.2;
      ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.moveTo(CX - 185, CY - 50); ctx.lineTo(LCX + 118, 8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(CX - 185, CY + 50); ctx.lineTo(LCX + 118, H - 8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(CX + 185, CY - 50); ctx.lineTo(RCX - 118, 8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(CX + 185, CY + 50); ctx.lineTo(RCX - 118, H - 8); ctx.stroke();
      ctx.shadowBlur = 0; ctx.restore();
      [[LCX, CY], [RCX, CY]].forEach(([px, py]) => {
        const g = ctx.createRadialGradient(px, py, 0, px, py, 160);
        g.addColorStop(0, 'rgba(0,80,100,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      });

      // Vertical edge bars
      this._vbar(ctx, 44, CY, 200, gpuTemp, 20, 100, '#ff6020', 'GPU °C');
      this._vbar(ctx, 62, CY, 200, gpuLoad, 0, 100, '#ff205a', 'GPU %');
      this._vbar(ctx, W - 44, CY, 200, ram, 0, 100, '#00bcd4', 'RAM %');
      this._vbar(ctx, W - 62, CY, 200, fan / 4800 * 100, 0, 100, '#ff2020', 'FAN');

      // Clusters + main tach
      this._leftCluster(ctx, LCX, CY, gpuTemp, gpuLoad);
      this._rightCluster(ctx, RCX, CY, ram, fan);
      this._mainTach(ctx, CX, CY, cpuLoad, cpuTemp);

      // Top strip
      text(ctx, `${gpuTemp.toFixed(1)}°C`, CX - 300, 26, 'rgba(255,255,255,0.52)', `500 13px 'Rajdhani', sans-serif`, 'left');
      text(ctx, 'GPU TEMP', CX - 300, 40, 'rgba(255,255,255,0.28)', `400 11px 'Rajdhani', sans-serif`, 'left');
      const now = new Date();
      const clock = `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() >= 12 ? 'PM' : 'AM'}`;
      text(ctx, clock, CX + 300, 26, 'rgba(255,255,255,0.52)', `500 13px 'Rajdhani', sans-serif`, 'right');
      text(ctx, 'SYSTEM TIME', CX + 300, 40, 'rgba(255,255,255,0.28)', `400 11px 'Rajdhani', sans-serif`, 'right');

      // Bottom strip
      text(ctx, `${isLive ? 'HWiNFO — LIVE' : 'HWiNFO — DEMO MODE'}`, LCX - 80, H - 22, 'rgba(255,255,255,0.18)', `500 11px 'Rajdhani', sans-serif`, 'left');
      text(ctx, `CPU ${Math.round(cpuLoad)}%  |  RAM ${Math.round(ram)}%  |  FAN ${Math.round(fan)} RPM`,
        RCX + 80, H - 22, 'rgba(255,255,255,0.18)', `500 11px 'Rajdhani', sans-serif`, 'right');
      ctx.beginPath(); ctx.arc(LCX - 100, H - 22, 3, 0, Math.PI * 2);
      ctx.fillStyle = isLive ? '#00dc82' : '#ffb020';
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 5; ctx.fill(); ctx.shadowBlur = 0;
    }

    // ---- Texture + primitives -------------------------------------------
    _carbon(ctx, x, y, w, h) {
      const ts = 7;
      ctx.save(); ctx.rect(x, y, w, h); ctx.clip();
      for (let row = 0; row * ts < h + ts; row++) {
        for (let col = 0; col * ts * 2 < w + ts * 2; col++) {
          const phase = row % 2;
          const bx = x + col * ts * 2 + (phase === 0 ? 0 : ts);
          const by = y + row * ts;
          ctx.fillStyle = '#1c1c1c'; ctx.fillRect(bx, by, ts, ts);
          ctx.fillStyle = 'rgba(55,55,55,0.55)';
          ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + ts, by); ctx.lineTo(bx, by + ts); ctx.fill();
          ctx.fillStyle = '#101010'; ctx.fillRect(bx - ts, by, ts, ts);
          ctx.fillStyle = 'rgba(38,38,38,0.5)';
          ctx.beginPath(); ctx.moveTo(bx, by + ts); ctx.lineTo(bx - ts, by + ts); ctx.lineTo(bx, by); ctx.fill();
        }
      }
      ctx.restore();
    }

    _hex(ctx, cx, cy, clipR, sz = 9) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, clipR, 0, Math.PI * 2); ctx.clip();
      const W = Math.sqrt(3) * sz, rowH = sz * 1.5;
      const x0 = cx - clipR - sz * 3, y0 = cy - clipR - sz * 3;
      for (let row = 0; y0 + row * rowH < cy + clipR + sz * 2; row++) {
        const off = row % 2 === 0 ? 0 : W / 2;
        for (let col = 0; x0 + col * W < cx + clipR + sz * 2; col++) {
          const hx = x0 + col * W + off, hy = y0 + row * rowH;
          const dist = Math.hypot(hx - cx, hy - cy);
          if (dist > clipR + sz) continue;
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i - Math.PI / 6;
            const px = hx + Math.cos(a) * (sz - 0.8), py = hy + Math.sin(a) * (sz - 0.8);
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.closePath();
          const l = Math.round(14 + Math.min(1, dist / clipR) * 12);
          ctx.fillStyle = `rgb(${l},${l},${l})`; ctx.fill();
          ctx.strokeStyle = 'rgba(90,90,90,0.5)'; ctx.lineWidth = 0.5; ctx.stroke();
        }
      }
      ctx.restore();
    }

    _ticks(ctx, cx, cy, faceR, startA, totalA, numMaj, minVal, maxVal, redlinePct, small) {
      const steps = numMaj * 5;
      for (let i = 0; i <= steps; i++) {
        const a = startA + (i / steps) * totalA;
        const isMaj = i % 5 === 0;
        const isRed = i / steps >= redlinePct;
        const outer = faceR - (small ? 3 : 4);
        const inner = faceR - (isMaj ? (small ? 16 : 22) : (small ? 10 : 13));
        line(ctx, cx + Math.cos(a) * outer, cy + Math.sin(a) * outer,
          cx + Math.cos(a) * inner, cy + Math.sin(a) * inner,
          isRed ? '#ff2525' : isMaj ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.26)',
          isMaj ? (small ? 1.2 : 1.8) : (small ? 0.7 : 1));
        if (isMaj && !small) {
          const tv = Math.round(minVal + (i / steps) * (maxVal - minVal));
          text(ctx, tv, cx + Math.cos(a) * (faceR - 36), cy + Math.sin(a) * (faceR - 36),
            isRed ? '#ff4444' : 'rgba(255,255,255,0.72)', `600 13px 'Rajdhani', sans-serif`);
        }
      }
    }

    _needle(ctx, cx, cy, angle, len, w = 2) {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle);
      ctx.beginPath(); ctx.moveTo(-22, w); ctx.lineTo(len, 0); ctx.lineTo(-22, -w); ctx.closePath();
      ctx.fillStyle = '#ff1a1a'; ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.moveTo(-22, w * 2.5); ctx.lineTo(-40, 0); ctx.lineTo(-22, -w * 2.5); ctx.closePath();
      ctx.fillStyle = '#aa0000'; ctx.fill();
      ctx.restore();
    }

    _vbar(ctx, x, cy, h, val, lo, hi, color, label) {
      const pct = clamp01((val - lo) / (hi - lo));
      const bw = 7, by = cy - h / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.roundRect(x - bw / 2, by, bw, h, 2); ctx.fill();
      const fh = h * pct;
      if (fh > 1) {
        ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.roundRect(x - bw / 2, by + h - fh, bw, fh, 2); ctx.fill(); ctx.shadowBlur = 0;
      }
      for (let i = 0; i <= 4; i++) {
        const ty = by + (i / 4) * h;
        line(ctx, x + bw / 2 + 1, ty, x + bw / 2 + 5, ty, 'rgba(255,255,255,0.2)', 0.8);
      }
      if (label) {
        ctx.save(); ctx.translate(x - bw / 2 - 6, cy); ctx.rotate(-Math.PI / 2);
        text(ctx, label, 0, 0, 'rgba(255,255,255,0.22)', `500 8px 'Rajdhani', sans-serif`);
        ctx.restore();
      }
    }

    _mainTach(ctx, cx, cy, cpuLoad, cpuTemp) {
      const R = 182, faceR = 162;
      const startA = Math.PI * 0.64, endA = Math.PI * 2.36, span = endA - startA;
      const pct = clamp01(cpuLoad / 100);
      const valA = startA + pct * span;
      const redPct = 0.72, redA = startA + redPct * span;

      const chrome = ctx.createLinearGradient(cx - R - 8, cy - R - 8, cx + R + 8, cy + R + 8);
      chrome.addColorStop(0, '#4a4a4a'); chrome.addColorStop(0.35, '#aaa');
      chrome.addColorStop(0.65, '#e0e0e0'); chrome.addColorStop(1, '#333');
      disc(ctx, cx, cy, R + 7, chrome);

      arc(ctx, cx, cy, R, startA, endA, 'rgba(0,130,160,0.25)', 14, 'butt');
      if (pct > 0.01) {
        ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 22;
        arc(ctx, cx, cy, R, startA, valA, '#00c8e8', 14, 'butt'); ctx.shadowBlur = 0;
      }
      ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 12;
      arc(ctx, cx, cy, R, redA, endA, 'rgba(255,30,30,0.65)', 14, 'butt'); ctx.shadowBlur = 0;

      const glowDot = (a, color) => {
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 5, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
      };
      glowDot(startA, '#00c8e8'); glowDot(endA, '#ff2020');

      this._hex(ctx, cx, cy, faceR - 1, 11);
      const fGrad = ctx.createRadialGradient(cx, cy - 30, 0, cx, cy, faceR);
      fGrad.addColorStop(0, 'rgba(35,35,45,0.45)'); fGrad.addColorStop(1, 'rgba(0,0,0,0.72)');
      disc(ctx, cx, cy, faceR - 1, fGrad);
      ring(ctx, cx, cy, faceR - 3, 'rgba(0,200,230,0.18)', 1);

      this._ticks(ctx, cx, cy, faceR - 5, startA, span, 10, 0, 10, redPct, false);
      arc(ctx, cx, cy, faceR - 5, redA, endA, 'rgba(255,0,0,0.18)', 18, 'butt');

      text(ctx, 'SYSTEM · MONITOR', cx, cy - 58, 'rgba(255,255,255,0.3)', `600 11px 'Rajdhani', sans-serif`);

      // Big red CPU-load digit (drawn like an RPM x10% readout)
      const intPart = Math.floor(cpuLoad / 10);
      const fracPart = ((cpuLoad / 10) - intPart).toFixed(1).slice(1);
      ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 28;
      text(ctx, String(intPart), cx + 12, cy + 16, '#ff1a1a', `900 90px 'Rajdhani', sans-serif`, 'right', 'alphabetic');
      ctx.shadowBlur = 0;
      text(ctx, fracPart, cx + 16, cy + 8, 'rgba(255,60,60,0.55)', `700 32px 'Rajdhani', sans-serif`, 'left', 'alphabetic');

      // Big white CPU temp
      text(ctx, Math.round(cpuTemp), cx, cy + 72, 'rgba(255,255,255,0.93)', `700 58px 'Rajdhani', sans-serif`);
      text(ctx, '°C   CPU TEMP', cx, cy + 100, 'rgba(255,255,255,0.32)', `500 12px 'Rajdhani', sans-serif`);
      text(ctx, 'CPU LOAD  ×10%', cx, cy + 138, 'rgba(255,255,255,0.2)', `500 10px 'Rajdhani', sans-serif`);

      // Drive-mode labels
      const modes = ['STRADA', 'SPORT', 'CORSA'];
      const modeA = Math.PI * 0.62, modeR = faceR - 24, active = 1;
      modes.forEach((m, idx) => {
        const a = modeA + idx * 0.28;
        const mx = cx + Math.cos(Math.PI + a) * modeR;
        const my = cy + Math.sin(Math.PI + a) * modeR + 8;
        text(ctx, m, mx, my, idx === active ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.22)',
          idx === active ? `700 11px 'Rajdhani', sans-serif` : `500 10px 'Rajdhani', sans-serif`);
        if (idx === active) disc(ctx, mx, my + 8, 2, '#ff1a1a');
      });

      this._needle(ctx, cx, cy, valA, faceR - 28, 2.2);
      const cap = ctx.createRadialGradient(cx - 5, cy - 5, 0, cx, cy, 18);
      cap.addColorStop(0, '#666'); cap.addColorStop(1, '#111');
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8; disc(ctx, cx, cy, 18, cap); ctx.shadowBlur = 0;
      ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 6; disc(ctx, cx, cy, 7, '#ff1a1a'); ctx.shadowBlur = 0;
    }

    _leftCluster(ctx, cx, cy, gpuTemp, gpuLoad) {
      const oR = 108, iR = 66;
      const startA = Math.PI * 0.72, endA = Math.PI * 2.28, span = endA - startA;
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, oR + 10);
      bg.addColorStop(0, 'rgba(50,20,20,0.5)'); bg.addColorStop(1, 'rgba(0,0,0,0)');
      disc(ctx, cx, cy, oR + 10, bg);
      this._hex(ctx, cx, cy, oR, 8);
      const oDep = ctx.createRadialGradient(cx, cy, iR, cx, cy, oR);
      oDep.addColorStop(0, 'rgba(0,0,0,0.3)'); oDep.addColorStop(1, 'rgba(0,0,0,0.6)');
      ctx.beginPath(); ctx.arc(cx, cy, oR, 0, Math.PI * 2); ctx.arc(cx, cy, iR, 0, Math.PI * 2, true);
      ctx.fillStyle = oDep; ctx.fill();
      const oCh = ctx.createLinearGradient(cx - oR, cy - oR, cx + oR, cy + oR);
      oCh.addColorStop(0, '#3a3a3a'); oCh.addColorStop(0.5, '#aaa'); oCh.addColorStop(1, '#222');
      ring(ctx, cx, cy, oR + 3, oCh, 4);

      const tPct = clamp01((gpuTemp - 20) / 80), tA = startA + tPct * span;
      arc(ctx, cx, cy, oR - 6, startA, endA, 'rgba(255,255,255,0.06)', 4, 'round');
      if (tPct > 0.01) {
        const tc = gpuTemp > 83 ? '#ff2020' : '#ff6020';
        ctx.shadowColor = tc; ctx.shadowBlur = 8; arc(ctx, cx, cy, oR - 6, startA, tA, tc, 4, 'round'); ctx.shadowBlur = 0;
      }
      arc(ctx, cx, cy, oR - 6, startA + span * 0.8, endA, 'rgba(255,30,30,0.4)', 6, 'butt');
      this._ticks(ctx, cx, cy, oR - 2, startA, span, 8, 20, 100, 0.8, true);
      [20, 60, 100].forEach((v, i) => {
        const a = startA + (i / 2) * span;
        text(ctx, v, cx + Math.cos(a) * (oR - 24), cy + Math.sin(a) * (oR - 24),
          v === 100 ? '#ff4444' : 'rgba(255,255,255,0.38)', `500 9px 'Rajdhani', sans-serif`);
      });

      this._hex(ctx, cx, cy, iR - 1, 7);
      const iDep = ctx.createRadialGradient(cx, cy - 15, 0, cx, cy, iR);
      iDep.addColorStop(0, 'rgba(25,25,30,0.3)'); iDep.addColorStop(1, 'rgba(0,0,0,0.65)');
      disc(ctx, cx, cy, iR - 1, iDep);
      ring(ctx, cx, cy, iR + 2, 'rgba(100,100,100,0.4)', 2);

      const lPct = clamp01(gpuLoad / 100), lA = startA + lPct * span;
      arc(ctx, cx, cy, iR - 8, startA, endA, 'rgba(255,255,255,0.05)', 3, 'butt');
      if (lPct > 0.01) {
        ctx.shadowColor = '#ff0040'; ctx.shadowBlur = 6; arc(ctx, cx, cy, iR - 8, startA, lA, '#ff205a', 3, 'butt'); ctx.shadowBlur = 0;
      }
      this._ticks(ctx, cx, cy, iR - 2, startA, span, 5, 0, 100, 0.85, true);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(lA);
      ctx.beginPath(); ctx.moveTo(-12, 1.2); ctx.lineTo(iR - 14, 0); ctx.lineTo(-12, -1.2); ctx.closePath();
      ctx.fillStyle = '#ff1a1a'; ctx.shadowColor = '#f00'; ctx.shadowBlur = 5; ctx.fill(); ctx.shadowBlur = 0; ctx.restore();
      const ih = ctx.createRadialGradient(cx - 3, cy - 3, 0, cx, cy, 11);
      ih.addColorStop(0, '#444'); ih.addColorStop(1, '#111');
      disc(ctx, cx, cy, 11, ih); disc(ctx, cx, cy, 4, '#ff1a1a');

      ctx.shadowColor = '#ff4000'; ctx.shadowBlur = 8;
      text(ctx, `${Math.round(gpuTemp)}°C`, cx, cy - 20, 'rgba(255,110,50,0.9)', `700 14px 'Orbitron', monospace`); ctx.shadowBlur = 0;
      text(ctx, 'GPU TEMP', cx, cy - 7, 'rgba(255,255,255,0.35)', `500 9px 'Rajdhani', sans-serif`);
      text(ctx, `${Math.round(gpuLoad)}%`, cx, cy + 10, 'rgba(255,60,100,0.75)', `600 12px 'Orbitron', monospace`);
      text(ctx, 'GPU LOAD', cx, cy + 22, 'rgba(255,255,255,0.25)', `500 8px 'Rajdhani', sans-serif`);
    }

    _rightCluster(ctx, cx, cy, ram, fan) {
      const R = 108;
      const startA = Math.PI * 0.72, endA = Math.PI * 2.28, span = endA - startA;
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R + 10);
      bg.addColorStop(0, 'rgba(20,20,50,0.5)'); bg.addColorStop(1, 'rgba(0,0,0,0)');
      disc(ctx, cx, cy, R + 10, bg);
      this._hex(ctx, cx, cy, R, 8);
      const fDep = ctx.createRadialGradient(cx, cy - 20, 0, cx, cy, R);
      fDep.addColorStop(0, 'rgba(20,20,35,0.35)'); fDep.addColorStop(1, 'rgba(0,0,0,0.65)');
      disc(ctx, cx, cy, R, fDep);
      const oCh = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      oCh.addColorStop(0, '#3a3a3a'); oCh.addColorStop(0.5, '#aaa'); oCh.addColorStop(1, '#222');
      ring(ctx, cx, cy, R + 3, oCh, 4);

      const pct = clamp01(ram / 100), valA = startA + pct * span, redA = startA + span * 0.85;
      arc(ctx, cx, cy, R - 8, startA, endA, 'rgba(255,255,255,0.06)', 4, 'round');
      if (pct > 0.01) {
        ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 8; arc(ctx, cx, cy, R - 8, startA, valA, '#00bcd4', 4, 'round'); ctx.shadowBlur = 0;
      }
      arc(ctx, cx, cy, R - 8, redA, endA, 'rgba(255,30,30,0.5)', 6, 'butt');
      this._ticks(ctx, cx, cy, R - 2, startA, span, 10, 0, 100, 0.85, true);
      [0, 50, 100].forEach((v, i) => {
        const a = startA + (i / 2) * span;
        text(ctx, v + '%', cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24),
          v === 100 ? '#ff4444' : 'rgba(255,255,255,0.35)', `500 9px 'Rajdhani', sans-serif`);
      });
      this._needle(ctx, cx, cy, valA, R - 18, 1.8);
      const ih = ctx.createRadialGradient(cx - 3, cy - 3, 0, cx, cy, 12);
      ih.addColorStop(0, '#444'); ih.addColorStop(1, '#111');
      disc(ctx, cx, cy, 12, ih); disc(ctx, cx, cy, 5, '#ff1a1a');

      ctx.fillStyle = 'rgba(0,188,212,0.2)';
      ctx.beginPath(); ctx.roundRect(cx - 28, cy - 28, 56, 20, 4); ctx.fill();
      text(ctx, 'MEMORY', cx, cy - 18, 'rgba(255,255,255,0.35)', `500 9px 'Rajdhani', sans-serif`);
      ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 8;
      text(ctx, `${Math.round(ram)}%`, cx, cy, 'rgba(0,200,230,0.9)', `700 18px 'Orbitron', monospace`); ctx.shadowBlur = 0;
      text(ctx, `FAN  ${Math.round(fan)} RPM`, cx, cy + 16, 'rgba(255,255,255,0.28)', `500 9px 'Rajdhani', sans-serif`);
    }
  }

  // --- tiny shared primitives ----------------------------------------------
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function disc(ctx, cx, cy, r, fill) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); }
  function ring(ctx, cx, cy, r, stroke, lw) { if (r <= 0) return; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  function arc(ctx, cx, cy, r, a0, a1, stroke, lw, cap) { ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.lineCap = cap || 'butt'; ctx.stroke(); }
  function line(ctx, x0, y0, x1, y1, stroke, lw) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.lineCap = 'butt'; ctx.stroke(); }
  function text(ctx, str, x, y, fill, font, align, baseline) {
    ctx.fillStyle = fill; ctx.font = font;
    ctx.textAlign = align || 'center'; ctx.textBaseline = baseline || 'middle';
    ctx.fillText(str, x, y);
  }

  // --- exports (works as ES global or CommonJS) ----------------------------
  const api = { drawSportGauge, drawJdmGauge, SupercarDashboard, prepareCanvas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TempsLcdSkins = api;
})(typeof window !== 'undefined' ? window : globalThis);
