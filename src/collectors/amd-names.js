// Real marketing names for cards the sysfs collector can only describe by ID.
//
// /sys/class/drm/cardN/device/product_name is an Instinct/Pro field. Consumer
// Radeons do not populate it -- it is absent, not empty -- so amd-sysfs.js falls
// through to its uevent fallback and reports "AMD GPU 7550", where 7550 is the
// raw PCI device ID. rocm-smi knows the same card as "AMD Radeon RX 9070 XT".
//
// A device ID cannot be turned into a model by table lookup: 1002:7550 is shared
// by the RX 9070, 9070 XT and 9070 GRE, which is why pci.ids lists all three on
// one line. Only rocm-smi resolves the actual board.
//
// THE JOIN IS ON PCI BUS, NOT INDEX. rocm-smi enumerates its own cards from
// card0, while DRM numbering is sparse -- a lone GPU at /sys/class/drm/card1 is
// card0 to rocm-smi. Joining on the cardN key or on array position would put the
// wrong name on the wrong card, on exactly the sparse-numbering machines
// amd-sysfs.js already carries a comment about. Bus addresses are unambiguous.
//
// Names are static, so this runs once per host and is cached.

const amdSmi = require('./amd-smi')
const { execRemote } = require('./ssh')

const cache = new Map()

// The device-ID fallback amd-sysfs.js emits: "AMD GPU 7550", or bare "AMD GPU".
// Anything else is a name a collector actually resolved -- never overwrite it.
const FALLBACK_NAME = /^AMD GPU(\s|$)/

function normalizeBus(bus) {
  if (!bus) return null
  // rocm-smi prints 0000:2D:00.0, uevent PCI_SLOT_NAME gives 0000:2d:00.0, and
  // amd-sysfs stores that as uuid 'AMD-0000:2d:00.0'. Fold all three together.
  const s = String(bus).trim().toLowerCase().replace(/^amd-/, '')
  return s || null
}

function buildMap(jsonText) {
  const map = new Map()
  for (const card of amdSmi.parseRocmSmi(jsonText)) {
    const bus = normalizeBus(card.pciBus)
    if (!bus) continue
    const name = card.name
    // parseRocmSmi falls back to Card Model (the same hex ID) and then to
    // 'Unknown'. Neither is an improvement on what we already have.
    if (!name || name === 'Unknown' || FALLBACK_NAME.test(name) || /^0x[0-9a-f]+$/i.test(name)) continue
    map.set(bus, name)
  }
  return map
}

async function resolve(hostEntry) {
  try {
    const out = hostEntry && hostEntry.local
      ? await amdSmi.execLocalRocm(amdSmi.rocmNameArgs())
      : await execRemote(hostEntry, amdSmi.ROCM_NAME_CMD)
    return buildMap(out)
  } catch (e) {
    // rocm-smi missing, or present and aborting (this repo has already met a box
    // where it aborts while sysfs is healthy). A card keeping its ID-based name
    // is cosmetic; a throw here would take a working host offline. Never rethrow.
    return new Map()
  }
}

// Cached per host label, empty results included -- a host without rocm-smi must
// not be re-probed every poll. clearCache() is the way back, same as vendor.js.
async function resolveCached(hostEntry) {
  const label = hostEntry && hostEntry.label
  if (!label) return resolve(hostEntry)
  if (cache.has(label)) return cache.get(label)
  const promise = resolve(hostEntry)
  cache.set(label, promise)
  return promise
}

function clearCache(label) {
  if (label === undefined) {
    cache.clear()
  } else if (typeof label === 'string' && label.length > 0) {
    cache.delete(label)
  }
}

function applyNames(gpus, nameMap) {
  if (!Array.isArray(gpus) || !nameMap || nameMap.size === 0) return gpus
  for (const gpu of gpus) {
    if (!gpu || !FALLBACK_NAME.test(gpu.name || '')) continue
    const better = nameMap.get(normalizeBus(gpu.uuid))
    if (better) gpu.name = better
  }
  return gpus
}

// Convenience for the pollers: resolve (cached, never throws) and apply.
async function enrich(hostEntry, result) {
  if (!result || !Array.isArray(result.gpus) || result.gpus.length === 0) return result
  if (!result.gpus.some(g => g && FALLBACK_NAME.test(g.name || ''))) return result
  applyNames(result.gpus, await resolveCached(hostEntry))
  return result
}

module.exports = {
  resolve,
  resolveCached,
  clearCache,
  applyNames,
  buildMap,
  enrich,
  normalizeBus,
  FALLBACK_NAME
}
