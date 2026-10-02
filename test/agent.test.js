// Python agent: HTTP server on the remote host, one worker thread per command,
// with 30s timeouts, stuck detection, and stream-vs-one-shot intervals.
// Tests spawn a real agent process if Python is available, else skip cleanly.

const { execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected)
}

// ---- Python detection -------------------------------------------------------

let pythonCmd = null
for (const cmd of ['python3', 'python', 'py -3']) {
  try {
    execSync(`${cmd} --version`, { stdio: 'ignore' })
    pythonCmd = cmd
    break
  } catch (e) {
    // Not found
  }
}

if (!pythonCmd) {
  console.log('skipped: no python')
  process.exit(0)
}

// ---- test setup -------------------------------------------------------------

let agentProcess = null
let agentPort = 0
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)

async function startAgent() {
  return new Promise((resolve, reject) => {
    // Create a temp commands.json with test commands (ARRAY of {name, cmd, interval})
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guitop-test-'))
    const commandsFile = path.join(tmpDir, 'commands.json')
    const tokenFile = path.join(tmpDir, 'token')

    const commands = [
      { name: 'echo-test', cmd: 'echo hello', interval: 2 },
      { name: 'exit-3', cmd: 'exit 3', interval: 2 },
      // Longer than --run-timeout 3, short enough that Windows (no process groups) leaves no lasting orphan.
      { name: 'sleep-long', cmd: 'sleep 8', interval: 10 },
    ]

    fs.writeFileSync(commandsFile, JSON.stringify(commands, null, 2) + '\n')
    fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 })

    const agentScript = path.join(__dirname, '..', 'agent', 'guitop-agent.py')
    const args = [
      agentScript,
      '--bind', '127.0.0.1',
      '--port', '0',  // Let OS choose
      '--token-file', tokenFile,
      '--commands', commandsFile,
      '--run-timeout', '3',
    ]

    // On Windows, inject shell path if it exists. Its own directory goes on PATH too,
    // or external commands such as sleep exit 127 while builtins like echo still work.
    const env = { ...process.env }
    if (process.platform === 'win32') {
      const gitShell = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'
      if (fs.existsSync(gitShell)) {
        args.push('--shell', gitShell)
        const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH' // 'Path' on Windows
        env[key] = path.dirname(gitShell) + ';' + (env[key] || '')
      }
    }

    agentProcess = spawn(pythonCmd.split(' ')[0], args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: 30000
    })

    let stdout = '', stderr = ''
    let resolved = false

    agentProcess.stdout.on('data', (buf) => { stdout += buf.toString() })

    // The agent logs "Agent started: <bind>:<bound port> ..." on stderr once it is listening.
    agentProcess.stderr.on('data', (buf) => {
      stderr += buf.toString()
      const match = stderr.match(/Agent started: .*:(\d+) with/)
      if (match && !resolved) {
        resolved = true
        agentPort = parseInt(match[1])
        resolve({ port: agentPort, tmpDir })
      }
    })

    agentProcess.on('error', (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    })

    agentProcess.on('exit', () => {
      if (!resolved) {
        resolved = true
        reject(new Error(`agent exited without starting: ${stderr}`))
      }
    })

    // Timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        agentProcess.kill()
        reject(new Error('agent startup timeout'))
      }
    }, 5000)
  })
}

function stopAgent() {
  if (agentProcess) {
    agentProcess.kill('SIGTERM')
    return new Promise((resolve) => {
      setTimeout(() => {
        if (agentProcess && !agentProcess.killed) {
          agentProcess.kill('SIGKILL')
        }
        resolve()
      }, 1000)
    })
  }
  return Promise.resolve()
}

// ---- HTTP helper -----------

async function agentGet(name, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: agentPort,
      path: name === '_health' ? '/v1/health' : `/v1/run?name=${encodeURIComponent(name)}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }

    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) })
        } catch (e) {
          resolve({ status: res.statusCode, body: data })
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(5000, () => {
      req.destroy()
      reject(new Error('request timeout'))
    })
    req.end()
  })
}

// ---- tests ------------------------------------------------------------------

async function main() {
  try {
    const { port, tmpDir } = await startAgent()
    console.log(`agent started on port ${port}`)
    try {
      // 1. /v1/health
      try {
        const health = await agentGet('_health', TOKEN)
        eq('health status', health.status, 200)
        ok('health has ok field', health.body.ok === true)
        ok('health has version', typeof health.body.version === 'string')
        ok('health has names', Array.isArray(health.body.names))
      } catch (e) {
        ok('health endpoint', false)
        console.log(`  health error: ${e.message}`)
      }

      // 2. Unknown name returns 404
      try {
        const unknown = await agentGet('nonexistent-cmd', TOKEN)
        eq('unknown name status', unknown.status, 404)
      } catch (e) {
        ok('unknown name check', false)
      }

      // 3. Valid command with no token returns 401
      try {
        const noAuth = await agentGet('echo-test', 'wrong-token')
        eq('401 on bad token', noAuth.status, 401)
      } catch (e) {
        ok('auth check', false)
      }

      // 4. Successful run
      try {
        const result = await agentGet('echo-test', TOKEN)
        eq('successful run status', result.status, 200)
        ok('successful run has output', result.body.out && result.body.out.includes('hello'))
        eq('successful run code', result.body.code, 0)
        eq('successful run state', result.body.state, 'ok')
      } catch (e) {
        ok('successful run', false)
        console.log(`  run error: ${e.message}`)
      }

      // 5. Non-zero exit
      try {
        const failed = await agentGet('exit-3', TOKEN)
        eq('exit-3 code', failed.body.code, 3)
        eq('exit-3 state', failed.body.state, 'ok')
      } catch (e) {
        ok('exit check', false)
      }

      // 6. Run timeout: a command outliving --run-timeout (3s) is killed and reports code -1.
      //    'stuck' is only reachable when the kill itself cannot finish (a D-state process),
      //    which a test cannot produce. The first call returns after the agent's 3s first-result
      //    wait; the kill lands at ~3s and the next run is 10s (interval) away, so ~4.5s is clear.
      try {
        const firstCall = await agentGet('sleep-long', TOKEN)
        ok('sleep-long first call', firstCall.status === 200)
        await new Promise(r => setTimeout(r, 1500))
        const killed = await agentGet('sleep-long', TOKEN)
        eq('sleep-long killed at run timeout: state', killed.body.state, 'ok')
        eq('sleep-long killed at run timeout: code', killed.body.code, -1)
      } catch (e) {
        ok('stuck detection', false)
        console.log(`  stuck detection error: ${e.message}`)
      }

      // 7. Agent token enforcement
      const noToken = await agentGet('echo-test', 'invalid')
      eq('token enforcement', noToken.status, 401)
    } finally {
      await stopAgent()
    }
    console.log(`${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  } catch (err) {
    console.log(`  FAIL harness crashed: ${err.message}`)
    process.exit(1)
  }
}

// A test awaiting a promise nothing will settle drains the loop and exits 0, which run.js would count as a pass.
process.on('beforeExit', () => { console.log('  FAIL harness hung: event loop drained before the test finished'); process.exit(1) })
main()
