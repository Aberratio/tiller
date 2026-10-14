import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION, cli, env, git, makeHelmPair, record } from '../../testing/helm.mjs'

const NOW = { TILLER_HELM_NOW: '2026-10-14T12:00:00Z' }
function session(home, helm, machine, cwd, extra = {}) {
  return spawnSync('bash', [SESSION], { encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }), env: env({ TILLER_HOME: home, TILLER_HELM_DIR: helm, TILLER_MACHINE: machine, ...NOW, ...extra }) })
}
function seed({ home, cwd, a }) {
  record(home, a, 'laptop', cwd.acme, ['--kind', 'deadline', '--summary', 'acme late', '--due', '2026-10-10'], NOW)
  record(home, a, 'laptop', cwd.beta, ['--kind', 'deadline', '--summary', 'beta late', '--due', '2026-10-11'], NOW)
}

test('a project session prints only its own project', () => {
  const h = makeHelmPair(); seed(h)
  const r = session(h.home, h.b, 'desktop', h.cwd.acme)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'overdue: acme - acme late (due 2026-10-10)\n')
})

test('a session outside any project prints every project', () => {
  const h = makeHelmPair(); seed(h)
  assert.match(session(h.home, h.b, 'desktop', h.cwd.none).stdout, /acme late[\s\S]*beta late/)
})

test('session learns the main checkout of the project and writes the machine file once per day', () => {
  const h = makeHelmPair()
  git(h.cwd.acme, 'init', '-q')
  session(h.home, h.b, 'desktop', h.cwd.acme)
  // git reports the resolved path; on macOS the temp dir sits behind a /var -> /private/var link.
  assert.ok(readFileSync(join(h.b, 'machines', 'desktop.md'), 'utf8').includes(`\nclone.acme: ${realpathSync(h.cwd.acme)}\n`))
  const before = git(h.b, 'rev-list', '--count', 'HEAD').stdout
  session(h.home, h.b, 'desktop', h.cwd.acme)
  assert.equal(git(h.b, 'rev-list', '--count', 'HEAD').stdout, before)
})

test('a malformed event is skipped with a warning and the rest still renders', () => {
  const h = makeHelmPair(); seed(h)
  writeFileSync(join(h.a, 'events', 'broken.md'), 'no frontmatter here\n')
  git(h.a, 'add', '-A'); git(h.a, 'commit', '-qm', 'broken'); git(h.a, 'push', '-q')
  const r = session(h.home, h.b, 'desktop', h.cwd.none)
  assert.match(r.stderr, /helm: skipped events\/broken\.md: no frontmatter/)
  assert.match(r.stdout, /acme late/)
})

test('session start pushes an event an earlier offline write left local', () => {
  const h = makeHelmPair()
  git(h.b, 'remote', 'set-url', 'origin', join(h.origin, '..', 'unreachable.git'))
  record(h.home, h.b, 'desktop', h.cwd.acme, ['--kind', 'note', '--summary', 'offline'])
  git(h.b, 'remote', 'set-url', 'origin', h.origin)
  const r = session(h.home, h.b, 'desktop', h.cwd.none)
  assert.doesNotMatch(r.stdout, /not pushed/)
  assert.equal(git(h.b, 'rev-list', '--count', '@{u}..HEAD').stdout.trim(), '0')
})

test('without a helm the hook prints nothing and exits 0', () => {
  const h = makeHelmPair()
  const r = session(h.home, join(h.base, 'nowhere'), 'desktop', h.cwd.none)
  assert.deepEqual([r.status, r.stdout], [0, ''])
})

test('status --json carries state and machines; status without a helm exits 4', () => {
  const h = makeHelmPair(); seed(h)
  const s = JSON.parse(cli(h.home, h.b, 'desktop', ['status', '--json'], NOW).stdout)
  assert.deepEqual(Object.keys(s.state).sort(), ['acme', 'beta'])
  assert.ok(Array.isArray(s.machines))
  assert.equal(cli(h.home, join(h.base, 'nowhere'), 'desktop', ['status']).status, 4)
})

test('calendar-pending needs the calendar capability and lists uncalendared deadlines', () => {
  const h = makeHelmPair(); seed(h)
  assert.equal(cli(h.home, h.b, 'desktop', ['calendar-pending']).status, 5)
  const r = cli(h.home, h.b, 'desktop', ['calendar-pending'], { TILLER_MACHINE_CAPS: 'calendar' })
  assert.equal(r.status, 0, r.stderr)
  const rows = r.stdout.trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(rows.map(x => x.summary).sort(), ['acme late', 'beta late'])
  cli(h.home, h.b, 'desktop', ['record', '--project', 'acme', '--kind', 'note', '--summary', 'in calendar', '--calendar-for', rows.find(x => x.project === 'acme').id])
  const left = cli(h.home, h.b, 'desktop', ['calendar-pending'], { TILLER_MACHINE_CAPS: 'calendar' }).stdout.trim().split('\n')
  assert.equal(left.length, 1)
})

test('a named profile without profile.md, blank .tiller-profile included, prints nothing', () => {
  const h = makeHelmPair(); seed(h)
  for (const name of ['\n', 'ghost\n']) {
    writeFileSync(join(h.cwd.none, '.tiller-profile'), name)
    const r = session(h.home, h.b, 'desktop', h.cwd.none)
    assert.deepEqual([r.status, r.stdout], [0, ''], JSON.stringify(name))
  }
  assert.equal(cli(h.home, h.b, 'desktop', ['session', '--row', ''], NOW).stdout, '')
})

test('offline with six overdue and unpushed commits: header, five reminders, the not-pushed line', () => {
  const h = makeHelmPair()
  git(h.b, 'remote', 'set-url', 'origin', join(h.origin, '..', 'unreachable.git'))
  for (const d of ['01', '02', '03', '04', '05', '06']) record(h.home, h.b, 'desktop', h.cwd.acme, ['--kind', 'deadline', '--summary', d, '--due', `2026-10-${d}`], NOW)
  const lines = session(h.home, h.b, 'desktop', h.cwd.none).stdout.trim().split('\n')
  assert.equal(lines[0], 'helm: offline, showing local state')
  assert.equal(lines.filter(l => l.startsWith('overdue:')).length, 5)
  assert.match(lines.at(-1), /^this machine: \d+ local commit\(s\) not pushed$/)
  assert.equal(lines.length, 7)
})
