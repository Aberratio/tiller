import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, cleanEnv } from '../testing/private-access.mjs'

const HOOK = fileURLToPath(new URL('../hooks/private-access.sh', import.meta.url))

function call(home, cwd, tool_name, tool_input, raw) {
  const input = raw ?? JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd })
  const r = spawnSync('bash', [HOOK], { encoding: 'utf8', input, env: cleanEnv({ TILLER_HOME: home }) })
  assert.equal(r.status, 0, r.stderr)
  if (!r.stdout.trim()) return { decision: 'allow' }
  const out = JSON.parse(r.stdout).hookSpecificOutput
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason }
}
const denied = (r, msg) => { assert.equal(r.decision, 'deny'); if (msg) assert.match(r.reason, msg) }
const allowed = r => assert.equal(r.decision, 'allow', r.reason)

test('none brain: Read, Grep and Glob are denied with the matrix cell named', () => {
  const { home, cwd } = makeHome()
  const note = join(home, 'brains', 'main', 'note.md')
  denied(call(home, cwd.beta, 'Read', { file_path: note }),
    /^private-access: brain "main" is "none" for profile "beta" \(brains\/access\.json\)$/)
  denied(call(home, cwd.beta, 'Grep', { pattern: 'x', path: join(home, 'brains', 'main') }))
  denied(call(home, cwd.beta, 'Glob', { pattern: 'brains/main/**/*.md', path: home }))
  denied(call(home, cwd.beta, 'Glob', { pattern: '**/*.md', path: join(home, 'brains', 'main') }))
})

test('read brain: Read allowed, Edit, Write and NotebookEdit denied', () => {
  const { home, cwd } = makeHome()
  const note = join(home, 'brains', 'main', 'note.md')
  allowed(call(home, cwd.acme, 'Read', { file_path: note }))
  denied(call(home, cwd.acme, 'Edit', { file_path: note, old_string: 'a', new_string: 'b' }), /"main" is "read" for profile "acme"/)
  denied(call(home, cwd.acme, 'Write', { file_path: note, content: 'x' }))
  denied(call(home, cwd.acme, 'NotebookEdit', { notebook_path: join(home, 'brains', 'main', 'n.ipynb'), new_source: '' }))
})

test('write brain: every tool is allowed', () => {
  const { home, cwd } = makeHome()
  const note = join(home, 'brains', 'acme-notes', 'note.md')
  allowed(call(home, cwd.acme, 'Read', { file_path: note }))
  allowed(call(home, cwd.acme, 'Edit', { file_path: note, old_string: 'a', new_string: 'b' }))
  allowed(call(home, cwd.acme, 'Write', { file_path: join(home, 'brains', 'acme-notes', 'new', 'x.md'), content: 'x' }))
  allowed(call(home, cwd.acme, 'Grep', { pattern: 'x', path: join(home, 'brains', 'acme-notes') }))
})

test("another project's profile is denied; own profile and _template are allowed", () => {
  const { home, cwd } = makeHome()
  denied(call(home, cwd.acme, 'Read', { file_path: join(home, 'profiles', 'beta', 'profile.md') }), /profiles\/beta is not the resolved profile "acme"/)
  allowed(call(home, cwd.acme, 'Read', { file_path: join(home, 'profiles', 'acme', 'profile.md') }))
  allowed(call(home, cwd.acme, 'Read', { file_path: join(home, 'profiles', '_template', 'profile.md') }))
})

test('a symlink outside TILLER_HOME pointing into a denied brain is judged by its target', () => {
  const { base, home, cwd } = makeHome()
  symlinkSync(join(home, 'brains', 'main'), join(base, 'shortcut'))
  denied(call(home, cwd.beta, 'Read', { file_path: join(base, 'shortcut', 'note.md') }))
})

test('_none row: its grants apply when cwd resolves no profile, and every real profile is denied', () => {
  const { home, cwd } = makeHome()
  allowed(call(home, cwd.none, 'Write', { file_path: join(home, 'brains', 'main', 'x.md'), content: 'x' }))
  denied(call(home, cwd.none, 'Read', { file_path: join(home, 'brains', 'acme-notes', 'note.md') }), /for profile "_none"/)
  denied(call(home, cwd.none, 'Read', { file_path: join(home, 'profiles', 'acme', 'profile.md') }))
  allowed(call(home, cwd.none, 'Read', { file_path: join(home, 'profiles', '_template', 'profile.md') }))
})

test('brains/access.json: Read allowed, Edit and Write denied', () => {
  const { home, cwd } = makeHome()
  const m = join(home, 'brains', 'access.json')
  allowed(call(home, cwd.none, 'Read', { file_path: m }))
  denied(call(home, cwd.none, 'Edit', { file_path: m, old_string: 'a', new_string: 'b' }), /brain-access\.sh/)
  denied(call(home, cwd.none, 'Write', { file_path: m, content: '{}' }))
})

test('relative and missing paths are judged where they land', () => {
  const { home, cwd } = makeHome()
  denied(call(home, home, 'Read', { file_path: 'brains/acme-notes/note.md' }))
  denied(call(home, cwd.beta, 'Write', { file_path: join(home, 'brains', 'main', 'new', 'deep', 'x.md'), content: 'x' }))
})

test('a file directly in brains/, a template, or brains/ itself is not a brain', () => {
  const { home, cwd } = makeHome()
  writeFileSync(join(home, 'brains', 'access.json.example'), '{}')
  allowed(call(home, cwd.beta, 'Read', { file_path: join(home, 'brains', 'access.json.example') }))
  allowed(call(home, cwd.beta, 'Read', { file_path: join(home, 'brains', '_template', 'README.md') }))
  allowed(call(home, cwd.beta, 'Glob', { pattern: '*', path: join(home, 'brains') }))
})

test('a path outside TILLER_HOME is allowed', () => {
  const { base, home, cwd } = makeHome()
  allowed(call(home, cwd.beta, 'Read', { file_path: join(base, 'elsewhere', 'x.md') }))
  allowed(call(home, cwd.beta, 'Grep', { pattern: 'x' }))
})

test('Bash: a none brain or another profile named in any form is denied', () => {
  const { home, cwd } = makeHome()
  for (const command of [
    `cat "${join(home, 'brains', 'main', 'note.md')}"`,
    'cat ~/x/tiller/brains/main/note.md',
    'cat "$TILLER_HOME/brains/main/note.md"',
    'cd /tmp && cat brains/main',
  ]) denied(call(home, cwd.beta, 'Bash', { command }), /"main" is "none" for profile "beta"/)
  denied(call(home, cwd.acme, 'Bash', { command: 'cat profiles/beta/profile.md' }), /profiles\/beta/)
  allowed(call(home, cwd.acme, 'Bash', { command: 'cat profiles/acme/profile.md profiles/_template/profile.md' }))
})

test('Bash: a brain name is matched whole, not as a prefix', () => {
  const { home, cwd } = makeHome()
  allowed(call(home, cwd.beta, 'Bash', { command: 'ls /srv/brains/mainframe' }))
})

test('Bash: a write into a read brain is denied, a harmless redirection is not', () => {
  const { home, cwd } = makeHome()
  const dir = join(home, 'brains', 'main')
  for (const command of [`echo x > "${dir}/new.md"`, `echo x | tee -a "${dir}/note.md"`, `mv /tmp/a "${dir}/"`, `cp /tmp/a "${dir}/b"`])
    denied(call(home, cwd.acme, 'Bash', { command }), /"main" is "read"/)
  allowed(call(home, cwd.acme, 'Bash', { command: `cat "${dir}/note.md" 2>/dev/null` }))
  allowed(call(home, cwd.acme, 'Bash', { command: `echo x > "${join(home, 'brains', 'acme-notes', 'n.md')}"` }))
})

test('Bash: writing brains/access.json is denied, reading it is not', () => {
  const { home, cwd } = makeHome()
  denied(call(home, cwd.none, 'Bash', { command: `echo '{}' > "${join(home, 'brains', 'access.json')}"` }), /brain-access\.sh/)
  allowed(call(home, cwd.none, 'Bash', { command: `cat "${join(home, 'brains', 'access.json')}"` }))
})

test('malformed JSON: a protected path is denied, an unrelated one allowed', () => {
  const { home, cwd } = makeHome()
  denied(call(home, cwd.acme, null, null, `{"tool_name":"Read","tool_input":{"file_path":"${home}/brains/main/note.md"`), /malformed/)
  allowed(call(home, cwd.acme, null, null, '{"tool_name":"Read","tool_input":{"file_path":"/srv/x.md"'))
})

test('invalid matrix: every protected path is denied, an unrelated one allowed', () => {
  const { base, home, cwd } = makeHome({ matrix: { acme: { main: 'admin' } } })
  denied(call(home, cwd.acme, 'Read', { file_path: join(home, 'brains', 'acme-notes', 'note.md') }), /invalid/)
  denied(call(home, cwd.acme, 'Read', { file_path: join(home, 'profiles', 'acme', 'profile.md') }), /invalid/)
  denied(call(home, cwd.acme, 'Bash', { command: 'cat brains/acme-notes/note.md' }), /invalid/)
  allowed(call(home, cwd.acme, 'Read', { file_path: join(base, 'elsewhere', 'x.md') }))
  allowed(call(home, cwd.acme, 'Bash', { command: 'ls /srv' }))
})
