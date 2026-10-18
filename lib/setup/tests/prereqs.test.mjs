import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE = fileURLToPath(new URL('../../..', import.meta.url))
const PREREQS = join(CORE, 'lib', 'setup', 'prereqs.sh')

// Text tools the script itself needs; none of them is a checked requirement.
const COREUTILS = ['dirname', 'basename', 'grep', 'sed', 'sort', 'head', 'tr', 'cut', 'mktemp', 'rm', 'mkdir', 'ln', 'cat', 'id', 'printf', 'touch', 'readlink']

function which(name) {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) if (existsSync(join(dir, name))) return join(dir, name)
  throw new Error(`no ${name} on this machine`)
}

// A PATH holding only the named tools. `uname` reports the given kernel; `node` the given version;
// every other tool is a stub that appends its argv to the log and exits 0.
function sandbox({ kernel = 'Darwin', tools = [], nodeVersion = 'v22.0.0' } = {}) {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'prereqs-')))
  const bin = join(root, 'bin')
  const log = join(root, 'log')
  mkdirSync(bin)
  symlinkSync('/bin/bash', join(bin, 'bash'))
  for (const u of COREUTILS) symlinkSync(which(u), join(bin, u))
  stub(bin, 'uname', `echo ${kernel}`)
  for (const t of tools) {
    if (t === 'node') stub(bin, 'node', `[ "$1" = --version ] && echo ${nodeVersion}; exit 0`)
    else if (t === 'sudo') stub(bin, 'sudo', `echo "sudo $*" >> "${log}"; exec "$@"`)
    else stub(bin, t, `echo "${t} $*" >> "${log}"`)
  }
  return { root, bin, log }
}

function stub(bin, name, body) {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}

function run(sb, args, extra = {}) {
  return spawnSync('/bin/bash', [PREREQS, ...args], { encoding: 'utf8', env: { PATH: sb.bin, HOME: sb.root, TMPDIR: sb.root, ...extra } })
}

const logOf = sb => (existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim().split('\n') : [])

const EVERYTHING = ['node', 'git', 'jq', 'gh', 'claude', 'brew', 'caffeinate']

test('os: Darwin, Linux and the MSYS kernels map to macos, linux and windows', () => {
  assert.equal(run(sandbox({ kernel: 'Darwin' }), ['os']).stdout.trim(), 'macos')
  assert.equal(run(sandbox({ kernel: 'Linux' }), ['os']).stdout.trim(), 'linux')
  assert.equal(run(sandbox({ kernel: 'MINGW64_NT-10.0-22631' }), ['os']).stdout.trim(), 'windows')
  assert.equal(run(sandbox({ kernel: 'MSYS_NT-10.0' }), ['os']).stdout.trim(), 'windows')
  assert.equal(run(sandbox({ kernel: 'FreeBSD' }), ['os']).stdout.trim(), 'unknown')
})

test('check: every requirement present is exit 0 with one ok line per tool and no plan', () => {
  const sb = sandbox({ tools: EVERYTHING })
  const r = run(sb, ['check'])
  assert.equal(r.status, 0, r.stderr)
  for (const t of ['node', 'git', 'bash', 'jq', 'gh', 'claude', 'keep-awake']) assert.match(r.stdout, new RegExp(`^ok +${t} `, 'm'), r.stdout)
  assert.equal(run(sb, ['plan']).stdout.trim(), '')
})

test('check: a missing required tool is exit 2 and names it; a missing optional one only warns', () => {
  const sb = sandbox({ tools: ['node', 'git', 'brew', 'claude'] })
  const r = run(sb, ['check'])
  assert.equal(r.status, 2)
  assert.match(r.stdout, /^missing +jq /m)
  assert.match(r.stdout, /^warn +gh /m)
  assert.match(r.stdout, /^warn +keep-awake /m)
  assert.doesNotMatch(r.stdout, /^missing +gh /m)
})

test('check: a node older than the floor counts as missing', () => {
  const sb = sandbox({ tools: EVERYTHING, nodeVersion: 'v18.20.0' })
  const r = run(sb, ['check'])
  assert.equal(r.status, 2)
  assert.match(r.stdout, /^missing +node +v18\.20\.0 .*20\.11/m)
})

test('plan on macOS with brew: one brew line for the packages, the curl installer for claude', () => {
  const sb = sandbox({ kernel: 'Darwin', tools: ['node', 'brew'] })
  const r = run(sb, ['plan'])
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  assert.deepEqual(lines, [
    'brew install git jq gh',
    'curl -fsSL https://claude.ai/install.sh | bash',
  ])
})

test('plan on macOS without brew: exit 3, a manual line per package, only the claude installer runs', () => {
  const sb = sandbox({ kernel: 'Darwin', tools: ['node', 'git'] })
  const r = run(sb, ['plan'])
  assert.equal(r.status, 3)
  assert.equal(r.stdout.trim(), 'curl -fsSL https://claude.ai/install.sh | bash')
  assert.match(r.stderr, /manual: +jq /)
  assert.match(r.stderr, /manual: +gh /)
  assert.match(r.stderr, /brew\.sh/)
})

test('plan on Linux with apt as a non-root user: sudo in front, NodeSource for node', () => {
  const sb = sandbox({ kernel: 'Linux', tools: ['git', 'apt-get', 'sudo', 'systemd-inhibit'] })
  const r = run(sb, ['plan'])
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  assert.deepEqual(lines, [
    'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -',
    'sudo apt-get install -y nodejs jq gh',
    'curl -fsSL https://claude.ai/install.sh | bash',
  ])
})

test('plan on Linux with dnf, apk and pacman uses each manager once', () => {
  for (const [mgr, expect] of [
    ['dnf', 'sudo dnf install -y nodejs jq gh'],
    ['apk', 'sudo apk add nodejs npm jq github-cli'],
    ['pacman', 'sudo pacman -S --noconfirm --needed nodejs npm jq github-cli'],
  ]) {
    const sb = sandbox({ kernel: 'Linux', tools: ['git', 'claude', mgr, 'sudo'] })
    const r = run(sb, ['plan'])
    assert.equal(r.status, 0, `${mgr}: ${r.stderr}`)
    assert.equal(r.stdout.trim(), expect, mgr)
  }
})

test('plan on Windows (Git Bash) with winget: one winget line per package id, PowerShell for claude', () => {
  const sb = sandbox({ kernel: 'MINGW64_NT-10.0-22631', tools: ['git', 'winget'] })
  const r = run(sb, ['plan'])
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  assert.deepEqual(lines, [
    'winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements',
    'winget install --id jqlang.jq -e --source winget --accept-package-agreements --accept-source-agreements',
    'winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements',
    'powershell.exe -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"',
  ])
})

test('plan on Windows without winget: exit 3 and manual lines naming the download pages', () => {
  const sb = sandbox({ kernel: 'MINGW64_NT-10.0-22631', tools: ['git', 'node', 'claude'] })
  const r = run(sb, ['plan'])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /manual: +jq /)
  assert.match(r.stderr, /winget/)
})

test('install runs the plan in order through the real managers and reports the leftover', () => {
  const sb = sandbox({ kernel: 'Linux', tools: ['git', 'node', 'claude', 'apt-get', 'sudo', 'curl'] })
  const r = run(sb, ['install', '--yes'])
  // The stubs install nothing, so the check after the plan still misses jq: that is the leftover.
  assert.equal(r.status, 2, r.stderr)
  assert.deepEqual(logOf(sb), ['sudo apt-get install -y jq gh', 'apt-get install -y jq gh'])
  assert.match(r.stdout, /^missing +jq /m)
})

test('install without --yes and without a terminal refuses before running anything', () => {
  const sb = sandbox({ kernel: 'Darwin', tools: ['node', 'brew'] })
  const r = run(sb, ['install'])
  assert.equal(r.status, 4)
  assert.deepEqual(logOf(sb), [])
  assert.match(r.stderr, /--yes/)
})

test('install with nothing missing runs nothing and is exit 0', () => {
  const sb = sandbox({ tools: EVERYTHING })
  const r = run(sb, ['install', '--yes'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(logOf(sb), [])
})

test('an unknown kernel: check still reports, plan is exit 3 with manual lines', () => {
  const sb = sandbox({ kernel: 'FreeBSD', tools: ['node', 'git'] })
  assert.equal(run(sb, ['check']).status, 2)
  const r = run(sb, ['plan'])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /manual: +jq /)
})
