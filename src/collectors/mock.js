// Synthetic GPU data provider — same shape as real data, for dev without GPUs.

function randomBetween(lo, hi) {
  return Math.round(lo + Math.random() * (hi - lo))
}

function mockGpu(index) {
  return {
    index,
    uuid: `GPU-mock-${index}`,
    name: `Mock GPU ${index}`,
    utilization: randomBetween(0, 100),
    memoryUsed: randomBetween(500, 15000),
    memoryTotal: 16384,
    temperature: randomBetween(30, 85),
    powerDraw: randomBetween(20, 250),
    powerLimit: 250,
    fanSpeed: index === 0 ? null : randomBetween(20, 80), // simulate P100 N/A on first
    clockSm: randomBetween(300, 1500),
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

function fetch(gpuCount = 3) {
  const gpus = []
  const processes = []
  for (let i = 0; i < gpuCount; i++) {
    gpus.push(mockGpu(i))
    if (Math.random() > 0.3) processes.push(mockProcess(i))
  }
  return { gpus, processes }
}

module.exports = { fetch }
