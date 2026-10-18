// How the wizard starts a CLI: on Windows an npm-installed CLI is only a .cmd shim, which Node
// cannot spawn without a shell, so the wizard reads a signed-in CLI as a failed sign-in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launch } from '../wizard.mjs'

const PATH = 'C:\\Users\\a\\AppData\\Roaming\\npm;C:\\Users\\a\\.local\\bin'
const on = (...files) => f => files.includes(f)
const win = files => ({ platform: 'win32', path: PATH, exists: on(...files) })

test('launch: a CLI that is only a .cmd shim on Windows runs through the shell', () => {
  const r = launch('claude', ['auth', 'status'], win(['C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd']))
  assert.deepEqual(r, { cmd: 'claude', args: ['auth', 'status'], shell: true })
})

test('launch: a .bat shim counts as a shim', () => {
  assert.equal(launch('codex', ['login'], win(['C:\\Users\\a\\.local\\bin\\codex.bat'])).shell, true)
})

test('launch: a Windows .exe on PATH runs without a shell, even beside a .cmd shim', () => {
  const both = win(['C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\a\\.local\\bin\\claude.exe'])
  assert.equal(launch('claude', ['auth', 'login'], both).shell, false)
  assert.equal(launch('claude', [], win(['C:\\Users\\a\\.local\\bin\\claude.exe'])).shell, false)
})

test('launch: off Windows a .cmd file changes nothing', () => {
  // Any path ending in claude.cmd exists, so only the platform check can keep the shell off.
  const r = launch('claude', ['auth', 'login'], { platform: 'darwin', path: '/opt/npm', exists: f => f.endsWith('claude.cmd') })
  assert.deepEqual(r, { cmd: 'claude', args: ['auth', 'login'], shell: false })
})

test('launch: through the shell, an argument with a space or a quote stays one argument', () => {
  const r = launch('npm', ['install', '-g', 'C:\\My Tools\\pkg', 'say "hi"'], win(['C:\\Users\\a\\AppData\\Roaming\\npm\\npm.cmd']))
  assert.deepEqual(r.args, ['install', '-g', '"C:\\My Tools\\pkg"', '"say ""hi"""'])
})
