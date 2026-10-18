// bin/tiller: the one entry point. Dispatch only; the commands it reaches have their own suites.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const TILLER = join(REPO, 'bin', 'tiller')
const tmp = () => mkdtempSync(join(process.env.TMPDIR || '/tmp', 'tiller-'))

const run = (args, bin = TILLER, opts = {}) => spawnSync('bash', [bin, ...args], { encoding: 'utf8', cwd: opts.cwd || tmp(), env: { ...process.env, ...opts.env } })

test('help lists every command, one line each, and exits 0', () => {
  const r = run(['help'])
  assert.equal(r.status, 0, r.stderr)
  for (const c of ['setup', 'doctor', 'install', 'login', 'personal new', 'personal clone', 'project new', 'project clone', 'project ask', 'hooks', 'help']) {
    assert.match(r.stdout, new RegExp(`^  tiller ${c}\\b`, 'm'), `help names \`tiller ${c}\``)
  }
})

test('no command prints the help on stderr and exits 2', () => {
  const r = run([])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /tiller setup/)
})

test('an unknown command is named and exits 2', () => {
  const r = run(['frobnicate'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown command 'frobnicate'/)
})

test('doctor runs bin/doctor with the arguments passed through', () => {
  const r = run(['doctor', '--json'])
  assert.ok(r.status === 0 || r.status === 1, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.ok(Array.isArray(report.checks) && report.checks.some(c => c.name === 'node'))
})

test('install passes every argument to install.sh unchanged', () => {
  const r = run(['install', '--hooks'])
  assert.equal(r.status, 0, r.stderr)
  const frag = JSON.parse(r.stdout)
  // install.sh quotes the path with printf %q, so a space reads back escaped.
  assert.ok(frag.hooks.PreToolUse[0].hooks[0].command.includes(`${REPO.replaceAll(' ', '\\ ')}/lib/hooks/private-access.sh`))
})

test('invoked through a symlink on PATH, it finds its own checkout', () => {
  const dir = tmp()
  symlinkSync(TILLER, join(dir, 'tiller'))
  const r = run(['install', '--hooks'], join(dir, 'tiller'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /lib\/hooks\/private-access\.sh/)
  assert.ok(!r.stdout.includes(dir), 'the hook path is the checkout, not the symlink directory')
})
