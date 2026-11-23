#!/usr/bin/env node
/** Fake `opencode` CLI: `models` prints ids, `run` reads stdin and prints JSON events. */
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const logFile = process.env.FREEAGENT_OPENCODE_LOG

function record(line) {
  if (logFile) appendFileSync(logFile, `${line}\n`)
}

record(`ARGS ${JSON.stringify(args)}`)

if (args[0] === 'models') {
  process.stdout.write('opencode/gemini-4-neon\nopencode/beam-free\n')
  process.exit(0)
}

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdin += chunk
})
process.stdin.on('end', () => {
  record(`STDIN ${stdin}`)
  const mode = process.env.FREEAGENT_OPENCODE_MODE || 'text'
  if (mode === 'tool') {
    process.stdout.write(`${JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { title: 'list files' } } })}\n`)
  }
  if (mode === 'error') {
    process.stdout.write(`${JSON.stringify({ type: 'error', error: { data: { message: 'Insufficient balance' } } })}\n`)
    process.exit(1)
  }
  if (mode === 'limit') {
    process.stdout.write(`${JSON.stringify({ type: 'error', error: { message: 'Free usage limit reached', status: 429 } })}\n`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify({ type: 'text', part: { text: 'pong' } })}\n`)
  process.exit(0)
})
