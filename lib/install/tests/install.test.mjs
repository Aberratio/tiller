import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const INSTALL = join(REPO, 'install.sh')

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'install-'))
  const dirs = {
    skills: join(root, 'skills'),
    agents: join(root, 'agents'),
    profiles: join(root, 'profiles'),
    personal: join(root, 'personal'),
  }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  return dirs
}

function run(args, dirs, input = '') {
  return spawnSync('bash', [INSTALL, ...args], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      CLAUDE_SKILLS_DIR: dirs.skills,
      CLAUDE_AGENTS_DIR: dirs.agents,
      TILLER_PROFILES_ROOT: dirs.profiles,
      TILLER_PERSONAL_ROOT: dirs.personal,
    },
  })
}

function profileWith(dirs, name, { skills = [], agents = [] }) {
  for (const s of skills) {
    mkdirSync(join(dirs.profiles, name, 'skills', s), { recursive: true })
    writeFileSync(join(dirs.profiles, name, 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\n`)
  }
  for (const a of agents) {
    mkdirSync(join(dirs.profiles, name, 'agents'), { recursive: true })
    writeFileSync(join(dirs.profiles, name, 'agents', `${a}.md`), `---\nname: ${a}\n---\n`)
  }
}

test('--profile all links the profile skills and its agents', () => {
  const dirs = sandbox()
  profileWith(dirs, 'acme', { skills: ['acme-qa'], agents: ['acme-qa-web'] })
  const r = run(['--profile', 'acme', 'all'], dirs)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readlinkSync(join(dirs.skills, 'acme-qa')), join(dirs.profiles, 'acme', 'skills', 'acme-qa'))
  assert.equal(readlinkSync(join(dirs.agents, 'acme-qa-web.md')), join(dirs.profiles, 'acme', 'agents', 'acme-qa-web.md'))
  assert.ok(!existsSync(join(dirs.skills, 'flow-tdd')), 'a profile install must not link the shared skills')
})

test('--profile is idempotent and never replaces a foreign file', () => {
  const dirs = sandbox()
  profileWith(dirs, 'acme', { skills: ['acme-qa'], agents: ['acme-qa-web'] })
  writeFileSync(join(dirs.agents, 'acme-qa-web.md'), 'hand-written')
  run(['--profile', 'acme', 'all'], dirs)
  const r = run(['--profile', 'acme', 'all'], dirs)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /ok: +acme-qa/)
  assert.match(r.stderr, /skipped: agent acme-qa-web\.md/)
  assert.ok(!lstatSync(join(dirs.agents, 'acme-qa-web.md')).isSymbolicLink())
})

test('--profile with one named skill links only that skill and no agents', () => {
  const dirs = sandbox()
  profileWith(dirs, 'acme', { skills: ['acme-qa', 'acme-sim'], agents: ['acme-qa-web'] })
  const r = run(['--profile', 'acme', 'acme-sim'], dirs)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(dirs.skills, 'acme-sim')))
  assert.ok(!existsSync(join(dirs.skills, 'acme-qa')))
  assert.ok(!existsSync(join(dirs.agents, 'acme-qa-web.md')))
})

test('--profile without a skills directory fails loudly', () => {
  const dirs = sandbox()
  const r = run(['--profile', 'nope', 'all'], dirs)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no skills in profile 'nope'/)
})

test('--profile cannot be combined with --personal', () => {
  const dirs = sandbox()
  const r = run(['--profile', 'acme', '--personal', 'sam', 'all'], dirs)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /cannot be combined/)
})

test('--setup-personal --answers generates without a terminal and links the result', () => {
  const dirs = sandbox()
  const answers = join(dirs.personal, '..', 'answers.json')
  writeFileSync(answers, JSON.stringify({
    name: 'sam', display_name: 'Sam', channel_name: '#team-daily', channel_id: 'C0', slack_user_id: 'U0',
  }))
  const r = run(['--setup-personal', 'sam', '--answers', answers], dirs)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(dirs.personal, 'sam', 'skills', 'write-daily', 'SKILL.md')))
  assert.ok(lstatSync(join(dirs.skills, 'write-like-sam')).isSymbolicLink())
})

test('--answers without --setup-personal is refused', () => {
  const dirs = sandbox()
  const r = run(['--answers', 'x.json', 'all'], dirs)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /only applies to --setup-personal/)
})
