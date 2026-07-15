function num(s) {
  const trimmed = s.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "[n/a]") {
    return null;
  }
  const n = Number(trimmed);
  return isNaN(n) ? null : n;
}

function parseGpus(csvText) {
  return csvText
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const fields = line.split(",").map((f) => f.trim());
      return {
        index: num(fields[0]),
        uuid: fields[1],
        name: fields[2],
        utilization: num(fields[3]),
        memoryUsed: num(fields[4]),
        memoryTotal: num(fields[5]),
        temperature: num(fields[6]),
        powerDraw: num(fields[7]),
        powerLimit: num(fields[8]),
        fanSpeed: num(fields[9]),
        clockSm: num(fields[10]),
      };
    });
}

function parseProcesses(csvText, uuidToIndex) {
  return csvText
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => line.trim().split(",")[0].trim() !== "gpu_uuid")
    .map((line) => {
      const fields = line.split(",").map((f) => f.trim());
      return {
        gpuUuid: fields[0],
        gpuIndex: fields[0] in uuidToIndex ? uuidToIndex[fields[0]] : null,
        pid: num(fields[1]),
        processName: fields[2],
        usedMemory: num(fields[3]),
      };
    });
}

// Parses `ps -eo pid=,user:32=,pcpu=,pmem=,etimes=` output (Linux hosts).
function parsePs(text) {
  const map = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5) continue;

    const pid = parseInt(parts[0], 10);
    const user = parts[1];
    const cpuRaw = parseFloat(parts[2]);
    const memRaw = parseFloat(parts[3]);
    const elapsedRaw = parseInt(parts[4], 10);

    if (!isNaN(pid)) {
      map[pid] = {
        user,
        cpuPercent: isNaN(cpuRaw) ? null : cpuRaw,
        memPercent: isNaN(memRaw) ? null : memRaw,
        elapsedSecs: isNaN(elapsedRaw) ? null : elapsedRaw,
      };
    }
  }
  return map;
}

module.exports = { parseGpus, parseProcesses, parsePs };
