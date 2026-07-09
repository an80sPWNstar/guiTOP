// GPU card widget — Blocks skin.
// API: GpuCardBars.render(gpu) → HTML string
//      GpuCardBars.renderError(label, msg) → HTML string
//      GpuCardBars.update(cardEl, gpu) → live update

const GpuCardBars = (() => {

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

  function bar(label, pct, color, value) {
    const w = `${Math.min(100, Math.max(0, Math.round(pct * 100)))}%`;
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
        <span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:0.5px;width:36px;flex-shrink:0;font-family:'Rajdhani',sans-serif">${esc(label)}</span>
        <div style="flex:1;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden">
          <div style="height:100%;background:${esc(color)};width:${w};border-radius:2px;box-shadow:0 0 6px ${esc(color)}70"></div>
        </div>
        <span style="font-size:11px;color:rgba(255,255,255,0.65);min-width:112px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0">${esc(value)}</span>
      </div>`;
  }

  function render(gpu) {
    const uc  = utilColor(gpu.utilization);
    const tc  = tempColor(gpu.temperature);
    const util = gpu.utilization ?? 0;
    const temp = gpu.temperature ?? 0;

    const vramPct  = gpu.memoryTotal ? gpu.memoryUsed / gpu.memoryTotal       : 0;
    const powerPct = gpu.powerLimit  ? (gpu.powerDraw ?? 0) / gpu.powerLimit  : 0;
    const clockPct = Math.min(1, (gpu.clockSm ?? 0) / 1400);

    const statusLabel = util >= 85 ? 'HIGH LOAD' : util >= 50 ? 'ACTIVE' : 'IDLE';
    const statusColor = util >= 85 ? '#FF4757'   : util >= 50 ? '#4C9AFF' : '#43E734';
    const statusBg    = util >= 85 ? 'rgba(255,71,87,0.14)' : util >= 50 ? 'rgba(76,154,255,0.12)' : 'rgba(67,231,52,0.12)';

    const tempVal  = gpu.temperature != null ? `${temp}°C`                                            : '—';
    const vramVal  = gpu.memoryUsed  != null ? `${(gpu.memoryUsed/1024).toFixed(1)} / ${Math.round(gpu.memoryTotal/1024)} GB` : '—';
    const powerVal = gpu.powerDraw   != null ? `${Math.round(gpu.powerDraw)} / ${gpu.powerLimit} W`  : '—';
    const clockVal = gpu.clockSm     != null ? `${gpu.clockSm} MHz`                                   : '—';

    return `
      <div class="bar-card" style="box-shadow:inset 3px 0 0 ${uc};padding:22px 24px;border-radius:0;border:none;border-bottom:1px solid rgba(255,255,255,0.04)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:26px;height:26px;border-radius:7px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;font-family:'Orbitron',monospace;font-size:11px;font-weight:700;color:rgba(255,255,255,0.55);flex-shrink:0">${gpu.index}</div>
            <div style="font-family:'Rajdhani',sans-serif;font-size:16px;font-weight:700;color:rgba(255,255,255,0.92)">${esc(gpu.name || 'Unknown GPU')}</div>
          </div>
          <div style="background:${tc}18;color:${tc};border:1px solid ${tc}44;border-radius:10px;padding:10px 20px;font-family:'Orbitron',monospace;font-size:26px;font-weight:700;white-space:nowrap">${esc(tempVal)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
          <span style="font-family:'Orbitron',monospace;font-size:60px;font-weight:700;line-height:1;color:${uc};text-shadow:0 0 40px ${uc}55">${util}%</span>
          <div>
            <div style="background:${statusBg};color:${statusColor};border-radius:4px;padding:3px 8px;font-size:10px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:5px;display:inline-block">${statusLabel}</div>
            <div style="font-size:10px;color:rgba(255,255,255,0.22)">${esc(gpu.host || '')}</div>
          </div>
        </div>
        <div style="height:1px;background:rgba(255,255,255,0.06);margin-bottom:14px"></div>
        ${bar('VRAM',  vramPct,  '#F5A623', vramVal)}
        ${bar('PWR',   powerPct, '#FF9500', powerVal)}
        ${bar('CLK',   clockPct, '#7EC8E3', clockVal)}
      </div>`;
  }

  function renderError(hostLabel, errorMsg) {
    return `
      <div class="bar-card bar-card-error" style="padding:22px 24px">
        <div class="bar-top"><span class="bar-model">${esc(hostLabel)}</span></div>
        <div class="bar-error-msg">${esc(errorMsg)}</div>
      </div>`;
  }

  function update(cardEl, gpu) {
    const tmp = document.createElement('div');
    tmp.innerHTML = render(gpu);
    const newCard = tmp.firstElementChild;
    cardEl.innerHTML      = newCard.innerHTML;
    cardEl.style.cssText  = newCard.style.cssText;
  }

  return { render, renderError, update };
})();
