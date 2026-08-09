// Host CPU + RAM meters — the pair nvitop shows for the machine itself.
//
// Rendered once per host, beside the host name, never on a GPU card. The markup
// is skin-agnostic; each skin restyles it through the --hm-* custom properties
// in main.css, the same arrangement the Claude strip uses for --cu-*. That is
// why there is one widget here and not three.
//
// render() builds the shell once; update() writes only the numbers and the bar
// widths, so a 1 Hz tick never rebuilds DOM. Widths are set via element.style
// because the CSP forbids inline style attributes.
const HostMeters = (() => {
  function fmtGib(kb) {
    const gib = kb / 1024 / 1024
    return (gib >= 100 ? gib.toFixed(0) : gib.toFixed(1))
  }

  // A skeleton, not a reading: the values land on the first update().
  function render() {
    return `
      <div class="host-meters" data-role="host-meters">
        <span class="hm-item">
          <span class="hm-lbl">CPU</span>
          <span class="hm-track"><span class="hm-fill hm-fill-cpu" data-fill="cpu"></span></span>
          <span class="hm-val" data-val="cpu">—</span>
        </span>
        <span class="hm-item">
          <span class="hm-lbl">RAM</span>
          <span class="hm-track"><span class="hm-fill hm-fill-mem" data-fill="mem"></span></span>
          <span class="hm-val" data-val="mem">—</span>
        </span>
      </div>`
  }

  // sys may be null (host down, or not Linux over SSH) and cpuPct may be null on
  // its own for one tick after a host starts, since a rate needs two samples.
  // Both cases blank the meter rather than drawing a zero that looks like idle.
  function update(root, sys) {
    if (!root) return
    root.style.display = sys ? '' : 'none'
    if (!sys) return

    const cpuFill = root.querySelector('[data-fill="cpu"]')
    const cpuVal = root.querySelector('[data-val="cpu"]')
    const memFill = root.querySelector('[data-fill="mem"]')
    const memVal = root.querySelector('[data-val="mem"]')

    const cpu = sys.cpuPct
    if (cpuFill) cpuFill.style.width = (cpu == null ? 0 : cpu) + '%'
    if (cpuVal) cpuVal.textContent = cpu == null ? '—' : Math.round(cpu) + '%'

    const mem = sys.memPct
    if (memFill) memFill.style.width = (mem == null ? 0 : mem) + '%'
    if (memVal) {
      memVal.textContent = sys.memTotalKb
        ? `${fmtGib(sys.memUsedKb)}/${fmtGib(sys.memTotalKb)}G`
        : '—'
    }
  }

  return { render, update }
})()
