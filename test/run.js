// Runs every *.test.js in this directory in its own process. No test framework.
//   npm test
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const dir = __dirname
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort()

let failed = 0
for (const f of files) {
  console.log(`\n=== ${f} ===`)
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' })
  } catch (e) {
    failed++
  }
}

console.log(`\n${files.length - failed}/${files.length} test files passed`)
process.exit(failed ? 1 : 0)
