// Process table widget — hidden by default, toggled per-host.

const ProcessTable = (() => {
  function esc(str) {
    const el = document.createElement('span')
    el.textContent = str
    return el.innerHTML
  }

  function fmtTime(secs) {
    if (secs == null) return '—'
    if (secs >= 86400) {
      const days = Math.floor(secs / 86400)
      const remainder = secs % 86400
      const hh = Math.floor(remainder / 3600)
      const mm = Math.floor((remainder % 3600) / 60)
      return `${days}d ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    }
    const hh = Math.floor(secs / 3600)
    const mm = Math.floor((secs % 3600) / 60)
    const ss = secs % 60
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  }

  function render(processes, sortState) {
    if (!processes || processes.length === 0) {
      return '<div class="proc-empty">No compute processes running</div>'
    }

    const arrows = {}
    if (sortState && sortState.col) {
      arrows[sortState.col] = sortState.asc ? ' ▲' : ' ▼'  // ▲ asc, ▼ desc
    }

    function th(label, cls) {
      const arrow = arrows[label] || ''
      const sortCls = arrow ? ' sorted' : ''
      return `<th class="${cls}${sortCls}" data-col="${label}">${label}${arrow}</th>`
    }

    const rows = processes.map(p => {
      const gpu = p.gpuIndex != null ? p.gpuIndex : '—'
      const pid = p.pid != null ? p.pid : '—'
      const user = p.user != null ? esc(p.user) : '—'
      const cpu = p.cpuPercent != null ? p.cpuPercent.toFixed(1) : '—'
      const mem = p.memPercent != null ? p.memPercent.toFixed(1) : '—'
      const time = fmtTime(p.elapsedSecs)
      const name = p.processName != null ? esc(p.processName) : '—'
      const vram = p.usedMemory != null ? p.usedMemory + ' MB' : '—'

      return `
      <tr>
        <td><span class="proc-gpu-badge">${gpu}</span></td>
        <td class="proc-pid num">${pid}</td>
        <td class="proc-user">${user}</td>
        <td class="proc-cpu num">${cpu}</td>
        <td class="proc-memp num">${mem}</td>
        <td class="proc-time num">${time}</td>
        <td class="proc-name" title="${esc(p.processName || '')}">${name}</td>
        <td class="proc-mem num">${vram}</td>
      </tr>`
    }).join('')

    return `
      <table class="proc-table">
        <thead><tr>
          ${th('GPU', '')}${th('PID', 'num')}${th('USER', '')}${th('CPU%', 'num')}${th('MEM%', 'num')}${th('TIME', 'num')}${th('PROCESS', '')}${th('VRAM', 'num')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }

  return { render }
})()
