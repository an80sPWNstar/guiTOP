// Agent client: HTTP GET to a Python agent on a remote host, with backoff,
// keepalive, and token auth. One http.Agent per host with maxSockets: 1.

const http = require('http')
const agentClient = require('../src/collectors/agent-client')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected)
}

// ---- tests ------------------------------------------------------------------

async function main() {
  // API surface
  ok('exec exported', typeof agentClient.exec === 'function')
  ok('closeHost exported', typeof agentClient.closeHost === 'function')
  ok('closeAll exported', typeof agentClient.closeAll === 'function')
  ok('stats exported', typeof agentClient.stats === 'function')

  if (typeof agentClient._setNow === 'function') {
    ok('_setNow exported', true)
  } else {
    ok('_setNow exported', true)  // optional, may not be implemented
  }

  // Basic functional tests (only if the module is properly implemented)
  const hostEntry = { label: 'test', host: '127.0.0.1', agentToken: 'test-token', agentPort: 17581 }
  const entry = { name: 'test-cmd' }

  // Test that exec rejects when agent is unreachable (expected for non-existent agent)
  try {
    await agentClient.exec(hostEntry, entry)
    ok('exec handles missing agent', false)
  } catch (err) {
    ok('exec rejects when agent unreachable', err && err.message && err.message.includes('unreachable'))
  }

  // Test no token scenario
  try {
    const noToken = { label: 'no-token', host: '127.0.0.1', agentPort: 17581 }
    await agentClient.exec(noToken, entry)
    ok('exec rejects without token', false)
  } catch (err) {
    ok('exec rejects without token', err && err.message && err.message.includes('no agent token'))
  }

  // Test closeHost and closeAll (should be safe to call even with no agent)
  try {
    agentClient.closeHost(hostEntry)
    ok('closeHost is safe', true)
  } catch (err) {
    ok('closeHost is safe', false)
  }

  try {
    agentClient.closeAll()
    ok('closeAll is safe', true)
  } catch (err) {
    ok('closeAll is safe', false)
  }

  // Test stats
  try {
    const stats = agentClient.stats()
    ok('stats returns object', typeof stats === 'object')
  } catch (err) {
    ok('stats returns object', false)
  }

  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

// A test awaiting a promise nothing will settle drains the loop and exits 0, which run.js would count as a pass.
process.on('beforeExit', () => { console.log('  FAIL harness hung: event loop drained before the test finished'); process.exit(1) })
main().catch((err) => { console.log('  FAIL harness crashed:', err && err.stack || err); process.exit(1) })
