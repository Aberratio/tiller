#!/usr/bin/env node
// Discovery brains: scaffold one, check its register, report what stands between it and a spec.
//
//   discovery.mjs new <name> [--pet]
//   discovery.mjs check <name> [--spec <dir>]
//   discovery.mjs status <name>
//
// TILLER_BRAINS_DIR replaces <repo>/brains, for tests.
// Exit: 0 done, 1 violations found, 2 usage, 3 refused.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, status } from './register.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRAINS = process.env.TILLER_BRAINS_DIR || join(HERE, '..', '..', 'brains')
const NAME = /^[a-z0-9][a-z0-9-]*$/

function die(code, msg) { console.error(`discovery: ${msg}`); process.exit(code) }
function brainDir(name, mustExist = true) {
  if (!NAME.test(name || '')) die(2, 'brain name: lowercase letters, digits and dashes')
  const dir = join(BRAINS, name)
  if (mustExist && !existsSync(dir)) die(2, `no brain at ${dir}; create it with: discovery.mjs new ${name}`)
  return dir
}

function cmdNew(name, flags) {
  const dir = brainDir(name, false)
  if (existsSync(dir)) die(3, `${dir} already exists; nothing changed`)
  const pet = flags.includes('--pet')
  for (const d of ['meetings', 'spec', ...(pet ? [] : ['recaps'])]) mkdirSync(join(dir, d), { recursive: true })
  for (const f of ['decisions.md', 'questions.md', ...(pet ? [] : ['client.md'])]) copyFileSync(join(HERE, 'templates', f), join(dir, f))
  const git = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  if (git.status !== 0) die(3, `git init failed: ${git.error?.message ?? git.stderr.trim()}`)
  console.log(dir)
}

function cmdCheck(name, flags) {
  const dir = brainDir(name)
  const i = flags.indexOf('--spec')
  let specDir
  if (i >= 0) {
    specDir = flags[i + 1]
    if (!specDir || !existsSync(specDir) || !statSync(specDir).isDirectory()) die(2, `--spec needs an existing directory`)
    specDir = resolve(specDir)
  }
  const out = check(dir, { specDir })
  for (const line of out) console.log(line)
  process.exit(out.length ? 1 : 0)
}

function cmdStatus(name) {
  const s = status(brainDir(name))
  console.log(`awaiting confirmation: ${s.awaiting.join(', ') || '-'}`)
  for (const [area, list] of Object.entries(s.open)) console.log(`open ${area}: ${list.join(', ')}`)
  console.log(s.ready ? 'spec: ready' : `spec: blocked by ${s.blocking.join(', ')}`)
}

const [cmd, name, ...flags] = process.argv.slice(2)
if (cmd === 'new') cmdNew(name, flags)
else if (cmd === 'check') cmdCheck(name, flags)
else if (cmd === 'status') cmdStatus(name)
else die(2, 'usage: discovery.mjs new <name> [--pet] | check <name> [--spec <dir>] | status <name>')
