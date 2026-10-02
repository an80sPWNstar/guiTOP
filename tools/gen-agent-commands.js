// Generate agent/commands.json from the remote-commands table.
// Run once: node tools/gen-agent-commands.js

const fs = require('fs')
const path = require('path')

const remoteCommands = require('../src/collectors/remote-commands')

const commands = remoteCommands.agentTable()
const json = JSON.stringify(commands, null, 2) + '\n'
const target = path.join(__dirname, '..', 'agent', 'commands.json')

fs.writeFileSync(target, json, 'utf8')
console.log(`Generated ${target}`)
