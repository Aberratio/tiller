import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probe, which } from '../probe.mjs'
import { homeOf } from '../../../bin/tiller.mjs'

// A fake filesystem: the probe sees only these paths, so any platform can be probed from any host.
const fsWith = paths => p => paths.includes(p)
// Windows paths compare without case, as NTFS does.
const winFsWith = paths => p => paths.some(x => x.toLowerCase() === p.toLowerCase())
const versions = map => (bin, args) => {
  const out = map[bin]
  if (out === undefined) throw new Error(`unexpected run ${bin}`)
  return { status: 0, stdout: out }
}

test('darwin: gtimeout stands in for timeout and a missing jq is null', () => {
  const r = probe({
    platform: 'darwin',
    home: '/Users/u',
    env: { PATH: '/opt/homebrew/bin:/usr/bin' },
    exists: fsWith(['/usr/bin/bash', '/usr/bin/git', '/opt/homebrew/bin/gtimeout', '/opt/homebrew/bin/node']),
    run: versions({ '/usr/bin/bash': 'GNU bash, version 3.2.57', '/usr/bin/git': 'git version 2.39.5',
      '/opt/homebrew/bin/gtimeout': 'timeout (GNU coreutils) 9.5', '/opt/homebrew/bin/node': 'v24.1.0' }),
  })
  assert.equal(r.platform, 'darwin')
  assert.equal(r.tools.jq, null)
  assert.equal(r.tools.timeout.path, '/opt/homebrew/bin/gtimeout')
  assert.equal(r.tools.timeout.version, '9.5')
  assert.deepEqual(r.shell, { path: '/usr/bin/bash', posixPath: '/usr/bin/bash', kind: 'bash' })
  assert.equal(r.tools.node.version, '24.1.0')
})

test('linux: versions are parsed from each tool\'s own --version output', () => {
  const bins = ['bash', 'node', 'git', 'gh', 'jq', 'timeout'].map(b => `/usr/bin/${b}`)
  const r = probe({
    platform: 'linux',
    home: '/home/u',
    env: { PATH: '/usr/bin' },
    exists: fsWith(bins),
    run: versions({ '/usr/bin/bash': 'GNU bash, version 5.2.21(1)-release', '/usr/bin/node': 'v22.11.0',
      '/usr/bin/git': 'git version 2.43.0', '/usr/bin/gh': 'gh version 2.62.0 (2024-11-14)',
      '/usr/bin/jq': 'jq-1.7.1', '/usr/bin/timeout': 'timeout (GNU coreutils) 9.4' }),
  })
  assert.deepEqual(Object.fromEntries(Object.entries(r.tools).map(([k, v]) => [k, v.version])),
    { node: '22.11.0', git: '2.43.0', gh: '2.62.0', jq: '1.7.1', timeout: '9.4' })
})

test('win32: Git Bash and its timeout win over the System32 impostors', () => {
  const sys = 'C:\\Windows\\System32', git = 'C:\\Program Files\\Git\\usr\\bin'
  const r = probe({
    platform: 'win32',
    home: 'C:\\Users\\u',
    env: { PATH: `${sys};${git}`, PATHEXT: '.EXE;.CMD' },
    exists: winFsWith([`${sys}\\bash.exe`, `${sys}\\timeout.exe`, `${git}\\bash.exe`, `${git}\\timeout.exe`]),
    run: () => ({ status: 0, stdout: '1.0' }),
  })
  assert.equal(r.shell.kind, 'git-bash')
  assert.equal(r.shell.path.toLowerCase(), `${git}\\bash.exe`.toLowerCase())
  assert.equal(r.shell.posixPath.toLowerCase(), 'c:/program files/git/usr/bin/bash.exe')
  assert.equal(r.tools.timeout.path.toLowerCase(), `${git}\\timeout.exe`.toLowerCase())
})

test('win32: with only System32 on PATH there is no POSIX shell and no timeout', () => {
  const sys = 'C:\\Windows\\System32'
  const r = probe({
    platform: 'win32',
    home: 'C:\\Users\\u',
    env: { PATH: sys, PATHEXT: '.EXE' },
    exists: winFsWith([`${sys}\\bash.exe`, `${sys}\\timeout.exe`]),
    run: () => ({ status: 0, stdout: '1.0' }),
  })
  assert.equal(r.shell, null)
  assert.equal(r.tools.timeout, null)
})

test('agent config dirs honour CLAUDE_CONFIG_DIR and COPILOT_HOME', () => {
  const r = probe({
    platform: 'linux',
    home: '/home/u',
    env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg/claude', COPILOT_HOME: '/cfg/copilot' },
    exists: fsWith(['/bin/claude', '/cfg/claude']),
    run: () => ({ status: 0, stdout: '2.0.1 (Claude Code)' }),
  })
  assert.deepEqual(r.agents.claude, { bin: '/bin/claude', configDir: '/cfg/claude', configDirExists: true })
  assert.deepEqual(r.agents.copilot, { bin: null, configDir: '/cfg/copilot', configDirExists: false })
})

test('agent config dirs default to the injected home', () => {
  const r = probe({ platform: 'linux', home: '/home/u', env: { PATH: '' }, exists: () => false, run: () => ({ status: 1, stdout: '' }) })
  assert.equal(r.agents.claude.configDir, '/home/u/.claude')
  assert.equal(r.agents.copilot.configDir, '/home/u/.copilot')
})

test('a tool whose --version fails or throws is reported without a version', () => {
  const r = probe({
    platform: 'linux',
    home: '/home/u',
    env: { PATH: '/usr/bin' },
    exists: fsWith(['/usr/bin/jq', '/usr/bin/gh']),
    run: bin => { if (bin.endsWith('jq')) throw new Error('boom'); return { status: 1, stdout: '' } },
  })
  assert.deepEqual(r.tools.jq, { path: '/usr/bin/jq', version: null })
  assert.deepEqual(r.tools.gh, { path: '/usr/bin/gh', version: null })
})

test('which honours PATHEXT on win32 and ignores empty PATH entries elsewhere', () => {
  const exists = fsWith(['C:\\tools\\gh.CMD', '/usr/bin/gh'])
  assert.equal(which('gh', { platform: 'win32', env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' }, exists }), 'C:\\tools\\gh.CMD')
  assert.equal(which('gh', { platform: 'linux', env: { PATH: '::/usr/bin' }, exists }), '/usr/bin/gh')
  assert.equal(which('gh', { platform: 'linux', env: {}, exists }), null)
})

test('win32: Git Bash found under ProgramFiles gets a forward-slash path for hook commands', () => {
  const r = probe({
    platform: 'win32',
    home: 'C:\\Users\\u',
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', ProgramFiles: 'C:\\Program Files' },
    exists: winFsWith(['C:\\Windows\\System32\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']),
    run: () => ({ status: 0, stdout: '1.0' }),
  })
  assert.deepEqual(r.shell, {
    path: 'C:\\Program Files\\Git\\bin\\bash.exe',
    posixPath: 'C:/Program Files/Git/bin/bash.exe',
    kind: 'git-bash',
  })
})

test('homeOf: win32 reads USERPROFILE and ignores the HOME that Git Bash sets', () => {
  assert.equal(homeOf({ HOME: '/c/Users/x', USERPROFILE: 'C:\\Users\\x' }, 'win32'), 'C:\\Users\\x')
})

test('homeOf: darwin and linux keep HOME first', () => {
  assert.equal(homeOf({ HOME: '/Users/x', USERPROFILE: '/elsewhere' }, 'darwin'), '/Users/x')
  assert.equal(homeOf({ USERPROFILE: '/home/y' }, 'linux'), '/home/y')
})
