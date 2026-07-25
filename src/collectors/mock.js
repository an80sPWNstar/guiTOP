// Synthetic GPU data provider — same shape as real data, for dev without GPUs.

function randomBetween(lo, hi) {
  return Math.round(lo + Math.random() * (hi - lo))
}

// AMD cards commonly report fewer fields than NVIDIA (no fan% on many consumer
// boards, no power cap on some), so the AMD mock deliberately leaves gaps — that
// is what the widgets must survive.
const VENDOR_SHAPES = {
  nvidia: (index) => ({
    uuid: `GPU-mock-${index}`,
    name: `Mock GPU ${index}`,
    powerLimit: 250,
    fanSpeed: index === 0 ? null : randomBetween(20, 80), // simulate P100 N/A on first
  }),
  amd: (index) => ({
    uuid: `AMD-0000:0${index + 3}:00.0`,
    name: `Mock Radeon RX ${7900 - index * 100} XTX`,
    powerLimit: index === 0 ? 355 : null,
    fanSpeed: null,
  }),
}

function mockGpu(index, vendor = 'nvidia') {
  const shape = (VENDOR_SHAPES[vendor] || VENDOR_SHAPES.nvidia)(index)
  return {
    index,
    uuid: shape.uuid,
    name: shape.name,
    utilization: randomBetween(0, 100),
    memoryUsed: randomBetween(500, 15000),
    memoryTotal: 16384,
    temperature: randomBetween(30, 85),
    powerDraw: randomBetween(20, 250),
    powerLimit: shape.powerLimit,
    fanSpeed: shape.fanSpeed,
    clockSm: randomBetween(300, 1500),
    vendor,
  }
}

function mockProcess(gpuIndex) {
  return {
    gpuUuid: `GPU-mock-${gpuIndex}`,
    gpuIndex,
    pid: 10000 + gpuIndex,
    processName: `/usr/bin/mock-worker-${gpuIndex}`,
    usedMemory: randomBetween(100, 4000),
  }
}

function fetch(gpuCount = 3, vendor = 'nvidia') {
  const gpus = []
  const processes = []
  for (let i = 0; i < gpuCount; i++) {
    gpus.push(mockGpu(i, vendor))
    if (Math.random() > 0.3) processes.push(mockProcess(i))
  }
  return { gpus, processes }
}

module.exports = { fetch }
