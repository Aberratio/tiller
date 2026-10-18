import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
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

function run(args, dirs, input = '', extra = {}) {
  return spawnSync('bash', [INSTALL, ...args], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      CLAUDE_SKILLS_DIR: dirs.skills,
      CLAUDE_AGENTS_DIR: dirs.agents,
      TILLER_PROFILES_ROOT: dirs.profiles,
      TILLER_PERSONAL_ROOT: dirs.personal,
      ...extra,
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

// A PATH holding only the named tools plus the text tools install.sh and prereqs.sh need: real bash,
// real coreutils, a stub for everything else that logs its argv. Used by the preflight tests only.
const COREUTILS = ['dirname', 'basename', 'readlink', 'realpath', 'ln', 'mkdir', 'rm', 'cat', 'sed', 'grep', 'tr', 'head', 'cut', 'mktemp', 'touch', 'id', 'uname']
function toolPath(tools) {
  const root = mkdtempSync(join(tmpdir(), 'install-path-'))
  const bin = join(root, 'bin')
  const log = join(root, 'log')
  mkdirSync(bin)
  symlinkSync('/bin/bash', join(bin, 'bash'))
  for (const u of COREUTILS) symlinkSync(['/usr/bin', '/bin'].map(d => join(d, u)).find(p => existsSync(p)), join(bin, u))
  for (const t of tools) {
    const body = t === 'node' ? `[ "$1" = --version ] && echo v22.0.0; exit 0` : `echo "${t} $*" >> "${log}"`
    writeFileSync(join(bin, t), `#!/bin/bash\n${body}\n`)
    chmodSync(join(bin, t), 0o755)
  }
  return { bin, log }
}

test('all refuses when a required tool is missing, names it and points at --prereqs, links nothing', () => {
  const dirs = sandbox()
  const path = toolPath(['node', 'git'])   // no jq
  const r = run(['all'], dirs, '', { PATH: path.bin })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /missing +jq/)
  assert.match(r.stderr, /install\.sh --prereqs/)
  assert.ok(!existsSync(join(dirs.skills, 'flow-tdd')), 'nothing may be linked before the prerequisites are there')
})

test('all with every required tool present links as before and prints no preflight noise', () => {
  const dirs = sandbox()
  const path = toolPath(['node', 'git', 'jq', 'gh', 'claude', 'caffeinate'])
  const r = run(['flow-tdd'], dirs, '', { PATH: path.bin })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(lstatSync(join(dirs.skills, 'flow-tdd')).isSymbolicLink())
  assert.doesNotMatch(r.stdout + r.stderr, /prereq/)
})

test('TILLER_SKIP_PREREQS=1 skips the preflight', () => {
  const dirs = sandbox()
  const path = toolPath(['node', 'git'])
  const r = run(['flow-tdd'], dirs, '', { PATH: path.bin, TILLER_SKIP_PREREQS: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(lstatSync(join(dirs.skills, 'flow-tdd')).isSymbolicLink())
})

test('--prereqs --yes runs the platform plan and reports what is still missing', () => {
  const dirs = sandbox()
  const path = toolPath(['node', 'git', 'brew', 'claude', 'caffeinate'])   // macOS shape: brew present, jq and gh absent
  const r = run(['--prereqs', '--yes'], dirs, '', { PATH: path.bin })
  assert.equal(r.status, 2, r.stdout + r.stderr)   // the stub installs nothing, so jq is still missing
  assert.equal(readFileSync(path.log, 'utf8').trim(), 'brew install jq gh')
  assert.match(r.stdout, /missing +jq/)
})

test('--hooks prints a PreToolUse fragment that runs the private-access hook and changes no file', () => {
  const dirs = sandbox()
  const r = run(['--hooks'], dirs)
  assert.equal(r.status, 0, r.stderr)
  const frag = JSON.parse(r.stdout)
  const entry = frag.hooks.PreToolUse[0]
  assert.equal(entry.matcher, 'Read|Grep|Glob|Edit|Write|NotebookEdit|Bash')
  assert.match(entry.hooks[0].command, /lib\/hooks\/private-access\.sh/)
  assert.match(entry.hooks[0].command, /^TILLER_HOME=/)
  const probe = spawnSync('sh', ['-c', entry.hooks[0].command], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/srv/x' }, cwd: '/srv' }) })
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(probe.stdout, '')
})
