import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { credentialPatterns, auditCommand } from '../scan-diff.mjs'
import { check, kinds } from '../../contract/validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scan-diff.mjs')
const temps = []
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' }
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// Credential-shaped values are assembled at run time so this file never carries one for the leak guard.
const GH_TOKEN = 'gh' + 'p_' + 'A1b2C3d4E5'.repeat(4)
const AWS_KEY = 'AK' + 'IA' + 'QWERTYUIOPASDFGH'

// A repo whose base commit holds `baseFiles`, and a head commit that applies `change` on top.
function repo(baseFiles, change) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-diff-'))
  temps.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  const put = files => { for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body) } }
  put({ 'README.txt': 'base\n', ...baseFiles })
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  put(change)
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'head')
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') }
}

function run(argv) {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' })
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 1, `exactly one stdout line: ${r.stdout} ${r.stderr}`)
  const json = JSON.parse(lines[0])
  assert.deepEqual(check('script-result', json, r.status), [], r.stdout)
  assert.ok(Buffer.byteLength(lines[0]) < kinds.caps.execStdoutBytes.default, 'stdout stays under the exec cap')
  return { json, exit: r.status }
}

const scan = (r, extra = []) => run(['--repo', r.dir, '--base', r.base, '--head', r.head, ...extra])

const profile = body => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-diff-profile-'))
  temps.push(dir)
  writeFileSync(join(dir, 'profile.md'), body)
  return join(dir, 'profile.md')
}

test('the credential shapes are the leak guard\'s own, read from lib/leak-guard.sh', () => {
  const pats = credentialPatterns()
  assert.ok(pats.length >= 6, `alternatives: ${pats.map(p => p.label).join(', ')}`)
  assert.ok(pats.some(p => p.re.test(GH_TOKEN)))
  assert.ok(pats.some(p => p.re.test(AWS_KEY)))
  assert.ok(!pats.some(p => p.re.test('just a normal line of code')))
})

test('an added credential is a blocker at its file:line, and the value itself is never echoed', () => {
  const r = repo({ 'src/a.js': 'one\n' }, { 'src/a.js': `one\nconst t = "${GH_TOKEN}"\n`, 'src/b.env': `KEY=${AWS_KEY}\n` })
  const { json, exit } = scan(r)
  assert.equal(exit, 0)
  assert.equal(json.status, 'ok')
  const creds = json.findings.filter(f => f.category === 'credential')
  assert.equal(creds.length, 2, JSON.stringify(json.findings))
  assert.ok(creds.every(f => f.severity === 'blocker' && f.axis === 'security' && f.summary && f.id.startsWith('SEC-CRED-')))
  assert.deepEqual(creds.map(f => f.locations[0]).sort(), ['src/a.js:2', 'src/b.env:1'])
  const line = JSON.stringify(json)
  assert.ok(!line.includes(GH_TOKEN) && !line.includes(AWS_KEY), 'no credential in the output')
})

test('a credential the change removes is not a finding', () => {
  const r = repo({ 'src/a.js': `const t = "${GH_TOKEN}"\n` }, { 'src/a.js': 'const t = process.env.T\n' })
  const { json } = scan(r)
  assert.deepEqual(json.findings, [])
})

test('a manifest or lockfile change is a dependency-change finding per file; other files are not', () => {
  const r = repo({ 'package.json': '{}\n' }, {
    'package.json': '{"dependencies":{"x":"1"}}\n', 'package-lock.json': '{}\n', 'svc/requirements-dev.txt': 'x==1\n',
    'svc/Gemfile.lock': 'x\n', 'go.sum': 'x\n', 'Cargo.lock': 'x\n', 'yarn.lock': 'x\n', 'pnpm-lock.yaml': 'x\n', 'poetry.lock': 'x\n',
    'src/package.json.md': 'not a manifest\n',
  })
  const { json } = scan(r)
  const deps = json.findings.filter(f => f.category === 'dependency-change')
  assert.deepEqual(deps.map(f => f.locations[0]).sort(),
    ['Cargo.lock', 'go.sum', 'package-lock.json', 'package.json', 'pnpm-lock.yaml', 'poetry.lock', 'svc/Gemfile.lock', 'svc/requirements-dev.txt', 'yarn.lock'])
  assert.ok(deps.every(f => f.severity === 'medium'))
  assert.equal(json.findings.length, deps.length)
})

test('a declared audit command that exits non-zero is a high finding; one that exits zero adds nothing', () => {
  const r = repo({}, { 'src/a.js': 'x\n' })
  const red = scan(r, ['--profile', profile('# p\n\n## security\n\n- Audit command: `echo 2 vulnerabilities; exit 3`\n\n## next\n')])
  const audit = red.json.findings.find(f => f.id === 'SEC-AUDIT')
  assert.ok(audit, JSON.stringify(red.json))
  assert.equal(audit.severity, 'high')
  assert.match(audit.summary, /exit 3/)
  assert.match(audit.summary, /2 vulnerabilities/)
  const green = scan(r, ['--profile', profile('## security\n\n- Audit command: `true`\n')])
  assert.deepEqual(green.json.findings, [])
  assert.equal(green.json.audit.exitCode, 0)
})

test('no security section, or `none`, runs no audit', () => {
  const r = repo({}, { 'src/a.js': 'x\n' })
  assert.equal(auditCommand('# p\n\n## tracker\n\nnone\n').command, null)
  assert.equal(auditCommand('## security\n\nnone - nothing to audit\n').command, null)
  const { json } = scan(r, ['--profile', profile('## tracker\n\nnone\n')])
  assert.equal(json.audit, null)
})

test('an audit command written as prose or TODO, or one that cannot run, fails closed as a held high finding', () => {
  const r = repo({}, { 'src/a.js': 'x\n' })
  for (const body of ['## security\n\n- Audit command: run the audit by hand\n', '## security\n\n- Audit command: `TODO`\n', '## security\n\n- Audit command: `no-such-binary-xyz`\n']) {
    const { json } = scan(r, ['--profile', profile(body)])
    const f = json.findings.find(x => x.id === 'SEC-AUDIT')
    assert.ok(f, body)
    assert.equal(f.severity, 'high')
    assert.equal(f.source, 'toolchain', body)
  }
})

test('a scan that cannot read the diff is an error carrying a high finding, never a pass', () => {
  const r = repo({}, { 'src/a.js': 'x\n' })
  const { json, exit } = run(['--repo', r.dir, '--base', 'no-such-ref', '--head', r.head])
  assert.equal(exit, 1)
  assert.equal(json.status, 'error')
  assert.equal(json.kind, 'script-error')
  assert.equal(json.findings[0].severity, 'high')
  assert.equal(json.findings[0].source, 'harness')
})

test('missing arguments are an error with a high finding too', () => {
  const { json, exit } = run(['--repo', '/nonexistent'])
  assert.equal(exit, 1)
  assert.equal(json.findings[0].severity, 'high')
})

test('an unreadable profile fails closed', () => {
  const r = repo({}, { 'src/a.js': 'x\n' })
  const { json, exit } = scan(r, ['--profile', '/nonexistent/profile.md'])
  assert.equal(exit, 1)
  assert.equal(json.findings[0].severity, 'high')
})

test('more findings than fit one stdout line go to an artifact; the severest stay on stdout', () => {
  const many = {}
  for (let i = 0; i < 60; i++) many[`deps/m${i}/package.json`] = '{}\n'
  many['src/key.txt'] = `${GH_TOKEN}\n`
  const r = repo({}, many)
  const { json } = scan(r)
  assert.ok(json.artifact, 'artifact path')
  assert.equal(json.total, 61)
  assert.equal(json.findings[0].severity, 'blocker')
  assert.equal(JSON.parse(readFileSync(json.artifact, 'utf8')).length, 61)
})
