#!/usr/bin/env node
// tiller: bring a machine to a working harness. See docs/superpowers/specs/2026-10-13-harness-onboarding-design.md.
//
//   tiller doctor [--json]
//
// Exit: 0 done, 2 usage, 3 refused, 4 failed.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { probe } from '../lib/machine/probe.mjs'
import { capabilities } from '../lib/machine/capabilities.mjs'

const USAGE = 'usage: tiller doctor [--json]'
const LATER = new Set(['onboard', 'status', 'uninstall'])

function context(overrides = {}) {
  const env = overrides.env ?? process.env
  return {
    env,
    platform: process.platform,
    home: env.HOME || env.USERPROFILE || homedir(),
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
    ...overrides,
  }
}

function doctor(argv, ctx) {
  const p = probe({ platform: ctx.platform, env: ctx.env, home: ctx.home })
  const features = capabilities(p)
  if (argv.includes('--json')) {
    ctx.stdout(JSON.stringify({ probe: p, features }, null, 2) + '\n')
    return 0
  }
  for (const f of features) {
    let line = `${f.status.padEnd(12)}${f.label}`
    if (f.reason) line += ` - ${f.reason}`
    if (f.install.length) line += `; install: ${f.install.join(' && ')}`
    ctx.stdout(line + '\n')
  }
  return 0
}

export function main(argv, overrides) {
  const ctx = context(overrides)
  const [cmd, ...rest] = argv
  if (cmd === 'doctor') return doctor(rest, ctx)
  if (LATER.has(cmd)) {
    ctx.stderr(`tiller ${cmd}: not available yet\n`)
    return 2
  }
  ctx.stderr(USAGE + '\n')
  return 2
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
