// Remote transport dispatcher: routes execRemote to stream, exec, or agent
// based on the host's transport setting. All three present the same call
// signature but take different paths.

const path = require('path')
const fs = require('fs')
const remoteCommands = require('../src/collectors/remote-commands')
const hostConfig = require('../src/config/hosts')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected)
}

function deepEq(label, actual, expected) {
  const match = JSON.stringify(actual) === JSON.stringify(expected)
  if (!match) console.log(`  FAIL ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
  ok(label, match)
}

// ---- tests ------------------------------------------------------------------

async function main() {
  // 1. remote-commands.js exports and structure.
  eq('remote-commands exports TABLE', typeof remoteCommands.TABLE, 'object')
  eq('remote-commands exports byName', typeof remoteCommands.byName, 'function')
  eq('remote-commands exports byCmd', typeof remoteCommands.byCmd, 'function')
  eq('remote-commands exports agentTable', typeof remoteCommands.agentTable, 'function')
  eq('remote-commands exports PS_EO_CMD', typeof remoteCommands.PS_EO_CMD, 'string')
  eq('remote-commands exports HOST_STAT_CMD', typeof remoteCommands.HOST_STAT_CMD, 'string')
  eq('remote-commands exports PROBE_CMD', typeof remoteCommands.PROBE_CMD, 'string')
  eq('remote-commands exports HOSTNAME_CMD', typeof remoteCommands.HOSTNAME_CMD, 'string')

  // 2. TABLE is not empty and frozen.
  ok('TABLE has entries', remoteCommands.TABLE.length > 0)
  ok('TABLE is frozen', Object.isFrozen(remoteCommands.TABLE))

  // 3. All names in TABLE are unique.
  const names = remoteCommands.TABLE.map(e => e.name)
  const uniqueNames = new Set(names)
  eq('table names unique', names.length, uniqueNames.size)

  // 4. byName and byCmd work correctly.
  const gpuEntry = remoteCommands.byName('nv-gpu')
  ok('byName finds nv-gpu', gpuEntry && gpuEntry.cmd === remoteCommands.TABLE.find(e => e.name === 'nv-gpu').cmd)
  const probeEntry = remoteCommands.byName('probe')
  ok('byName finds probe', probeEntry && probeEntry.stream === false)
  eq('byName on missing name', remoteCommands.byName('nonexistent'), null)

  const byCmd = remoteCommands.byCmd(remoteCommands.PROBE_CMD)
  ok('byCmd finds probe', byCmd && byCmd.name === 'probe')
  eq('byCmd on missing cmd', remoteCommands.byCmd('nonexistent'), null)

  // 5. Every TABLE cmd matches the exported constant it comes from.
  const constantMap = {
    'ps': remoteCommands.PS_EO_CMD,
    'host': remoteCommands.HOST_STAT_CMD,
    'probe': remoteCommands.PROBE_CMD,
    'hostname': remoteCommands.HOSTNAME_CMD,
  }
  for (const [name, expectedCmd] of Object.entries(constantMap)) {
    const entry = remoteCommands.byName(name)
    eq(`${name} cmd matches constant`, entry ? entry.cmd : null, expectedCmd)
  }

  // 6. agentTable() returns correct structure: names, intervals.
  const agentTable = remoteCommands.agentTable()
  ok('agentTable is array', Array.isArray(agentTable))
  ok('agentTable entries have name, cmd, interval', agentTable.every(e => e.name && e.cmd && e.interval))

  // Stream commands should have interval 2, one-shot should have 300
  const nvGpuAgent = agentTable.find(e => e.name === 'nv-gpu')
  eq('nv-gpu interval is 2 (stream)', nvGpuAgent ? nvGpuAgent.interval : null, 2)
  const probeAgent = agentTable.find(e => e.name === 'probe')
  eq('probe interval is 300 (one-shot)', probeAgent ? probeAgent.interval : null, 300)

  // 7. agent/commands.json is an ARRAY of {name, cmd, interval}: read the file,
  //    assert it equals agentTable() string exactly, and every TABLE name appears in it.
  const commandsJsonPath = path.join(__dirname, '..', 'agent', 'commands.json')
  const content = fs.readFileSync(commandsJsonPath, 'utf-8')
  const commands = JSON.parse(content)
  ok('commands.json is array', Array.isArray(commands))
  const expected = JSON.stringify(remoteCommands.agentTable(), null, 2) + '\n'
  eq('commands.json matches agentTable exactly', JSON.stringify(commands, null, 2) + '\n', expected)

  // Every TABLE name appears in commands
  const commandNames = new Set(commands.map(e => e.name))
  const tableNames = remoteCommands.TABLE.filter(e => e.name).map(e => e.name)
  for (const name of tableNames) {
    ok(`commands.json contains ${name}`, commandNames.has(name))
  }

  // 8. hosts.js validate() accepts transport and agentPort.
  const testHost1 = {
    label: 'test1',
    host: '10.0.0.1',
    port: 22,
    username: 'user',
    password: 'pass',
    transport: 'stream',
    agentPort: 17581
  }
  let validated1 = null
  try {
    validated1 = hostConfig.validate(testHost1, [])
  } catch (e) {
    ok('hosts.js validate accepts transport and agentPort', false)
  }
  ok('hosts.js validate accepts transport and agentPort', validated1 && validated1.transport === 'stream' && validated1.agentPort === 17581)

  // 9. transport validation: must be one of stream, exec, agent.
  const testHost2 = { ...testHost1, transport: 'invalid' }
  let validationErr = null
  try {
    hostConfig.validate(testHost2, [])
  } catch (e) {
    validationErr = e
  }
  ok('transport validation rejects invalid', validationErr && validationErr.message && validationErr.message.includes('transport'))

  // 10. agentPort validation: must be integer 1-65535.
  const testHost3 = { ...testHost1, agentPort: 'not-a-number' }
  let portErr = null
  try {
    hostConfig.validate(testHost3, [])
  } catch (e) {
    portErr = e
  }
  ok('agentPort validation rejects non-integer', portErr && portErr.message && portErr.message.includes('agentPort'))

  const testHost4 = { ...testHost1, agentPort: 0 }
  let portErr2 = null
  try {
    hostConfig.validate(testHost4, [])
  } catch (e) {
    portErr2 = e
  }
  ok('agentPort validation rejects out-of-range', portErr2 !== null)

  // 12. Non-local host needs username except when transport is 'agent'.
  const testHost6 = { label: 'a', host: '10.0.0.9', transport: 'agent', agentToken: 'x' }
  let validated6 = null
  try {
    validated6 = hostConfig.validate(testHost6, [])
  } catch (e) {
    ok('agent host needs no username', false)
  }
  ok('agent host needs no username', validated6 && validated6.transport === 'agent')

  const testHost7 = { label: 's', host: '10.0.0.9', transport: 'stream' }
  let validationErr7 = null
  try {
    hostConfig.validate(testHost7, [])
  } catch (e) {
    validationErr7 = e
  }
  ok('stream host still needs a username', validationErr7 && validationErr7.message && validationErr7.message.includes('username'))

  const testHost8 = { label: 'b', host: '10.0.0.9', transport: 'agent', username: 'bad user!' }
  let validationErr8 = null
  try {
    hostConfig.validate(testHost8, [])
  } catch (e) {
    validationErr8 = e
  }
  ok('agent host with a bad username is rejected', validationErr8 && validationErr8.message && validationErr8.message.includes('username'))

  // 13. partitionHosts sets bad entries aside instead of throwing.
  const mixed = [
    { label: 'good', host: '10.0.0.1', username: 'u' },
    { label: 'nouser', host: '10.0.0.2', transport: 'stream' },
    { label: 'local', host: '127.0.0.1', local: true },
  ]
  let parts = null
  try { parts = hostConfig.partitionHosts(mixed) } catch (e) { parts = null }
  ok('partitionHosts does not throw on a bad entry', parts !== null)
  eq('partitionHosts keeps the good hosts', parts && parts.hosts.length, 2)
  eq('partitionHosts keeps their order', parts && parts.hosts.map(h => h.label).join(','), 'good,local')
  eq('partitionHosts reports one bad entry', parts && parts.invalid.length, 1)
  eq('bad entry keeps its index', parts && parts.invalid[0].index, 1)
  ok('bad entry keeps its raw object', parts && parts.invalid[0].raw === mixed[1])
  ok('bad entry carries the validate message', parts && /username/.test(parts.invalid[0].error))
  const notArr = hostConfig.partitionHosts({ label: 'x' })
  eq('non-array config loads no hosts', notArr.hosts.length, 0)
  eq('non-array config is reported', notArr.invalid.length, 1)

  // 14. loadSavedHosts keeps an unreadable hosts.json instead of letting a save erase it.
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'guitop-hosts-'))
  const missing = hostConfig.loadSavedHosts(dir)
  ok('missing hosts.json is not an error', missing.entries === null && missing.error === null)
  fs.writeFileSync(path.join(dir, 'hosts.json'), '[{"label":"a","host":"h","username":"u"},]')
  const broken = hostConfig.loadSavedHosts(dir)
  ok('trailing comma loads nothing', broken.entries === null)
  ok('trailing comma is reported', /not valid JSON/.test(broken.error))
  ok('broken file is copied aside', fs.existsSync(path.join(dir, 'hosts.json.bad')))
  eq('copy is byte-identical', fs.readFileSync(path.join(dir, 'hosts.json.bad'), 'utf8'), '[{"label":"a","host":"h","username":"u"},]')
  fs.writeFileSync(path.join(dir, 'hosts.json'), '{"label":"a"}')
  ok('object instead of list is reported', /not a list/.test(hostConfig.loadSavedHosts(dir).error))
  fs.writeFileSync(path.join(dir, 'hosts.json'), '[{"label":"a","host":"h","username":"u"}]')
  const good = hostConfig.loadSavedHosts(dir)
  ok('valid list loads', Array.isArray(good.entries) && good.entries.length === 1 && good.error === null)
  fs.rmSync(dir, { recursive: true, force: true })

  // 11. Keys are only included when present.
  const testHost5 = { label: 'test5', host: '10.0.0.5', port: 22, username: 'user', password: 'pass' }
  const validated5 = hostConfig.validate(testHost5, [])
  ok('transport omitted when not present', !validated5.hasOwnProperty('transport'))
  ok('agentPort omitted when not present', !validated5.hasOwnProperty('agentPort'))

  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

// A test awaiting a promise nothing will settle drains the loop and exits 0, which run.js would count as a pass.
process.on('beforeExit', () => { console.log('  FAIL harness hung: event loop drained before the test finished'); process.exit(1) })
main().catch((err) => { console.log('  FAIL harness crashed:', err && err.stack || err); process.exit(1) })
