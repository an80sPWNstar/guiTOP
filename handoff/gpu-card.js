// GPU card widget — SVG ring gauge skin.
// API: GpuCard.render(gpu) → HTML string
//      GpuCard.renderError(label, msg) → HTML string
//      GpuCard.drawGauges(cardEl, gpu) → live update

const GpuCard = (() => {

  function utilColor(u) {
    if (u == null) return 'rgba(255,255,255,0.3)';
    if (u < 50)   return '#43E734';
    if (u < 85)   return '#4C9AFF';
    return '#FFC857';
  }

  function tempColor(t) {
    if (t == null) return 'rgba(255,255,255,0.3)';
    if (t < 45)   return '#43E734';
    if (t < 65)   return '#FFC857';
    return '#FF4757';
  }

  function esc(str) {
    const el = document.createElement('span');
    el.textContent = String(str ?? '');
    return el.innerHTML;
  }

  const R = 46;
  const CIRC = 2 * Math.PI * R;

  function ring(pct, color, value, label) {
    const clampedPct = Math.max(0, Math.min(1, pct));
    const dash = `${(clampedPct * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`;
    return `
      <svg width="116" height="116" style="overflow:visible;flex-shrink:0">
        <circle cx="58" cy="58" r="${R}" fill="none"
          stroke="rgba(255,255,255,0.07)" stroke-width="9"/>
        <circle cx="58" cy="58" r="${R}" fill="none"
          stroke="${esc(color)}" stroke-width="9"
          stroke-dasharray="${dash}" stroke-linecap="round"
          transform="rotate(-90 58 58)"
          style="filter:drop-shadow(0 0 8px ${esc(color)}bb)"/>
        <text x="58" y="52" text-anchor="middle" dominant-baseline="central"
          fill="${esc(color)}"
          style="font-family:'Orbitron',monospace;font-size:17px;font-weight:700"
        >${esc(value)}</text>
        <text x="58" y="69" text-anchor="middle" dominant-baseline="central"
          fill="rgba(255,255,255,0.5)"
          style="font-family:'Rajdhani',sans-serif;font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase"
        >${esc(label)}</text>
      </svg>`;
  }

  function rings(gpu) {
    const uc = utilColor(gpu.utilization);
    const tc = tempColor(gpu.temperature);
    const util   = gpu.utilization ?? 0;
    const temp   = gpu.temperature ?? 0;
    const vramPct  = gpu.memoryTotal  ? gpu.memoryUsed / gpu.memoryTotal         : 0;
    const powerPct = gpu.powerLimit   ? (gpu.powerDraw ?? 0) / gpu.powerLimit    : 0;

    const vramColor  = vramPct  > 0.9  ? '#FF4757' : vramPct  > 0.7 ? '#FFC857' : '#F5A623';
    const powerColor = powerPct > 0.85 ? '#FF4757' : '#FF9500';

    const utilVal  = gpu.utilization  != null ? `${util}%`                              : '—';
    const tempVal  = gpu.temperature  != null ? `${temp}°`                              : '—';
    const vramVal  = gpu.memoryUsed   != null ? `${(gpu.memoryUsed / 1024).toFixed(1)}G` : '—';
    const powerVal = gpu.powerDraw    != null ? `${Math.round(gpu.powerDraw)}W`         : '—';

    return (
      ring(util / 100,        uc,         utilVal,  'UTIL') +
      ring(temp / 100,        tc,         tempVal,  'TEMP') +
      ring(vramPct,           vramColor,  vramVal,  'VRAM') +
      ring(powerPct,          powerColor, powerVal, 'PWR')
    );
  }

  function render(gpu) {
    const uc       = utilColor(gpu.utilization);
    const clockVal = gpu.clockSm != null ? `${gpu.clockSm} MHz` : '—';

    return `
      <div class="gpu-card" style="border-top:none;padding:22px 28px">
        <div class="card-accent" style="height:2px;background:${uc};box-shadow:0 0 16px ${uc};border-radius:1px;margin-bottom:18px"></div>
        <div class="gpu-header">
          <span class="gpu-index-badge">${gpu.index}</span>
          <span class="gpu-name">${esc(gpu.name || 'Unknown GPU')}</span>
          <span style="font-size:10px;color:rgba(255,255,255,0.35);margin-left:auto;flex-shrink:0;font-family:'Rajdhani',sans-serif">${esc(gpu.host || '')}</span>
        </div>
        <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(67,231,52,0.7) 20%,rgba(255,255,255,0.9) 50%,rgba(67,231,52,0.7) 80%,transparent);margin:14px 0 22px"></div>
        <div class="ring-gauges" style="display:flex;justify-content:space-between;align-items:center">
          ${rings(gpu)}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:18px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05)">
          <span style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.3);letter-spacing:1px;text-transform:uppercase;font-family:'Rajdhani',sans-serif">SM CLOCK</span>
          <span class="clock-val" style="font-family:'Orbitron',monospace;font-size:12px;font-weight:600;color:#7EC8E3">${esc(clockVal)}</span>
        </div>
      </div>`;
  }

  function renderError(hostLabel, errorMsg) {
    return `
      <div class="gpu-card gpu-card-error" style="border-top:none;padding:22px 28px">
        <div class="gpu-header">
          <span class="gpu-name">${esc(hostLabel)}</span>
        </div>
        <div class="error-body">
          <div class="error-icon">!</div>
          <div class="error-msg">${esc(errorMsg)}</div>
        </div>
      </div>`;
  }

  // Live update — patches only the ring area + accent + clock
  function drawGauges(cardEl, gpu) {
    const ringsEl = cardEl.querySelector('.ring-gauges');
    if (ringsEl) {
      ringsEl.innerHTML = rings(gpu);
    }
    const accent = cardEl.querySelector('.card-accent');
    if (accent) {
      const uc = utilColor(gpu.utilization);
      accent.style.background = uc;
      accent.style.boxShadow  = `0 0 16px ${uc}`;
    }
    const clk = cardEl.querySelector('.clock-val');
    if (clk) clk.textContent = gpu.clockSm != null ? `${gpu.clockSm} MHz` : '—';
  }

  return { render, renderError, drawGauges };
})();
