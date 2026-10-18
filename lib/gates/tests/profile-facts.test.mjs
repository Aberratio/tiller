import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { FIXTURE, ROOT, dropSection, profileFacts, renderFacts, replaceSection, variant } from './helpers.mjs'

const REFUSED = 4

test('the fixture profile is launch-safe', () => {
  const r = profileFacts(FIXTURE, true)
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /Launch-safe\./)
})

for (const heading of ['gates', 'run policy', 'inviolables', 'escalation']) {
  test(`a profile without ## ${heading} is refused`, () => {
    const r = profileFacts(variant(t => dropSection(t, heading)), true)
    assert.equal(r.code, REFUSED, r.stdout)
  })
}

test('gates declared as none are refused', () => {
  assert.equal(profileFacts(variant(t => replaceSection(t, 'gates', 'none'))).code, REFUSED)
})

test('a gate with an unknown source is refused', () => {
  const body = '| Gate | Source | Pass predicate |\n|---|---|---|\n| ci | `pipeline: all` | green |'
  assert.equal(profileFacts(variant(t => replaceSection(t, 'gates', body))).code, REFUSED)
})

for (const v of ['1', '3']) {
  test(`schema_version ${v} is refused`, () => {
    const r = profileFacts(variant(t => t.replace('schema_version: 2', `schema_version: ${v}`)), true)
    assert.equal(r.code, REFUSED, r.stdout)
  })
}

test('an absent schema_version reads as 1 and is refused', () => {
  assert.equal(profileFacts(variant(t => t.replace('schema_version: 2\n', ''))).code, REFUSED)
})

test('tracker none is accepted and renders spec mode', () => {
  const path = variant(t => replaceSection(t, 'tracker', '- Kind: `none`'))
  const facts = renderFacts(path)
  assert.deepEqual(facts.tracker, { kind: 'none', spec: true })
})

const tools = rows => variant(t => t + '\n## tools\n\n| Role | Kind | Server |\n|---|---|---|\n' + rows + '\n')

test('no tools section renders the tracker kind only; declared rows render as bindings', () => {
  assert.deepEqual(renderFacts(FIXTURE).tools, { tracker: { kind: renderFacts(FIXTURE).tracker.kind } })
  const facts = renderFacts(tools('| docs | confluence | default |\n| chat | - | notion |\n| email | none | |'))
  assert.deepEqual(facts.tools.docs, { kind: 'confluence' })
  assert.deepEqual(facts.tools.chat, { server: 'notion' })
  assert.deepEqual(facts.tools.email, { kind: 'none' })
})

test('a tools row naming an unknown role, kind or server, a repeated role, or a tracker kind is refused', () => {
  for (const bad of ['| pager | x | |', '| chat | - | slack-eu |', '| review-bot | coderabbit | |', '| docs | wiki | |', '| docs | notion | |\n| docs | confluence | |', '| tracker | linear | |']) {
    assert.equal(profileFacts(tools(bad)).code, REFUSED, bad)
  }
})

test('a mandate outside the closed list is refused', () => {
  const body = '- Proxy: `fixture-proxy`\n- Mandate: `start-next-ticket`, `merge-anything`'
  assert.equal(profileFacts(variant(t => replaceSection(t, 'owner proxy', body))).code, REFUSED)
})

test('no owner proxy renders, but forbids a day run', () => {
  for (const edit of [t => dropSection(t, 'owner proxy'), t => replaceSection(t, 'owner proxy', 'none — not yet')]) {
    const facts = renderFacts(variant(edit))
    assert.equal(facts.ownerProxy, null)
    assert.equal(facts.dayRunAllowed, false)
  }
})

test('inviolables none renders an empty list; an item without a source is refused', () => {
  assert.deepEqual(renderFacts(variant(t => replaceSection(t, 'inviolables', 'none'))).inviolables, [])
  assert.equal(profileFacts(variant(t => replaceSection(t, 'inviolables', '1. Never do X.'))).code, REFUSED)
})

test('an abbreviated glob is refused', () => {
  const body = '| Path | Who merges |\n|---|---|\n| `.../theme/**` | agent |'
  assert.equal(profileFacts(variant(t => replaceSection(t, 'merge authority', body))).code, REFUSED)
})

test('a merge row naming no glob is refused', () => {
  const body = '| Path | Who merges |\n|---|---|\n| the theme folder | agent |'
  assert.equal(profileFacts(variant(t => replaceSection(t, 'merge authority', body))).code, REFUSED)
})

test('fix rounds above the cap maximum are refused', () => {
  assert.equal(profileFacts(variant(t => t.replace('- Fix rounds: 2', '- Fix rounds: 9'))).code, REFUSED)
})

test('force-push after rebase defaults to never, renders with-lease, and refuses anything else', () => {
  assert.equal(renderFacts(FIXTURE).runPolicy.forcePushAfterRebase, 'never')
  const set = v => variant(t => t.replace('- Stop hour: 18:00', `- Stop hour: 18:00\n- Force-push after rebase: ${v}`))
  assert.equal(renderFacts(set('with-lease')).runPolicy.forcePushAfterRebase, 'with-lease')
  assert.equal(renderFacts(set('never')).runPolicy.forcePushAfterRebase, 'never')
  assert.equal(profileFacts(set('always')).code, REFUSED)
  assert.equal(profileFacts(set('TODO')).code, REFUSED)
})

test('a day ceiling that is not a positive integer is refused', () => {
  assert.equal(profileFacts(variant(t => t.replace('- Day ceiling: 5', '- Day ceiling: TODO'))).code, REFUSED)
})

test('an unknown model-routing lane is refused; none renders {}', () => {
  assert.deepEqual(renderFacts(FIXTURE).modelRouting, {})
  const body = '| Lane | Tier |\n|---|---|\n| no-such-lane | T1 |'
  assert.equal(profileFacts(variant(t => replaceSection(t, 'model routing', body))).code, REFUSED)
  const known = '| Lane | Tier |\n|---|---|\n| log-prose | T1 |'
  assert.deepEqual(renderFacts(variant(t => replaceSection(t, 'model routing', known))).modelRouting, { 'log-prose': 'T1' })
})

const toolchain = cell => variant(t => replaceSection(t, 'test toolchain',
  `| Repo | Level | Command |\n|---|---|---|\n| \`app\` | unit | \`cd app && npm test\` |\n| \`app\` | api | n/a |\n| \`app\` | e2e | ${cell} |`))

test('a test toolchain of code-span commands and n/a is launch-safe', () => {
  const r = profileFacts(toolchain('`npx playwright test`'), true)
  assert.equal(r.code, 0, r.stdout)
})

// verify-claim runs this cell under sh -c; prose there exits 2 and reads as a failing test.
test('a test toolchain command cell in prose is refused', () => {
  const r = profileFacts(toolchain("vitest via the package's own script"), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /test toolchain — commands.*not a runnable command/)
})

test('a test toolchain command cell reading TODO is refused', () => {
  assert.equal(profileFacts(toolchain('TODO'), true).code, REFUSED)
})

const statics = cell => variant(t => replaceSection(t, 'static checks',
  `| Repo | Check | Command |\n|---|---|---|\n| \`app\` | typecheck | \`cd app && npx tsc --noEmit\` |\n| \`app\` | format | n/a |\n| \`app\` | lint | ${cell} |`))

test('static checks render as a list of runnable checks; n/a rows are left out', () => {
  assert.deepEqual(renderFacts(statics('`cd app && npx eslint .`')).staticChecks,
    [{ check: 'typecheck', command: 'cd app && npx tsc --noEmit' }, { check: 'lint', command: 'cd app && npx eslint .' }])
})

test('a static check command cell in prose is refused', () => {
  const r = profileFacts(statics('eslint over the changed files'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /static checks — commands.*not a runnable command/)
})

test('an absent or none static checks section renders an empty list', () => {
  assert.deepEqual(renderFacts(variant(t => dropSection(t, 'static checks'))).staticChecks, [])
  assert.deepEqual(renderFacts(variant(t => replaceSection(t, 'static checks', 'none'))).staticChecks, [])
})

// `## worktree setup` is not one of the fixture's headings (most profiles need none — a symlinked
// or vendored node_modules), so it is inserted rather than replaced.
const withWorktreeSetup = body => variant(t => t.replace('## conventions', `## worktree setup\n\n${body}\n\n## conventions`))

test('an absent worktree setup section renders an empty list, same as static checks', () => {
  assert.deepEqual(renderFacts(FIXTURE).worktreeSetup, [])
})

test('worktree setup renders as a list of runnable checks, same shape as static checks', () => {
  const body = '| Repo | Check | Command |\n|---|---|---|\n| `app` | install | `cd app && npm ci` |\n| `app` | skip | n/a |'
  assert.deepEqual(renderFacts(withWorktreeSetup(body)).worktreeSetup, [{ check: 'install', command: 'cd app && npm ci' }])
})

test('worktree setup declared none renders an empty list', () => {
  assert.deepEqual(renderFacts(withWorktreeSetup('none')).worktreeSetup, [])
})

test('a worktree setup command cell in prose is refused', () => {
  const body = '| Repo | Check | Command |\n|---|---|---|\n| `app` | install | run npm ci by hand |'
  const r = profileFacts(withWorktreeSetup(body), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /worktree setup — commands.*not a runnable command/)
})

test('worktree setup check names must not repeat', () => {
  const body = '| Repo | Check | Command |\n|---|---|---|\n| `app` | install | `npm ci` |\n| `app` | install | `npm ci --prefer-offline` |'
  assert.equal(profileFacts(withWorktreeSetup(body)).code, REFUSED)
})

// `## generated files` is optional and read by the conflict-resolution skill, not rendered: the
// runner never branches on it. It is inserted before `## gates`, where the schema orders it.
const withGenerated = body => variant(t => t.replace('## gates', `## generated files\n\n${body}\n\n## gates`))
const generated = (glob, cmd) => withGenerated(`| Repo | Glob | Command |\n|---|---|---|\n| \`app\` | \`app/package-lock.json\` | \`cd app && npm install\` |\n| \`app\` | ${glob} | ${cmd} |`)

test('an absent or none generated files section is launch-safe', () => {
  assert.equal(profileFacts(FIXTURE, true).code, 0)
  assert.equal(profileFacts(withGenerated('none'), true).code, 0)
})

test('generated files of backticked globs and code-span or n/a commands are launch-safe', () => {
  const r = profileFacts(generated('`app/src/*.gen.ts`, `app/schema.json`', 'n/a'), true)
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /ok +generated files — table/)
})

test('a generated files regenerate command in prose is refused', () => {
  const r = profileFacts(generated('`app/src/*.gen.ts`', 'run the router plugin'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /generated files — table.*not a runnable command/)
})

test('a generated files glob cell with no backticked glob is refused', () => {
  const r = profileFacts(generated('the route tree', '`cd app && npx vite build`'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /generated files — table.*names no backticked glob/)
})

test('a generated files row reading TODO is refused', () => {
  assert.equal(profileFacts(generated('TODO', '`cd app && npx vite build`'), true).code, REFUSED)
  assert.equal(profileFacts(generated('`app/src/*.gen.ts`', 'TODO'), true).code, REFUSED)
})

test('a generated files table without a Glob column is refused', () => {
  const r = profileFacts(withGenerated('| Repo | Command |\n|---|---|\n| `app` | `npm install` |'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /generated files — table.*no Glob column/)
})

// `## ticket conventions` is read as prose by flow-write-ticket through profilePath, so it renders
// no facts key; --check only guards that a declared section names its canon and carries no TODO.
const withTicketConventions = body => variant(t => t.replace('## repos', `## ticket conventions\n\n${body}\n\n## repos`))
const TICKET_CONVENTIONS = '- Source: [Ticket guide](https://wiki.example/ticket-guide)\n- Components per ticket: exactly one\n\n| Component | Covers |\n|---|---|\n| API | backend |'

test('an absent ticket conventions section is launch-safe and not reported', () => {
  const r = profileFacts(FIXTURE, true)
  assert.equal(r.code, 0, r.stdout)
  assert.doesNotMatch(r.stdout, /ticket conventions/)
})

test('ticket conventions naming a Source are launch-safe and reported ok', () => {
  const r = profileFacts(withTicketConventions(TICKET_CONVENTIONS), true)
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /ok +ticket conventions — source/)
})

test('ticket conventions declared none are launch-safe', () => {
  assert.equal(profileFacts(withTicketConventions('none — the tracker defaults are the convention'), true).code, 0)
})

test('ticket conventions without a Source are refused', () => {
  const r = profileFacts(withTicketConventions('- Components per ticket: exactly one'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /ticket conventions — source.*names no Source/)
})

test('ticket conventions reading TODO are refused', () => {
  const r = profileFacts(withTicketConventions(`${TICKET_CONVENTIONS}\n- Project routing: TODO`), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /ticket conventions — source.*reads TODO/)
})

test('ticket conventions add no key to the facts object', () => {
  assert.deepEqual(Object.keys(renderFacts(withTicketConventions(TICKET_CONVENTIONS))), Object.keys(renderFacts(FIXTURE)))
})

// `## board` is optional and read by flow-pm, not rendered: absent or `none` means flow-pm only
// audits. Present, it is validated so a malformed mandate fails at --check, not mid-sweep.
const BOARD = [
  '- Acts on: tickets assigned to the session account, and unassigned ones whose PR it authored',
  '- Reads: `FIX`',
  '- Writes: `transition`, `assignee`, `priority`',
  '- Verified status: `Done`',
  '- Release status: none',
  '- Canary: `FIX-1`',
  '- WIP limit: 4',
  '- State dir: `~/.fixture/pm`',
].join('\n')
const withBoard = (body, edit = t => t) =>
  variant(t => edit(t.replace('## repos', `## board\n\n${body}\n\n## repos`)))
const boardLine = (label, line) => BOARD.split('\n').map(l => l.startsWith(`- ${label}:`) ? line : l).join('\n')
const boardWithout = label => BOARD.split('\n').filter(l => !l.startsWith(`- ${label}:`)).join('\n')

test('an absent or none board section is launch-safe', () => {
  assert.equal(profileFacts(FIXTURE, true).code, 0)
  const r = profileFacts(withBoard('none — flow-pm audits only'), true)
  assert.equal(r.code, 0, r.stdout)
})

test('a filled board section is launch-safe and reported by --check', () => {
  const r = profileFacts(withBoard(BOARD), true)
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /ok +board — writes/)
  assert.match(r.stdout, /ok +board — canary/)
})

test('a board write outside the closed list is refused', () => {
  const r = profileFacts(withBoard(boardLine('Writes', '- Writes: `transition`, `duedate`')), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /board — writes.*outside the closed list: duedate/)
})

test('board writes none is accepted; an empty writes line is refused', () => {
  assert.equal(profileFacts(withBoard(boardLine('Writes', '- Writes: none'))).code, 0)
  assert.equal(profileFacts(withBoard(boardLine('Writes', '- Writes:'))).code, REFUSED)
})

test('a board without a canary, or with one that is not a ticket key, is refused', () => {
  assert.equal(profileFacts(withBoard(boardLine('Canary', '- Canary: TODO'))).code, REFUSED)
  const r = profileFacts(withBoard(boardLine('Canary', '- Canary: `the oldest done ticket`')), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /board — canary.*not a ticket key/)
})

test('a board WIP limit that is not a positive integer is refused', () => {
  assert.equal(profileFacts(withBoard(boardLine('WIP limit', '- WIP limit: many'))).code, REFUSED)
})

test('board transitions without a verified status are refused', () => {
  assert.equal(profileFacts(withBoard(boardWithout('Verified status'))).code, REFUSED)
})

test('a board section missing acts on or state dir is refused', () => {
  for (const label of ['Acts on', 'State dir']) {
    assert.equal(profileFacts(withBoard(boardWithout(label))).code, REFUSED, label)
  }
})

test('a board on a profile with no tracker is refused', () => {
  const r = profileFacts(withBoard(BOARD, t => replaceSection(t, 'tracker', '- Kind: `none`')), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /board — tracker/)
})

// Optional, like `## worktree setup`: a project that keeps no cross-ticket register of unverified
// criteria leaves it out, so it is inserted rather than replaced.
const withRegister = body => variant(t => t.replace('## charting', `## verification register\n\n${body}\n\n## charting`))

test('an absent or none verification register renders null', () => {
  assert.equal(renderFacts(FIXTURE).verificationRegister, null)
  assert.equal(renderFacts(withRegister('none — criteria stay on the ticket')).verificationRegister, null)
})

test('a verification register renders its path', () => {
  const body = '- Path: `docs/qa/unverified-register.md` — one file across tickets'
  assert.equal(renderFacts(withRegister(body)).verificationRegister, 'docs/qa/unverified-register.md')
})

test('a verification register reading TODO is refused', () => {
  const r = profileFacts(withRegister('- Path: TODO'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /verification register — path/)
})

test('a verification register with no backticked path is refused', () => {
  const r = profileFacts(withRegister('- Path: the shared QA file somewhere'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /verification register — path.*no backticked path/)
})

// `## worktree` names the repo's own worktree command; absent, the runner uses lib/git/worktree.mjs.
const withWorktree = body => variant(t => t.replace('## conventions', `## worktree\n\n${body}\n\n## conventions`))

test('an absent worktree section renders worktreeCreate null', () => {
  assert.equal(renderFacts(FIXTURE).worktreeCreate, null)
})

test('worktree declared none renders worktreeCreate null', () => {
  assert.equal(renderFacts(withWorktree('none')).worktreeCreate, null)
})

test('the worktree Create line renders as the command template, backticks stripped', () => {
  const f = renderFacts(withWorktree('- Create: `bin/worktree new <branch>` — run from the main checkout'))
  assert.equal(f.worktreeCreate, 'bin/worktree new <branch>')
})

test('a worktree Create line in prose is refused', () => {
  const r = profileFacts(withWorktree('- Create: run bin/worktree new by hand'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /worktree — create.*one code span/)
})

test('a worktree Create command without the <branch> placeholder is refused', () => {
  const r = profileFacts(withWorktree('- Create: `bin/worktree new`'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /worktree — create.*<branch>/)
})

test('a worktree Create command with a placeholder other than <branch> or <base> is refused', () => {
  const r = profileFacts(withWorktree('- Create: `bin/worktree new <branch> --dir <dir>`'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /worktree — create.*<dir>/)
})

test('a worktree section without a Create line is refused', () => {
  assert.equal(profileFacts(withWorktree('- Worktrees live somewhere')).code, REFUSED)
})

test('a test toolchain that is prose saying TODO is refused, not read as nothing to run', () => {
  const body = 'TODO — no lockfile beside `app/package.json`, so no command could be read from the clone'
  const r = profileFacts(variant(t => replaceSection(t, 'test toolchain', body)), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /test toolchain — commands \(reads TODO\)/)
})

test('the template copied unchanged is refused and allows no day run', () => {
  const r = profileFacts(join(ROOT, 'profiles', '_template', 'profile.md'), true)
  assert.equal(r.code, REFUSED, r.stdout)
  assert.match(r.stdout, /MISSING +tracker — site \(reads a template placeholder\)/)
  assert.match(r.stdout, /MISSING +owner proxy — role \(reads a template placeholder\)/)
})

test('a placeholder without spaces is a value, not a template slot', () => {
  const path = variant(t => t.replace(/## decision ledger\n\n[^\n]*\n/, '## decision ledger\n\n`docs/decisions/<TICKET>.md`\n'))
  assert.equal(profileFacts(path).code, 0)
})

test('a template slot is one `<...>` with spaces in it, not any `<` with a `>` later on', () => {
  const convention = (body) => variant(t => t.replace(/^- Convention: .*$/m, `- Convention: ${body}`))
  const prose = profileFacts(convention('`<KEY>-<description>`; see <https://x.example/guide>'), true)
  assert.equal(prose.code, 0, prose.stdout)
  const slot = profileFacts(convention('`<KEY>-<what the branch does>`'), true)
  assert.equal(slot.code, REFUSED, slot.stdout)
  assert.match(slot.stdout, /branching — Convention \(reads a template placeholder\)/)
})

const doubtLog = (line, env = {}) => {
  const path = variant(t => replaceSection(t, 'escalation', `${line}\n- Human: the project owner`))
  const r = spawnSync('bash', [join(ROOT, 'lib', 'profile-facts.sh'), '--profile', path],
    { encoding: 'utf8', env: { ...process.env, TILLER_DOUBT_LOG: '', ...env } })
  return { path, code: r.status, log: r.status === 0 ? JSON.parse(r.stdout).escalation.doubtLog : null }
}
const today = () => new Date().toISOString().slice(0, 10)

test('no doubt log line renders the default inside the profile directory, dated today (UTC)', () => {
  const r = doubtLog('')
  assert.equal(r.log, join(dirname(r.path), 'doubts', `${today()}.md`))
})

test('the doubt log renders resolved: relative to the profile, <date> filled, ~ expanded', () => {
  const rel = doubtLog('- Doubt log: `notes/<date>.md`')
  assert.equal(rel.log, join(dirname(rel.path), 'notes', `${today()}.md`))
  assert.equal(doubtLog('- Doubt log: `~/d.md`', { HOME: '/home/someone' }).log, '/home/someone/d.md')
})

test('TILLER_DOUBT_LOG applies only when the profile names no log', () => {
  assert.equal(doubtLog('', { TILLER_DOUBT_LOG: '/env/<date>.md' }).log, `/env/${today()}.md`)
  assert.equal(doubtLog('- Doubt log: `/from-profile.md`', { TILLER_DOUBT_LOG: '/env.md' }).log, '/from-profile.md')
})

test('a doubt log that reads TODO or a template placeholder is still refused', () => {
  assert.equal(doubtLog('- Doubt log: TODO').code, REFUSED)
  assert.equal(doubtLog('- Doubt log: <path where parked decisions are written>').code, REFUSED)
})

test('commits.textLanguage defaults to en and reads the optional bullet', () => {
  assert.equal(renderFacts(FIXTURE).commits.textLanguage, 'en')
  const body = '- Format: `<type>(<scope>): <subject>`\n- Text language: `pl`'
  const f = renderFacts(variant(t => (t.trimEnd() + `\n\n## commits\n\n${body}\n`)))
  assert.equal(f.commits.textLanguage, 'pl')
})

test('a text language that is not a language tag is refused', () => {
  const body = '- Format: `<type>(<scope>): <subject>`\n- Text language: `English please`'
  assert.equal(profileFacts(variant(t => (t.trimEnd() + `\n\n## commits\n\n${body}\n`))).code, REFUSED)
})
