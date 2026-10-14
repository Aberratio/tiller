import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECORD, SESSION, cli, env, git, makeHelmPair, originEvents, record } from '../../testing/helm.mjs'

test('init --new pushes the template; init clones it on a second machine', () => {
  const { a, b, origin } = makeHelmPair()
  for (const d of [a, b]) assert.ok(existsSync(join(d, 'helm.md')))
  assert.equal(git(origin, 'log', '--oneline', 'main').status, 0)
})

test('init refuses an existing helm', () => {
  const { home, a, origin } = makeHelmPair()
  const r = cli(home, a, 'laptop', ['init', origin])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /already exists/)
})

test('record.sh stamps the resolved project and pushes', () => {
  const { home, cwd, a, origin } = makeHelmPair()
  const r = record(home, a, 'laptop', cwd.acme, ['--kind', 'milestone', '--summary', 'PR opened', '--source', 'flow-create-pull-request'])
  assert.equal(r.status, 0, r.stderr)
  const id = r.stdout.trim()
  assert.match(id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-laptop-[0-9a-f]{6}$/)
  assert.deepEqual(originEvents(origin), [`events/${id}.md`])
  assert.match(readFileSync(join(a, 'events', `${id}.md`), 'utf8'), /^project: acme$/m)
})

test('record.sh refuses --project inside a project', () => {
  const { home, cwd, a } = makeHelmPair()
  for (const flag of [['--project', 'beta'], ['--project=beta']]) {
    const r = record(home, a, 'laptop', cwd.acme, [...flag, '--kind', 'note', '--summary', 'x'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--project is refused inside project "acme"/)
  }
})

test('outside any project --project is required and accepted', () => {
  const { home, cwd, a } = makeHelmPair()
  assert.equal(record(home, a, 'laptop', cwd.none, ['--kind', 'note', '--summary', 'x']).status, 2)
  assert.equal(record(home, a, 'laptop', cwd.none, ['--project', 'newco', '--kind', 'deadline', '--summary', 'MVP', '--due', '2026-11-30', '--source', 'flow-discovery']).status, 0)
})

test('without a helm, record.sh and record are silent no-ops', () => {
  const { home, cwd, base } = makeHelmPair()
  const missing = join(base, 'nowhere', 'helm')
  const r1 = record(home, missing, 'laptop', cwd.acme, ['--kind', 'note', '--summary', 'x'])
  const r2 = cli(home, missing, 'laptop', ['record', '--project', 'acme', '--kind', 'note', '--summary', 'x'])
  for (const r of [r1, r2]) assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
})

test('an invalid event exits 2 and commits nothing', () => {
  const { home, cwd, a } = makeHelmPair()
  const r = record(home, a, 'laptop', cwd.acme, ['--kind', 'deadline', '--summary', 'x'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /deadline needs due/)
  assert.deepEqual(readdirSync(join(a, 'events')), ['.gitkeep'])
})

test('two machines, one offline: no conflict, every event reaches the remote', () => {
  const { home, cwd, a, b, origin } = makeHelmPair()
  git(b, 'remote', 'set-url', 'origin', join(origin, '..', 'unreachable.git'))
  const off = record(home, b, 'desktop', cwd.acme, ['--kind', 'note', '--summary', 'offline'])
  assert.equal(off.status, 0)
  assert.match(off.stderr, /offline, event kept locally/)
  assert.equal(record(home, a, 'laptop', cwd.beta, ['--kind', 'note', '--summary', 'online']).status, 0)
  git(b, 'remote', 'set-url', 'origin', origin)
  assert.equal(record(home, b, 'desktop', cwd.acme, ['--kind', 'note', '--summary', 'back']).status, 0)
  assert.equal(originEvents(origin).length, 3)
})

test('conflicting helm.md edits: the rebase is aborted, the event stays local, the clone is usable', () => {
  const { home, cwd, a, b } = makeHelmPair()
  writeFileSync(join(a, 'helm.md'), 'edited on a\n')
  git(a, 'commit', '-qam', 'edit a'); git(a, 'pull', '-q', '--rebase'); git(a, 'push', '-q')
  writeFileSync(join(b, 'helm.md'), 'edited on b\n')
  git(b, 'commit', '-qam', 'edit b')
  const r = record(home, b, 'desktop', cwd.acme, ['--kind', 'note', '--summary', 'x'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /offline, event kept locally/)
  assert.ok(!existsSync(join(b, '.git', 'rebase-merge')) && !existsSync(join(b, '.git', 'rebase-apply')))
  assert.equal(git(b, 'status', '--porcelain').stdout, '')
})

test('init <url> --new takes the --new path, not a clone', () => {
  const { home, base } = makeHelmPair()
  const origin = join(base, 'second-origin.git')
  git(base, 'init', '--quiet', '--bare', '-b', 'main', origin)
  const dir = join(base, 'machine-c', 'helm')
  const r = cli(home, dir, 'third', ['init', origin, '--new'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(dir, 'helm.md')))
  assert.equal(git(origin, 'log', '--oneline', 'main').status, 0)
})

function run(cmd, args, opts, input = '') {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { ...opts, stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('close', status => resolve(status))
    p.stdin.end(input)
  })
}

test('parallel writes on one clone: every event reaches the remote, nothing is left untracked', async () => {
  const { home, cwd, a, origin } = makeHelmPair()
  const e = env({ TILLER_HOME: home, TILLER_HELM_DIR: a, TILLER_MACHINE: 'laptop' })
  const records = Array.from({ length: 8 }, (_, i) => run('bash', [RECORD, '--kind', 'note', '--summary', `n${i}`], { cwd: cwd.acme, env: e }))
  const sessions = Array.from({ length: 2 }, () => run('bash', [SESSION], { cwd: cwd.none, env: e }, '{}'))
  const codes = await Promise.all([...records, ...sessions])
  assert.deepEqual(codes, Array(10).fill(0))
  await run('bash', [SESSION], { cwd: cwd.none, env: e }, '{}')
  assert.equal(originEvents(origin).length, 8)
  assert.equal(git(a, 'status', '--porcelain', '--', 'events').stdout, '')
})
