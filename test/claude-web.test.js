// Where the claude.ai session key ends up. This is the security-relevant path:
// the key is a full account credential, and when the OS has no keyring there is
// nowhere safe to put it, so the user is asked and may refuse.
//
// claude-web.js is main-process code, so `electron` is stubbed in the module
// cache before it loads. Only the four APIs it actually touches are faked.

const fs = require('fs')
const os = require('os')
const path = require('path')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'guitop-cw-'))

const stub = {
  encryptionAvailable: true,
  dialogResponse: 0,   // 0 = Keep in memory only, 1 = Save unencrypted
  dialogCalls: 0,
}

require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'),
  filename: require.resolve('electron'),
  loaded: true,
  exports: {
    app: { getPath: () => userData, userAgentFallback: 'Mozilla/5.0 Chrome/131.0.0.0' },
    BrowserWindow: function () {},
    session: { defaultSession: { cookies: { get: async () => [] } } },
    dialog: {
      showMessageBox: async () => {
        stub.dialogCalls++
        return { response: stub.dialogResponse }
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => stub.encryptionAvailable,
      // Reversible stand-in for DPAPI/keyring — enough to prove the key never
      // reaches the file in readable form.
      encryptString: (s) => Buffer.from('enc:' + s),
      decryptString: (b) => String(b).replace(/^enc:/, ''),
    },
  },
}

const cw = require('../src/collectors/claude-web.js')

let pass = 0, fail = 0
function eq(label, got, want) {
  if (got === want) pass++
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const storeFile = path.join(userData, 'claude-web.json')
const KEY = 'sk-ant-sid01-SECRET-VALUE'

function readRaw() {
  try { return fs.readFileSync(storeFile, 'utf8') } catch { return '' }
}

function reset() {
  try { fs.unlinkSync(storeFile) } catch { /* already gone */ }
  stub.dialogCalls = 0
}

async function main() {
  console.log('with a working keyring:')
  reset()
  stub.encryptionAvailable = true
  let r = await cw.saveSessionKey(KEY)
  eq('persisted', r.persisted, true)
  eq('encrypted', r.encrypted, true)
  eq('no consent dialog shown', stub.dialogCalls, 0)
  eq('raw file does not contain the key', readRaw().includes(KEY), false)
  eq('key reads back', cw.getSessionKey(), KEY)
  eq('status reports encrypted storage', cw.status().keyStorage, 'encrypted')

  if (process.platform !== 'win32') {
    eq('store is 0600', (fs.statSync(storeFile).mode & 0o777).toString(8), '600')
  } else {
    // Windows has no POSIX mode bits; the ACL inherited from userData applies.
    pass++
  }

  console.log('no keyring, user declines:')
  reset()
  stub.encryptionAvailable = false
  r = await cw.saveSessionKey(KEY)
  eq('asked once', stub.dialogCalls, 1)
  eq('not persisted', r.persisted, false)
  eq('nothing readable on disk', readRaw().includes(KEY), false)
  eq('still usable this run', cw.getSessionKey(), KEY)
  eq('status says memory-only', cw.status().keyStorage, 'memory')

  console.log('no keyring, user accepts:')
  reset()
  stub.dialogResponse = 1
  r = await cw.saveSessionKey(KEY)
  eq('asked once', stub.dialogCalls, 1)
  eq('persisted', r.persisted, true)
  eq('flagged unencrypted', r.encrypted, false)
  eq('key is on disk in the clear, as agreed', readRaw().includes(KEY), true)
  eq('status says plaintext', cw.status().keyStorage, 'plaintext')

  // Re-login must not re-ask once the user has already agreed.
  stub.dialogCalls = 0
  r = await cw.saveSessionKey(KEY + '2')
  eq('prior consent is remembered', stub.dialogCalls, 0)
  eq('new key persisted', r.persisted, true)
  eq('new key readable back', cw.getSessionKey(), KEY + '2')

  console.log('declining after a keyring key exists:')
  reset()
  stub.encryptionAvailable = true
  await cw.saveSessionKey(KEY)
  stub.encryptionAvailable = false
  stub.dialogResponse = 0
  r = await cw.saveSessionKey(KEY + '3')
  eq('asked, since the old key was encrypted not plaintext', stub.dialogCalls, 1)
  eq('declined', r.persisted, false)
  // The stale encrypted key must not survive a refused save, or the next launch
  // would silently log in as the previous session.
  eq('stale encrypted key is cleared', readRaw().includes('sessionKeyEnc'), false)

  console.log('logout:')
  reset()
  stub.encryptionAvailable = true
  await cw.saveSessionKey(KEY)
  await cw.logout()
  eq('store file gone', fs.existsSync(storeFile), false)
  eq('memory copy cleared', cw.getSessionKey(), null)
  eq('status reports no key', cw.status().keyStorage, 'none')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
