// Process table widget — hidden by default, toggled per-host.

const ProcessTable = (() => {
  function esc(str) {
    const el = document.createElement('span')
    el.textContent = str
    return el.innerHTML
  }

  function render(processes) {
    if (!processes || processes.length === 0) {
      return '<div class="proc-empty">No compute processes running</div>'
    }

    const rows = processes.map(p => `
      <tr>
        <td><span class="proc-gpu-badge">${p.gpuIndex != null ? p.gpuIndex : '—'}</span></td>
        <td class="proc-pid">${p.pid != null ? p.pid : '—'}</td>
        <td class="proc-name" title="${esc(p.processName || '')}">${esc(p.processName || '—')}</td>
        <td class="proc-mem">${p.usedMemory != null ? p.usedMemory + ' MB' : '—'}</td>
      </tr>`).join('')

    return `
      <table class="proc-table">
        <thead><tr>
          <th>GPU</th><th>PID</th><th>Process</th><th>VRAM</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }

  return { render }
})()
