// guiTOP renderer — subscribes to gpu-data, routes to active tab.

// Force-close any modals that Chromium's session restore may have left open
document.getElementById('manage-hosts-modal').style.display = 'none'

const state = {
  hosts: [],
  selectedHost: null,
  data: {},          // { [hostLabel]: latestPayload }
  procsVisible: {},  // { [hostLabel]: bool }
  skin: localStorage.getItem('guitop-skin') || 'bars',
}

function applySkinClass() {
  document.body.classList.toggle('skin-bars', state.skin === 'bars')
  document.body.classList.toggle('skin-corvette', state.skin === 'corvette')
}
applySkinClass()

// ── Tab switching ───────────────────────────────
const tabBtns = document.querySelectorAll('.tab-btn')
const panels = {
  single: document.getElementById('panel-single'),
  multi: document.getElementById('panel-multi'),
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    Object.values(panels).forEach(p => p.classList.remove('active'))
    panels[btn.dataset.tab].classList.add('active')
    renderActive()
  })
})

function activeTab() {
  const btn = document.querySelector('.tab-btn.active')
  return btn ? btn.dataset.tab : 'single'
}

// ── Skin switching ─────────────────────────────
const skinSelect = document.getElementById('skin-select')
skinSelect.value = state.skin
skinSelect.addEventListener('change', () => {
  state.skin = skinSelect.value
  localStorage.setItem('guitop-skin', state.skin)
  applySkinClass()
  document.getElementById('single-gpus').innerHTML = ''
  document.getElementById('multi-hosts').innerHTML = ''
  multiSig = ''
  renderActive()
})

function skinModule() {
  if (state.skin === 'corvette') return { mod: GpuCardCorvette, cls: '.corvette-card', upd: 'update' }
  if (state.skin === 'bars') return { mod: GpuCardBars, cls: '.bar-card', upd: 'update' }
  return { mod: GpuCard, cls: '.gpu-card', upd: 'drawGauges' }
}

function renderGpuCards(container, gpus, compact) {
  const { mod, cls, upd } = skinModule()
  const existing = container.querySelectorAll(cls)
  if (existing.length === gpus.length) {
    gpus.forEach((g, i) => mod[upd](existing[i], g))
  } else {
    container.innerHTML = gpus.map(g => mod.render(g, compact)).join('')
    const cards = container.querySelectorAll(cls)
    gpus.forEach((g, i) => { if (cards[i]) mod[upd](cards[i], g) })
  }
}

function renderErrorCard(host, msg) {
  return skinModule().mod.renderError(host, msg)
}

// ── Host select (Single tab) ────────────────────
const hostSelect = document.getElementById('host-select')
hostSelect.addEventListener('change', () => {
  state.selectedHost = hostSelect.value
  renderSingle()
})

function updateHostSelect() {
  const prev = hostSelect.value
  hostSelect.innerHTML = state.hosts
    .map(h => `<option value="${h}">${h}</option>`)
    .join('')
  if (prev && state.hosts.includes(prev)) {
    hostSelect.value = prev
  }
  state.selectedHost = hostSelect.value
}

// ── Rendering ───────────────────────────────────
function renderSingle() {
  const container = document.getElementById('single-gpus')
  const procsDiv = document.getElementById('single-procs')
  const toggle = document.getElementById('single-proc-toggle')
  const payload = state.data[state.selectedHost]

  if (!payload) {
    container.innerHTML = '<div class="dim-note">Waiting for data...</div>'
    toggle.style.display = 'none'
    procsDiv.style.display = 'none'
    return
  }

  if (!payload.ok) {
    container.innerHTML = renderErrorCard(payload.host, payload.error || 'Unknown error')
    toggle.style.display = 'none'
    procsDiv.style.display = 'none'
    return
  }

  renderGpuCards(container, payload.gpus, false)

  // Process toggle
  toggle.style.display = ''
  const show = state.procsVisible[state.selectedHost] || false
  toggle.textContent = show ? 'Hide Processes' : 'Show Processes'
  procsDiv.style.display = show ? '' : 'none'
  if (show) {
    procsDiv.innerHTML = ProcessTable.render(payload.processes)
  }
}

// Structural signature of the Multi tab — rebuild DOM only when it changes,
// so per-tick updates go through the CSP-safe update() path and keep animations.
let multiSig = ''

function renderMulti() {
  const container = document.getElementById('multi-hosts')

  const sig = state.hosts.map(label => {
    const p = state.data[label]
    if (!p) return label + ':wait'
    if (!p.ok) return label + ':err:' + (p.error || '')
    return label + ':ok:' + p.gpus.length
  }).join('|') + '|' + state.skin

  if (sig !== multiSig) {
    multiSig = sig
    let html = ''
    for (const label of state.hosts) {
      const payload = state.data[label]
      html += `<div class="host-header">${escapeHtml(label)}</div>`
      if (!payload) {
        html += '<div class="dim-note">Waiting...</div>'
      } else if (!payload.ok) {
        html += `<div class="host-error">${escapeHtml(payload.error || 'Unknown error')}</div>`
      } else {
        html += `<div class="gpu-grid" data-host-grid="${escapeHtml(label)}"></div>`
      }
    }
    container.innerHTML = html
  }

  for (const label of state.hosts) {
    const payload = state.data[label]
    if (!payload || !payload.ok) continue
    const grid = container.querySelector(`.gpu-grid[data-host-grid="${CSS.escape(label)}"]`)
    if (!grid) continue
    renderGpuCards(grid, payload.gpus, true)
  }
}

function renderActive() {
  if (activeTab() === 'single') renderSingle()
  else renderMulti()
}

// ── Process toggle ──────────────────────────────
document.getElementById('single-proc-toggle').addEventListener('click', () => {
  const host = state.selectedHost
  state.procsVisible[host] = !state.procsVisible[host]
  renderSingle()
})

// ── Data subscription ───────────────────────────
const statusText = document.getElementById('status-text')
let lastTs = 0

window.guiTOP.onData((payload) => {
  state.data[payload.host] = payload
  lastTs = payload.ts

  const d = new Date(payload.ts)
  statusText.textContent = `Last update: ${d.toLocaleTimeString()}`

  renderActive()
})

window.guiTOP.onHostList((hosts) => {
  state.hosts = hosts
  updateHostSelect()
  renderActive()
})

// Fetch host list on load (in case the event was missed)
window.guiTOP.getHosts().then((hosts) => {
  if (hosts && hosts.length && state.hosts.length === 0) {
    state.hosts = hosts
    updateHostSelect()
  }
})

// ── Manage Hosts modal (includes Add Host form) ─────────
const manageModal = document.getElementById('manage-hosts-modal')
const mhList = document.getElementById('mh-list')
const mhAddForm = document.getElementById('mh-add-form')
const mhAddToggle = document.getElementById('mh-add-toggle')
const ahError = document.getElementById('ah-error')
const ahFingerprint = document.getElementById('ah-fingerprint')
const ahFpHash = document.getElementById('ah-fp-hash')
const ahSubmit = document.getElementById('ah-submit')
let pendingFingerprint = null

function escapeHtml(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

function resetAddForm() {
  ahError.style.display = 'none'
  ahFingerprint.style.display = 'none'
  pendingFingerprint = null
  ahSubmit.textContent = 'Add'
  ahSubmit.disabled = false
  document.getElementById('ah-host').value = ''
  document.getElementById('ah-user').value = ''
  document.getElementById('ah-pass').value = ''
  document.getElementById('ah-port').value = '22'
  document.getElementById('ah-label').value = ''
}

function isAuthError(error) {
  if (!error) return false
  const s = error.toLowerCase()
  return s.includes('no ssh agent or password') ||
    s.includes('authentication fail') ||
    s.includes('auth fail') ||
    s.includes('all configured authentication')
}

function renderHostList() {
  if (state.hosts.length === 0) {
    mhList.innerHTML = '<div class="dim-note">No hosts configured</div>'
    return
  }
  mhList.innerHTML = state.hosts.map(label => {
    const payload = state.data[label]
    const hasError = payload && !payload.ok
    const needsAuth = hasError && isAuthError(payload.error)
    const statusClass = hasError ? 'mh-status-error' : (payload ? 'mh-status-ok' : 'mh-status-wait')
    const statusText = hasError ? (needsAuth ? 'Needs password' : 'Error') : (payload ? 'Connected' : 'Waiting...')
    return `<div class="mh-row">
      <div class="mh-info">
        <span class="mh-label">${escapeHtml(label)}</span>
        <span class="${statusClass}">${statusText}</span>
        ${hasError && !needsAuth ? `<div class="mh-error-detail">${escapeHtml(payload.error || '')}</div>` : ''}
      </div>
      <div class="mh-actions">
        <button class="mh-btn mh-reconnect" data-label="${escapeHtml(label)}">Reconnect</button>
        <button class="mh-btn mh-remove" data-label="${escapeHtml(label)}">Remove</button>
      </div>
    </div>`
  }).join('')

  // Auto-expand password form for hosts that lost their session password
  for (const label of state.hosts) {
    const payload = state.data[label]
    if (payload && !payload.ok && isAuthError(payload.error)) {
      const btn = mhList.querySelector(`.mh-reconnect[data-label="${CSS.escape(label)}"]`)
      if (btn) btn.click()
    }
  }
}

document.getElementById('manage-hosts-btn').addEventListener('click', () => {
  renderHostList()
  mhAddForm.style.display = 'none'
  mhAddToggle.textContent = '+ Add Host'
  resetAddForm()
  manageModal.style.display = ''
})

document.getElementById('mh-close').addEventListener('click', () => {
  manageModal.style.display = 'none'
})

manageModal.addEventListener('click', (e) => {
  if (e.target === manageModal) manageModal.style.display = 'none'
})

mhAddToggle.addEventListener('click', () => {
  const showing = mhAddForm.style.display !== 'none'
  mhAddForm.style.display = showing ? 'none' : ''
  mhAddToggle.textContent = showing ? '+ Add Host' : 'Cancel'
  if (!showing) {
    resetAddForm()
    document.getElementById('ah-host').focus()
  }
})

mhList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.mh-btn')
  if (!btn) return
  const label = btn.dataset.label

  if (btn.classList.contains('mh-remove')) {
    await window.guiTOP.removeHost(label)
    delete state.data[label]
    renderHostList()
    return
  }

  if (btn.classList.contains('mh-reconnect')) {
    const row = btn.closest('.mh-row')
    const existing = row.querySelector('.mh-pass-form')
    if (existing) { existing.remove(); return }

    const form = document.createElement('div')
    form.className = 'mh-pass-form'
    form.innerHTML = `<input type="password" class="modal-input mh-pass-input" placeholder="Enter password" />
      <button class="modal-btn submit mh-pass-go">Connect</button>`
    row.appendChild(form)

    const input = form.querySelector('.mh-pass-input')
    input.focus()

    const submit = async () => {
      const pw = input.value
      if (!pw) return
      const result = await window.guiTOP.editHost(label, { password: pw })
      if (result.ok) {
        form.remove()
        renderHostList()
      }
    }

    form.querySelector('.mh-pass-go').addEventListener('click', submit)
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit() })
  }
})

ahSubmit.addEventListener('click', async () => {
  const host = document.getElementById('ah-host').value.trim()
  const username = document.getElementById('ah-user').value.trim()
  const password = document.getElementById('ah-pass').value
  const port = parseInt(document.getElementById('ah-port').value, 10) || 22
  const label = document.getElementById('ah-label').value.trim() || host

  ahError.style.display = 'none'

  if (!host) {
    ahError.textContent = 'Hostname / IP is required'
    ahError.style.display = ''
    return
  }
  if (!username) {
    ahError.textContent = 'Username is required for remote hosts'
    ahError.style.display = ''
    return
  }
  if (!password) {
    ahError.textContent = 'Password is required'
    ahError.style.display = ''
    return
  }

  ahSubmit.textContent = 'Connecting...'
  ahSubmit.disabled = true

  const config = { label, host, username, port, password }
  if (pendingFingerprint) {
    config.acceptFingerprint = true
    config._fingerprint = pendingFingerprint
  }

  const result = await window.guiTOP.addHost(config)

  ahSubmit.disabled = false

  if (result.needsAccept) {
    pendingFingerprint = result.fingerprint
    ahFpHash.textContent = result.fingerprint
    ahFingerprint.style.display = ''
    ahSubmit.textContent = 'Accept & Add'
    return
  }

  if (!result.ok) {
    ahError.textContent = result.error
    ahError.style.display = ''
    ahSubmit.textContent = pendingFingerprint ? 'Accept & Add' : 'Add'
    return
  }

  // Success — collapse form, refresh host list
  mhAddForm.style.display = 'none'
  mhAddToggle.textContent = '+ Add Host'
  resetAddForm()
  renderHostList()
})
