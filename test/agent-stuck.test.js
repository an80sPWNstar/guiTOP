// Agent stuck path: a command whose kill does not take (a D-state process on a hung driver).
// The agent runs under test/fixtures/agent-unkillable.py, which disarms its kill calls, so a
// command outliving --run-timeout keeps running until it finishes on its own. While it does:
// the agent must answer 'stuck' rather than 'pending' or a stale 'ok', must not start a second
// copy of the command beside the hung one, and must return to 'ok' once the command ends. The
// real client must turn 'stuck' into an error without counting it as a transport failure.

const { execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')
const agentClient = require('../src/collectors/agent-client')

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.log(`  FAIL ${label}`) }
}
function eq(label, actual, expected) {
  ok(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

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

let agentProcess = null
let agentPort = 0
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
const RUN_TIMEOUT_S = 2
const HANG_S = 12

// Every run appends one line to its marker file, so the line count is the number of runs started.
function runsStarted(file) {
  try {
    const content = fs.readFileSync(file, 'utf8')
    return content.split('\n').filter(line => line.trim().length > 0).length
  } catch (e) {
    return 0
  }
}

async function startAgent() {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guitop-stuck-'))
    const shDir = tmpDir.replace(/\\/g, '/')
    const commandsFile = path.join(tmpDir, 'commands.json')
    const tokenFile = path.join(tmpDir, 'token')

    const commands = [
      { name: 'hang-first', cmd: `echo run >> ${shDir}/first.runs; sleep ${HANG_S}`, interval: 30 },
      { name: 'hang-later', cmd: `echo run >> ${shDir}/later.runs; if [ -f ${shDir}/later.flag ]; then sleep ${HANG_S}; fi; touch ${shDir}/later.flag; echo sample`, interval: 1 },
    ]

    fs.writeFileSync(commandsFile, JSON.stringify(commands, null, 2) + '\n')
    fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 })

    const script = path.join(__dirname, 'fixtures', 'agent-unkillable.py')
    const args = [
      script,
      '--bind', '127.0.0.1',
      '--port', '0',
      '--token-file', tokenFile,
      '--commands', commandsFile,
      '--run-timeout', String(RUN_TIMEOUT_S),
    ]

    const env = { ...process.env }
    if (process.platform === 'win32') {
      const gitShell = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'
      if (fs.existsSync(gitShell)) {
        args.push('--shell', gitShell)
        const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH'
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

async function main() {
  try {
    const { port, tmpDir } = await startAgent()
    console.log(`agent started on port ${port}`)
    const firstRuns = path.join(tmpDir, 'first.runs')
    const laterRuns = path.join(tmpDir, 'later.runs')
    try {
      // 1. A first run that never finishes reads as stuck, not as an endless warm-up. The agent waits
      //    up to 3s for a first result, by which time the run is past RUN_TIMEOUT_S.
      let t0
      try {
        t0 = Date.now()
        const r = await agentGet('hang-first', TOKEN)
        eq('hang-first state', r.body.state, 'stuck')
        eq('hang-first code', r.body.code, null)
        ok('hang-first age >= timeout', r.body.ageMs >= RUN_TIMEOUT_S * 1000)
        const r2 = await agentGet('hang-later', TOKEN)
        eq('hang-later state', r2.body.state, 'ok')
        ok('hang-later out includes sample', r2.body.out && r2.body.out.includes('sample'))
        eq('hang-later code', r2.body.code, 0)
      } catch (e) {
        ok('step 1', false)
        console.log(e.message)
      }

      // 2. Repeated polls during the hang: still stuck, the age keeps growing, and no second copy starts.
      try {
        let prev = 0
        for (let i = 0; i < 3; i++) {
          await sleep(500)
          const asked = Date.now()
          const r = await agentGet('hang-first', TOKEN)
          // A known-stuck run must not hold the client's only socket for the 3s first-result wait.
          ok('hang-first: stuck answered at once', Date.now() - asked < 1000)
          eq('hang-first still stuck', r.body.state, 'stuck')
          ok('hang-first age growing', r.body.ageMs > prev)
          prev = r.body.ageMs
        }
        eq('hang-first started once while hung', runsStarted(firstRuns), 1)
      } catch (e) {
        ok('step 2', false)
        console.log(e.message)
      }

      // 3. A later run that hangs reports stuck even though a good result is cached. hang-later's
      //    second run starts about 1s after its first poll, ~4s in; this lands ~3.4s into that hang.
      try {
        await sleep(3000)
        const r = await agentGet('hang-later', TOKEN)
        eq('hang-later stuck', r.body.state, 'stuck')
        ok('hang-later age >= timeout', r.body.ageMs >= RUN_TIMEOUT_S * 1000)
        eq('hang-later: no run beside the hung one', runsStarted(laterRuns), 2)
      } catch (e) {
        ok('step 3', false)
        console.log(e.message)
      }

      // 4. The real client: stuck rejects with a message naming the command, and is not a transport failure.
      try {
        const hostEntry = { host: '127.0.0.1', agentPort: port, agentToken: TOKEN }
        let msg = null
        try {
          await agentClient.exec(hostEntry, { name: 'hang-first' })
        } catch (e) {
          msg = e.message
        }
        ok('client rejects stuck', msg !== null && msg.includes('stuck') && msg.includes('hang-first'))
        const st = agentClient.stats()[`127.0.0.1:${port}`]
        eq('client: stuck is not a transport failure', st.failures, 0)
        eq('client: no backoff after stuck', st.backoffMs, 0)
        agentClient.closeAll()
      } catch (e) {
        ok('step 4', false)
        console.log(e.message)
      }

      // 5. Recovery: once the hung command ends on its own, the run completes as a timeout (code -1).
      try {
        await sleep(Math.max(0, t0 + (HANG_S + 1.5) * 1000 - Date.now()))
        const r = await agentGet('hang-first', TOKEN)
        eq('hang-first recovered state', r.body.state, 'ok')
        eq('hang-first recovered code', r.body.code, -1)
        eq('hang-first: still one run after recovery', runsStarted(firstRuns), 1)
      } catch (e) {
        ok('step 5', false)
        console.log(e.message)
      }
    } finally {
      await stopAgent()
      fs.rmSync(tmpDir, { recursive: true, force: true })
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
