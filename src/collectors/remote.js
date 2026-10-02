// Remote transport dispatcher. Routes execRemote calls based on host transport
// setting, supporting 'stream', 'exec', and 'agent' transports. Lazy requires
// inside functions avoid circular dependencies with vendor.js and host-stats.js.

function transportOf(h) {
  return h.transport || 'stream'
}

function execRemote(hostEntry, cmd, opts) {
  const transport = transportOf(hostEntry)

  if (transport === 'agent') {
    const agentClient = require('./agent-client')
    const commands = require('./remote-commands')
    const entry = commands.byCmd(cmd)
    if (!entry) {
      return Promise.reject(new Error('command not available over the agent: ' + cmd))
    }
    return agentClient.exec(hostEntry, entry)
  }

  if (transport === 'stream') {
    const sshStream = require('./ssh-stream')
    const commands = require('./remote-commands')
    const entry = commands.byCmd(cmd)
    if (entry && entry.stream) {
      return sshStream.exec(hostEntry, entry)
    }
    // Fall through to exec transport for non-streaming commands
  }

  // 'exec' transport or fallback for non-stream commands on stream transport
  const ssh = require('./ssh')
  return ssh.execRemote(hostEntry, cmd, opts)
}

function closeHost(h) {
  const sshStream = require('./ssh-stream')
  const agentClient = require('./agent-client')
  const ssh = require('./ssh')
  sshStream.closeHost(h)
  agentClient.closeHost(h)
  return ssh.closeHost(h)
}

function closeAll() {
  const sshStream = require('./ssh-stream')
  const agentClient = require('./agent-client')
  const ssh = require('./ssh')
  sshStream.closeAll()
  agentClient.closeAll()
  return ssh.closeAll()
}

function stats() {
  const ssh = require('./ssh')
  const sshStream = require('./ssh-stream')
  const agentClient = require('./agent-client')
  return {
    ssh: ssh.stats(),
    stream: sshStream.stats(),
    agent: agentClient.stats(),
  }
}

module.exports = { execRemote, closeHost, closeAll, stats, transportOf }
