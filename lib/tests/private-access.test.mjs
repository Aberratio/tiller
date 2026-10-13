import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, cleanEnv } from '../testing/private-access.mjs'

const HOOK = fileURLToPath(new URL('../hooks/private-access.sh', import.meta.url))

function call(home, cwd, tool_name, tool_input, raw, env = {}) {
  const input = raw ?? JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd })
  const r = spawnSync('bash', [HOOK], { encoding: 'utf8', input, env: cleanEnv({ TILLER_HOME: home, ...env }) })
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

test('_none row: another profile\'s doubt log is readable, never writable, and the rest stays denied', () => {
  const { home, cwd } = makeHome()
  const log = join(home, 'profiles', 'acme', 'doubts', '2026-10-13.md')
  allowed(call(home, cwd.none, 'Read', { file_path: log }))
  allowed(call(home, cwd.none, 'Grep', { path: join(home, 'profiles', 'acme', 'doubts') }))
  denied(call(home, cwd.none, 'Write', { file_path: log, content: 'x' }), /profiles\/acme/)
  denied(call(home, cwd.none, 'Read', { file_path: join(home, 'profiles', 'acme', 'profile.md') }))
  denied(call(home, cwd.beta, 'Read', { file_path: log }), /profiles\/acme is not the resolved profile "beta"/)
  allowed(call(home, cwd.none, 'Bash', { command: 'cat profiles/acme/doubts/2026-10-13.md' }))
  denied(call(home, cwd.none, 'Bash', { command: 'echo x >> profiles/acme/doubts/2026-10-13.md' }), /profiles\/acme/)
  denied(call(home, cwd.none, 'Bash', { command: 'cat profiles/acme/doubts/x.md profiles/acme/profile.md' }), /profiles\/acme/)
  denied(call(home, cwd.beta, 'Bash', { command: 'cat profiles/acme/doubts/x.md' }), /profiles\/acme/)
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

test('helm: a project session is denied every tool, record.sh and unrelated "helm" words pass', () => {
  const { home, cwd } = makeHome()
  const md = join(home, 'helm', 'helm.md')
  denied(call(home, cwd.acme, 'Read', { file_path: md }), /^private-access: helm is closed to project sessions \(profile "acme"\)/)
  denied(call(home, cwd.acme, 'Grep', { pattern: 'x', path: join(home, 'helm') }))
  denied(call(home, cwd.acme, 'Glob', { pattern: 'helm/**', path: home }))
  denied(call(home, cwd.acme, 'Bash', { command: `cat "${join(home, 'helm', 'events', 'a.md')}"` }))
  denied(call(home, cwd.acme, 'Bash', { command: `git -C "${join(home, 'helm')}" log` }))
  allowed(call(home, cwd.acme, 'Bash', { command: `"${join(home, 'lib', 'helm', 'record.sh')}" --kind note --summary x` }))
  allowed(call(home, cwd.acme, 'Bash', { command: 'helm upgrade --install web ./chart' }))
})

test('helm: outside any project reads pass, helm.md and machines/ may be edited, events may not', () => {
  const { home, cwd } = makeHome()
  allowed(call(home, cwd.none, 'Read', { file_path: join(home, 'helm', 'events', 'a.md') }))
  allowed(call(home, cwd.none, 'Edit', { file_path: join(home, 'helm', 'helm.md'), old_string: 'a', new_string: 'b' }))
  allowed(call(home, cwd.none, 'Write', { file_path: join(home, 'helm', 'machines', 'laptop.md'), content: 'x' }))
  denied(call(home, cwd.none, 'Write', { file_path: join(home, 'helm', 'events', 'a.md'), content: 'x' }), /events go through lib\/helm\/record\.sh/)
  denied(call(home, cwd.none, 'Bash', { command: `echo x > "${join(home, 'helm', 'events', 'a.md')}"` }), /events go through/)
  allowed(call(home, cwd.none, 'Bash', { command: `git -C "${join(home, 'helm')}" commit -qam "register project"` }))
})

test('helm: a broken matrix denies any helm path form, and the record.sh strip is narrow', () => {
  const { base, home, cwd } = makeHome({ matrix: { acme: { main: 'admin' } } })
  const T = home
  denied(call(home, cwd.acme, 'Bash', { command: `git -C ${T}/helm log` }), /invalid/)
  denied(call(home, cwd.acme, 'Bash', { command: `grep -r tok ${T}/helm` }), /invalid/)
  denied(call(home, cwd.acme, 'Bash', { command: `cat ${join(base, 'x', 'lib', 'helm', 'events', 'a.md')}` }), /invalid/)
})

test('helm: a project session is denied the helm root in every spelling, other helm paths pass', () => {
  const { home, cwd } = makeHome()
  const T = home
  allowed(call(home, cwd.acme, 'Bash', { command: 'cat ~/.config/helm/repositories.yaml' }))
  allowed(call(home, cwd.acme, 'Bash', { command: 'ls /usr/local/bin/helm' }))
  allowed(call(home, cwd.acme, 'Bash', { command: 'helm template ./helm/web' }))
  allowed(call(home, cwd.acme, 'Bash', { command: 'helm pull oci://ghcr.io/acme/helm/web' }))
  allowed(call(home, cwd.acme, 'Bash', { command: `${T}/lib/helm/record.sh --kind note --summary x` }))
  denied(call(home, cwd.acme, 'Bash', { command: `x=\`grep -r tok ${T}/helm\`; echo $x` }), /closed to project sessions/)
  denied(call(home, cwd.acme, 'Bash', { command: `ls ${T}/helm*` }))
  denied(call(home, cwd.acme, 'Bash', { command: 'cat "$TILLER_HOME/helm/helm.md"' }))
  denied(call(home, cwd.acme, 'Bash', { command: 'cat "${TILLER_HOME}/helm/helm.md"' }))
  denied(call(home, cwd.acme, 'Bash', { command: `cat "${T}/lib/helm/record.sh" "${T}/helm/events/a.md"` }))
  writeFileSync(join(T, '.tiller-profile'), 'acme\n')
  denied(call(home, T, 'Bash', { command: `cd ${T} && grep -r tok helm` }), /closed to project sessions \(profile "acme"\)/)
})

test('helm: the ~ spelling of a home under $HOME is a hit', () => {
  const { base, home, cwd } = makeHome({ spaced: false })
  denied(call(home, cwd.acme, 'Bash', { command: 'cat ~/repos/tiller/helm/helm.md' }, null, { HOME: base }))
  allowed(call(home, cwd.acme, 'Bash', { command: 'cat ~/repos/other/helm/helm.md' }, null, { HOME: base }))
})

test('helm: outside any project Bash writes reach only helm.md, machines/ and git commit/push/pull', () => {
  const { home, cwd } = makeHome()
  const T = home
  const events = /^private-access: helm: events go through lib\/helm\/record\.sh$/
  denied(call(home, cwd.none, 'Bash', { command: `rm -rf ${T}/helm` }), events)
  denied(call(home, cwd.none, 'Bash', { command: `echo x > ${T}/helm/notes.md` }), events)
  denied(call(home, cwd.none, 'Bash', { command: `cd ${T}/helm && echo x > events/a.md` }), events)
  denied(call(home, cwd.none, 'Bash', { command: `git -C ${T}/helm reset --hard HEAD~3` }), events)
  denied(call(home, cwd.none, 'Bash', { command: `echo x >> ${T}/helm/machines/../events/a.md` }), events)
  allowed(call(home, cwd.none, 'Bash', { command: `echo x >> ${T}/helm/machines/m.md` }))
  allowed(call(home, cwd.none, 'Bash', { command: `git -C "${T}/helm" commit -qam "register p" && git -C "${T}/helm" push -q` }))
  allowed(call(home, cwd.none, 'Bash', { command: `cat ${T}/helm/events/*.md` }))
  allowed(call(home, T, 'Bash', { command: 'git -C helm commit -qam x && git -C helm push' }))
  denied(call(home, cwd.none, 'Bash', { command: `git -C ${T}/helm commit -qam x & rm -rf ${T}/helm/events` }), events)
  denied(call(home, cwd.none, 'Bash', { command: `git -C "${T}/helm" push & rm -rf "${T}/helm/events"` }), events)
  denied(call(home, cwd.none, 'Bash', { command: `git -C ${T}/helm push | tee ${T}/helm/events/a.md` }), events)
  denied(call(home, cwd.none, 'Bash', { command: `cd ${T}/helm/machines/x && echo y > ../../events/a.md` }), events)
  denied(call(home, T, 'Bash', { command: 'echo x > helm/events/a.md' }), events)
})

test('helm: a project session is denied tiller\'s own helm CLI and record.sh spoofs', () => {
  const { home, cwd } = makeHome()
  const T = home
  const closed = /closed to project sessions \(profile "acme"\)/
  denied(call(home, cwd.acme, 'Bash', { command: 'node "$TILLER_HOME/lib/helm/helm.mjs" status --json' }), closed)
  denied(call(home, cwd.acme, 'Bash', { command: 'node "$TILLER_HOME/lib/helm/helm.mjs" session --row _none' }), closed)
  denied(call(home, cwd.acme, 'Bash', { command: `node ${T}/lib/helm/helm.mjs record --project other --kind note --summary x` }), closed)
  denied(call(home, cwd.acme, 'Bash', { command: `cd ${T}/lib/helm && node helm.mjs status` }), closed)
  denied(call(home, cwd.acme, 'Bash', { command: `TILLER_PROFILE=beta ${T}/lib/helm/record.sh --kind note --summary x` }), closed)
  denied(call(home, cwd.acme, 'Bash', { command: `cd ${cwd.beta} && ${T}/lib/helm/record.sh --kind note --summary x` }), closed)
  allowed(call(home, cwd.acme, 'Bash', { command: `"${T}/lib/helm/record.sh" --kind note --summary "cd into the repo"` }))
  allowed(call(home, cwd.acme, 'Bash', { command: '"$TILLER_HOME/lib/helm/record.sh" --kind milestone --summary "Ticket started" --source flow-start-ticket' }))
  denied(call(home, cwd.acme, 'Bash', { command: `TILLER_HOME=/x "${T}/lib/helm/record.sh" --kind note --summary x` }), closed)
  allowed(call(home, cwd.none, 'Bash', { command: 'node "$TILLER_HOME/lib/helm/helm.mjs" status --json' }))
})

test('helm: outside any project the git exception refuses force and amend', () => {
  const { home, cwd } = makeHome()
  const T = home
  const events = /^private-access: helm: events go through lib\/helm\/record\.sh$/
  for (const g of ['push -f', 'push --force', 'push --force-with-lease', 'push -qf', 'push origin +main', 'commit --amend -qm x', 'pull --force']) {
    denied(call(home, cwd.none, 'Bash', { command: `git -C ${T}/helm ${g}` }), events)
  }
  allowed(call(home, cwd.none, 'Bash', { command: `git -C ${T}/helm commit -qam "fix -f wording" && git -C ${T}/helm push -q` }))
})

// Copilot CLI with the PascalCase event name sends snake_case fields and the Claude tool name, but
// reads a top-level permissionDecision, so the hook runs behind the translating wrapper.
const COPILOT = fileURLToPath(new URL('../hooks/copilot-pretooluse.sh', import.meta.url))

function copilotCall(home, cwd, tool_name, tool_input, hook = HOOK) {
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: 's-1', timestamp: '2026-10-13T12:00:00.000Z', cwd, tool_name, tool_input,
  })
  const r = spawnSync('bash', [COPILOT, hook], { encoding: 'utf8', input, env: cleanEnv({ TILLER_HOME: home }) })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('Copilot PascalCase PreToolUse payload: a private path is denied in the format Copilot reads', () => {
  const { home, cwd } = makeHome()
  const r = copilotCall(home, cwd.beta, 'Bash', { command: `cat "${join(home, 'brains', 'main', 'note.md')}"` })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.permissionDecision, 'deny', r.stdout)
  assert.match(out.permissionDecisionReason, /"main" is "none" for profile "beta"/)
})

test('Copilot PascalCase PreToolUse payload: an unrelated path is allowed with empty output', () => {
  const { home, cwd } = makeHome()
  const r = copilotCall(home, cwd.beta, 'Bash', { command: 'ls /srv' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('Copilot wrapper: a hook that fails or prints invalid output exits non-zero, which Copilot treats as deny', () => {
  const { base, home, cwd } = makeHome()
  const crash = join(base, 'crash.sh'), junk = join(base, 'junk.sh')
  writeFileSync(crash, 'exit 7\n')
  writeFileSync(junk, 'echo "{not json"\n')
  assert.notEqual(copilotCall(home, cwd.beta, 'Bash', { command: 'ls' }, crash).status, 0)
  assert.notEqual(copilotCall(home, cwd.beta, 'Bash', { command: 'ls' }, junk).status, 0)
})
