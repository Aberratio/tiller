# flow-discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `flow-discovery` skill that takes a new project from first conversation to an agreed spec and roadmap, with a client register kept in a brain and checked by a script.

**Architecture:** The register (`decisions.md`, `questions.md`) is plain markdown written by the agent. `lib/discovery/register.mjs` parses it and returns violations and status; `lib/discovery/discovery.mjs` is the CLI (`new`, `check`, `status`). The skill carries the five modes and calls the CLI.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-flow-discovery-design.md`

## Global Constraints

- No dependencies; Node built-ins only, like `lib/onboard/`.
- Exit codes: 0 done, 1 violations found (`check`), 2 usage, 3 refused.
- Brain root: `TILLER_BRAINS_DIR`, default `<repo>/brains`. Brain name `^[a-z0-9][a-z0-9-]*$`.
- `Area` ∈ `scope, tech, budget, deadline, other`. `Status` ∈ `proposed, agreed, superseded`. `Blocks spec` ∈ `yes, no`. `Owner` ∈ `client, me`.
- Entry heading: `### D-nnn — <title>` / `### Q-nnn — <title>`, id at least three digits; a plain `-` is accepted in place of `—`.
- No client, person or project name in any tracked file; `lib/leak-guard.sh` must pass on every commit.
- No `Co-Authored-By` or "Generated with" lines in commits.
- `brains/` scripts (`brain-access.sh`, `resolve-brains.sh`) are not on `main` yet; nothing here may require them. The PR waits for the brains branch to merge and is rebased onto `main` after it.

## Review Focus

1. A fresh or pet brain without `questions.md` or `decisions.md` → treated as empty, never a crash.
2. Notes pasted from Windows mail with CRLF line endings → parsed the same as LF.
3. `Supersedes: D-003, D-004` (one decision replacing two) → both ids checked and mirrored.
4. `new` on a brain that already exists → exit 3, nothing overwritten.
5. `check --spec <dir>` where the dir does not exist → exit 2 with a message, not "0 violations".

---

## File Structure

```
lib/discovery/register.mjs          parse entries; check(brain, {specDir}); status(brain)
lib/discovery/discovery.mjs         CLI: new | check | status
lib/discovery/templates/            client.md, decisions.md, questions.md, meeting.md, recap.md
lib/discovery/run-tests.sh          node --test over lib/discovery/tests
lib/discovery/tests/register.test.mjs
lib/discovery/tests/cli.test.mjs
lib/testing/fixtures/discovery/valid/   decisions.md, questions.md, spec/spec.md
skills/flow-discovery/SKILL.md
docs/adding-a-project.md            one paragraph: discovery before onboarding
README.md                           layout lines for lib/discovery and the skill
docs/superpowers/specs/2026-10-13-flow-discovery-design.md   fixture path corrected
```

### Task 1: Register parser and checker

**Files:**
- Create: `lib/discovery/register.mjs`
- Create: `lib/testing/fixtures/discovery/valid/decisions.md`, `questions.md`, `spec/spec.md`
- Create: `lib/discovery/tests/register.test.mjs`
- Create: `lib/discovery/run-tests.sh`
- Modify: `docs/superpowers/specs/2026-10-13-flow-discovery-design.md` (Layout and Testing: `lib/testing/discovery/` → `lib/testing/fixtures/discovery/`)

**Interfaces:**
- Produces: `parseEntries(text: string) → Array<{id, title, line, fields: Record<string,string>}>`
- Produces: `check(brainDir: string, opts?: {specDir?: string}) → string[]` (each `"<file>:<line>: <message>"`; empty = clean)
- Produces: `status(brainDir: string) → {awaiting: string[], open: Record<area, string[]>, blocking: string[], ready: boolean}`

- [ ] **Step 1: Valid fixture**

`lib/testing/fixtures/discovery/valid/decisions.md`:

```markdown
# Decisions

### D-001 — Web app first, mobile later
- Area: scope
- Status: agreed
- Proposed in: meetings/2026-01-05-kickoff.md
- Confirmed by: e-mail 2026-01-06 "Re: Kickoff recap"

### D-002 — Postgres
- Area: tech
- Status: superseded
- Proposed in: meetings/2026-01-05-kickoff.md
- Confirmed by: e-mail 2026-01-06 "Re: Kickoff recap"
- Superseded by: D-003

### D-003 — SQLite for the MVP
- Area: tech
- Status: agreed
- Proposed in: meetings/2026-01-12-tech.md
- Confirmed by: e-mail 2026-01-13 "Re: Tech recap"
- Supersedes: D-002

### D-004 — Launch before 2026-03-01
- Area: deadline
- Status: proposed
- Proposed in: meetings/2026-01-12-tech.md
```

`lib/testing/fixtures/discovery/valid/questions.md`:

```markdown
# Questions

### Q-001 — Who signs off the MVP?
- Area: scope
- Owner: client
- Blocks spec: yes
- Opened in: meetings/2026-01-05-kickoff.md
- Closed in: meetings/2026-01-12-tech.md

### Q-002 — Brand colours?
- Area: other
- Owner: client
- Blocks spec: no
- Opened in: meetings/2026-01-12-tech.md
- Closed in: -
```

`lib/testing/fixtures/discovery/valid/spec/spec.md`:

```markdown
# Spec

- Web app only in the first phase (D-001).
- Data in SQLite (D-003).
```

- [ ] **Step 2: Failing tests**

`lib/discovery/tests/register.test.mjs`:

```js
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, parseEntries, status } from '../register.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const VALID = join(HERE, '..', '..', 'testing', 'fixtures', 'discovery', 'valid')

const temps = []
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

// A copy of the valid brain with one file rewritten, so each test names exactly one fault.
function brain(edit = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-'))
  temps.push(dir)
  cpSync(VALID, dir, { recursive: true })
  for (const [file, fn] of Object.entries(edit)) {
    const p = join(dir, file)
    if (fn === null) unlinkSync(p)
    else writeFileSync(p, fn(readFileSync(p, 'utf8')))
  }
  return dir
}

test('parseEntries reads ids, titles, fields and lines', () => {
  const e = parseEntries('# D\n\n### D-001 — Title\n- Area: scope\n- Status: agreed\n')
  assert.deepEqual(e, [{ id: 'D-001', title: 'Title', line: 3, fields: { Area: 'scope', Status: 'agreed' } }])
})

test('parseEntries accepts CRLF and a plain dash', () => {
  const e = parseEntries('### Q-010 - Who?\r\n- Owner: me\r\n')
  assert.equal(e[0].id, 'Q-010')
  assert.equal(e[0].fields.Owner, 'me')
})

test('the valid brain has no violations, including against its spec', () => {
  const dir = brain()
  assert.deepEqual(check(dir, { specDir: join(dir, 'spec') }), [])
})

const faults = [
  ['duplicate id', { 'decisions.md': t => t + '\n### D-001 — Again\n- Area: scope\n- Status: proposed\n' }, /D-001 duplicate/],
  ['agreed without confirmation', { 'decisions.md': t => t.replace('- Confirmed by: e-mail 2026-01-06 "Re: Kickoff recap"\n\n### D-002', '\n### D-002') }, /D-001 agreed without Confirmed by/],
  ['superseded without successor', { 'decisions.md': t => t.replace('- Superseded by: D-003\n', '').replace('- Supersedes: D-002\n', '') }, /D-002 superseded without Superseded by/],
  ['successor missing', { 'decisions.md': t => t.replace('Superseded by: D-003', 'Superseded by: D-009').replace('- Supersedes: D-002\n', '') }, /D-002 Superseded by D-009, which does not exist/],
  ['supersedes not mirrored', { 'decisions.md': t => t.replace('- Supersedes: D-002\n', '') }, /D-002 Superseded by D-003, but D-003 does not list it in Supersedes/],
  ['unknown status', { 'decisions.md': t => t.replace('Status: proposed', 'Status: maybe') }, /D-004 Status "maybe"/],
  ['unknown area', { 'questions.md': t => t.replace('Area: other', 'Area: colour') }, /Q-002 Area "colour"/],
  ['bad Blocks spec', { 'questions.md': t => t.replace('Blocks spec: no', 'Blocks spec: maybe') }, /Q-002 Blocks spec "maybe"/],
]
for (const [name, edit, msg] of faults) {
  test(`check reports: ${name}`, () => {
    const out = check(brain(edit))
    assert.equal(out.length, 1, out.join('\n'))
    assert.match(out[0], msg)
  })
}

test('Supersedes with two ids is checked for both', () => {
  const dir = brain({ 'decisions.md': t => t.replace('- Supersedes: D-002\n', '- Supersedes: D-002, D-004\n') })
  assert.match(check(dir).join('\n'), /D-003 Supersedes D-004, but D-004 is not superseded by D-003/)
})

test('spec citing a superseded or missing decision', () => {
  const dir = brain({ 'spec/spec.md': t => t + '- Postgres (D-002), mobile (D-077).\n' })
  const out = check(dir, { specDir: join(dir, 'spec') }).join('\n')
  assert.match(out, /cites D-002, which is superseded/)
  assert.match(out, /cites D-077, which does not exist/)
})

test('a brain without register files is empty, not an error', () => {
  const dir = brain({ 'decisions.md': null, 'questions.md': null })
  assert.deepEqual(check(dir), [])
  assert.deepEqual(status(dir), { awaiting: [], open: {}, blocking: [], ready: true })
})

test('status: awaiting confirmation, open questions, readiness', () => {
  const dir = brain()
  assert.deepEqual(status(dir), { awaiting: ['D-004'], open: { other: ['Q-002'] }, blocking: [], ready: true })
  const blocked = brain({ 'questions.md': t => t.replace('Blocks spec: no', 'Blocks spec: yes') })
  assert.deepEqual(status(blocked).blocking, ['Q-002'])
  assert.equal(status(blocked).ready, false)
})
```

`lib/discovery/run-tests.sh` (then `chmod +x`):

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node --test "$HERE"/tests/*.test.mjs
```

- [ ] **Step 3: Run, expect failure**

Run: `lib/discovery/run-tests.sh`
Expected: FAIL, `Cannot find module '.../register.mjs'`.

- [ ] **Step 4: Implement `lib/discovery/register.mjs`**

```js
// Parse and check a discovery brain's register: decisions.md (D-nnn) and questions.md (Q-nnn).
// The files are written by an agent; this module is what keeps their statuses and cross-references
// honest after many meetings.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const HEAD = /^### ([DQ]-\d{3,})\s+[—-]\s+(.+?)\s*$/
const FIELD = /^- ([A-Za-z][A-Za-z ]*?):\s*(.*?)\s*$/
const ID = /\bD-\d{3,}\b/g
const AREAS = ['scope', 'tech', 'budget', 'deadline', 'other']
const STATUSES = ['proposed', 'agreed', 'superseded']
const OWNERS = ['client', 'me']
const empty = v => v === undefined || v === '' || v === '-'
const ids = v => (empty(v) ? [] : v.split(/[,\s]+/).filter(Boolean))

export function parseEntries(text) {
  const out = []
  let cur = null
  text.split(/\r?\n/).forEach((line, i) => {
    const h = line.match(HEAD)
    if (h) { cur = { id: h[1], title: h[2], line: i + 1, fields: {} }; out.push(cur); return }
    const f = cur && line.match(FIELD)
    if (f) cur.fields[f[1]] = f[2]
  })
  return out
}

const read = (dir, file) => (existsSync(join(dir, file)) ? parseEntries(readFileSync(join(dir, file), 'utf8')) : [])

function enumIssue(file, e, field, allowed) {
  const v = e.fields[field]
  return allowed.includes(v) ? null : `${file}:${e.line}: ${e.id} ${field} "${v ?? ''}" not one of ${allowed.join(', ')}`
}

export function check(brainDir, { specDir } = {}) {
  const out = []
  const decisions = read(brainDir, 'decisions.md')
  const questions = read(brainDir, 'questions.md')
  for (const [file, list] of [['decisions.md', decisions], ['questions.md', questions]]) {
    const seen = new Set()
    for (const e of list) {
      if (seen.has(e.id)) out.push(`${file}:${e.line}: ${e.id} duplicate`)
      seen.add(e.id)
      const area = enumIssue(file, e, 'Area', AREAS)
      if (area) out.push(area)
    }
  }
  const byId = new Map(decisions.map(d => [d.id, d]))
  for (const d of decisions) {
    const at = `decisions.md:${d.line}: ${d.id}`
    const st = enumIssue('decisions.md', d, 'Status', STATUSES)
    if (st) { out.push(st); continue }
    const s = d.fields.Status
    if (s === 'agreed' && empty(d.fields['Confirmed by'])) out.push(`${at} agreed without Confirmed by`)
    const by = ids(d.fields['Superseded by'])
    if (s === 'superseded' && by.length === 0) out.push(`${at} superseded without Superseded by`)
    for (const n of by) {
      const next = byId.get(n)
      if (!next) out.push(`${at} Superseded by ${n}, which does not exist`)
      else if (!ids(next.fields.Supersedes).includes(d.id)) out.push(`${at} Superseded by ${n}, but ${n} does not list it in Supersedes`)
    }
    for (const o of ids(d.fields.Supersedes)) {
      const old = byId.get(o)
      if (!old) out.push(`${at} Supersedes ${o}, which does not exist`)
      else if (!ids(old.fields['Superseded by']).includes(d.id)) out.push(`${at} Supersedes ${o}, but ${o} is not superseded by ${d.id}`)
    }
  }
  for (const q of questions) {
    for (const [field, allowed] of [['Owner', OWNERS], ['Blocks spec', ['yes', 'no']]]) {
      const issue = enumIssue('questions.md', q, field, allowed)
      if (issue) out.push(issue)
    }
  }
  if (specDir) {
    for (const f of readdirSync(specDir).filter(f => f.endsWith('.md')).sort()) {
      readFileSync(join(specDir, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const id of line.match(ID) || []) {
          const d = byId.get(id)
          if (!d) out.push(`${f}:${i + 1}: cites ${id}, which does not exist`)
          else if (d.fields.Status === 'superseded') out.push(`${f}:${i + 1}: cites ${id}, which is superseded`)
        }
      })
    }
  }
  return out
}

export function status(brainDir) {
  const awaiting = read(brainDir, 'decisions.md').filter(d => d.fields.Status === 'proposed').map(d => d.id)
  const open = {}
  const blocking = []
  for (const q of read(brainDir, 'questions.md')) {
    if (!empty(q.fields['Closed in'])) continue
    ;(open[q.fields.Area] ||= []).push(q.id)
    if (q.fields['Blocks spec'] === 'yes') blocking.push(q.id)
  }
  return { awaiting, open, blocking, ready: blocking.length === 0 }
}
```

- [ ] **Step 5: Run, expect pass**

Run: `lib/discovery/run-tests.sh`
Expected: all register tests PASS. If a fault test reports more than one line, the fixture edit hit two rules; fix the edit, not the checker.

- [ ] **Step 6: Commit**

```bash
git add lib/discovery lib/testing/fixtures/discovery docs/superpowers/specs/2026-10-13-flow-discovery-design.md
git commit -m "feat(discovery): check a brain's decision and question register"
```

### Task 2: CLI and templates

**Files:**
- Create: `lib/discovery/discovery.mjs`
- Create: `lib/discovery/templates/{client,decisions,questions,meeting,recap}.md`
- Create: `lib/discovery/tests/cli.test.mjs`

**Interfaces:**
- Consumes: `check`, `status` from `register.mjs`.
- Produces: `discovery.mjs new <name> [--pet]`, `check <name> [--spec <dir>]`, `status <name>`; `<name>` resolves under `TILLER_BRAINS_DIR`. The skill (Task 3) calls exactly these.

- [ ] **Step 1: Templates**

`templates/client.md`:

```markdown
# Client

## Business
<!-- What they do, how they make money, market, size. -->

## Users
<!-- Who will use the product, how many, in what situation. -->

## People
<!-- Who decides, who signs off, who answers what. Role, not just name. -->

## Constraints
<!-- Budget range, data protection, sector rules, existing systems. -->

## Vocabulary
<!-- Their words for things, and what they mean. -->

## Channel
<!-- Preferred contact, response times, meeting rhythm. -->
```

`templates/decisions.md`:

```markdown
# Decisions

<!-- ### D-001 — <decision>
- Area: scope | tech | budget | deadline | other
- Status: proposed | agreed | superseded
- Proposed in: meetings/<file>.md
- Confirmed by: <e-mail date and subject, or self>
- Supersedes: <D-nnn, ...>
- Superseded by: <D-nnn> -->
```

`templates/questions.md`:

```markdown
# Questions

<!-- ### Q-001 — <question>
- Area: scope | tech | budget | deadline | other
- Owner: client | me
- Blocks spec: yes | no
- Opened in: meetings/<file>.md
- Closed in: - -->
```

`templates/meeting.md`:

```markdown
# <YYYY-MM-DD> — <topic>

## Agenda

## Source
<!-- Notes, transcript or recording reference. -->

## Digest

## Register changes
<!-- D-nnn proposed / Q-nnn opened / Q-nnn closed, one per line. -->
```

`templates/recap.md`:

```markdown
Subject: <topic> — summary of <YYYY-MM-DD>

Hi <name>,

Thanks for today. To make sure we understood each other:

**Agreed**
- <D-nnn: decision>

**Open questions**
- <Q-nnn: question> (<owner>)

**Next steps**
- <who, what, by when>

Please reply to confirm, or correct anything above.
```

- [ ] **Step 2: Failing tests**

`lib/discovery/tests/cli.test.mjs`:

```js
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'discovery.mjs')
const VALID = join(HERE, '..', '..', 'testing', 'fixtures', 'discovery', 'valid')
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

const temps = []
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })
function root() { const d = mkdtempSync(join(tmpdir(), 'brains-')); temps.push(d); return d }
const run = (brains, ...args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TILLER_BRAINS_DIR: brains } })

test('new scaffolds a client brain with git', () => {
  const b = root()
  const r = run(b, 'new', 'acme')
  assert.equal(r.status, 0, r.stderr)
  for (const f of ['client.md', 'decisions.md', 'questions.md', 'meetings', 'recaps', 'spec', '.git']) assert.ok(existsSync(join(b, 'acme', f)), f)
})

test('new --pet omits client.md and recaps', () => {
  const b = root()
  assert.equal(run(b, 'new', 'side', '--pet').status, 0)
  assert.ok(!existsSync(join(b, 'side', 'client.md')))
  assert.ok(!existsSync(join(b, 'side', 'recaps')))
})

test('new refuses an existing brain and changes nothing', () => {
  const b = root()
  run(b, 'new', 'acme')
  writeFileSync(join(b, 'acme', 'client.md'), 'kept')
  const r = run(b, 'new', 'acme')
  assert.equal(r.status, 3)
  assert.equal(readFileSync(join(b, 'acme', 'client.md'), 'utf8'), 'kept')
})

test('a bad name is a usage error', () => {
  assert.equal(run(root(), 'new', 'Acme Corp').status, 2)
})

test('check: 0 on the valid brain, 1 with one line per violation', () => {
  const b = root()
  cpSync(VALID, join(b, 'acme'), { recursive: true })
  assert.equal(run(b, 'check', 'acme', '--spec', join(b, 'acme', 'spec')).status, 0)
  const p = join(b, 'acme', 'decisions.md')
  writeFileSync(p, readFileSync(p, 'utf8').replace('- Superseded by: D-003\n', ''))
  const r = run(b, 'check', 'acme')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /D-002 superseded without Superseded by/)
})

test('check --spec on a missing dir is a usage error', () => {
  const b = root()
  cpSync(VALID, join(b, 'acme'), { recursive: true })
  assert.equal(run(b, 'check', 'acme', '--spec', join(b, 'nope')).status, 2)
})

test('check on a missing brain is a usage error', () => {
  assert.equal(run(root(), 'check', 'ghost').status, 2)
})

test('status prints awaiting, open and readiness', () => {
  const b = root()
  cpSync(VALID, join(b, 'acme'), { recursive: true })
  const r = run(b, 'status', 'acme')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /awaiting confirmation: D-004/)
  assert.match(r.stdout, /open other: Q-002/)
  assert.match(r.stdout, /spec: ready/)
})
```

- [ ] **Step 3: Run, expect failure**

Run: `lib/discovery/run-tests.sh`
Expected: cli tests FAIL (`discovery.mjs` missing); register tests still PASS.

- [ ] **Step 4: Implement `lib/discovery/discovery.mjs`**

```js
#!/usr/bin/env node
// Discovery brains: scaffold one, check its register, report what stands between it and a spec.
//
//   discovery.mjs new <name> [--pet]
//   discovery.mjs check <name> [--spec <dir>]
//   discovery.mjs status <name>
//
// TILLER_BRAINS_DIR replaces <repo>/brains, for tests.
// Exit: 0 done, 1 violations found, 2 usage, 3 refused.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, status } from './register.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRAINS = process.env.TILLER_BRAINS_DIR || join(HERE, '..', '..', 'brains')
const NAME = /^[a-z0-9][a-z0-9-]*$/

function die(code, msg) { console.error(`discovery: ${msg}`); process.exit(code) }
function brainDir(name, mustExist = true) {
  if (!NAME.test(name || '')) die(2, 'brain name: lowercase letters, digits and dashes')
  const dir = join(BRAINS, name)
  if (mustExist && !existsSync(dir)) die(2, `no brain at ${dir}; create it with: discovery.mjs new ${name}`)
  return dir
}

function cmdNew(name, flags) {
  const dir = brainDir(name, false)
  if (existsSync(dir)) die(3, `${dir} already exists; nothing changed`)
  const pet = flags.includes('--pet')
  for (const d of ['meetings', 'spec', ...(pet ? [] : ['recaps'])]) mkdirSync(join(dir, d), { recursive: true })
  for (const f of ['decisions.md', 'questions.md', ...(pet ? [] : ['client.md'])]) copyFileSync(join(HERE, 'templates', f), join(dir, f))
  const git = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  if (git.status !== 0) die(3, `git init failed: ${git.stderr.trim()}`)
  console.log(dir)
}

function cmdCheck(name, flags) {
  const dir = brainDir(name)
  const i = flags.indexOf('--spec')
  let specDir
  if (i >= 0) {
    specDir = flags[i + 1]
    if (!specDir || !existsSync(specDir) || !statSync(specDir).isDirectory()) die(2, `--spec needs an existing directory`)
    specDir = resolve(specDir)
  }
  const out = check(dir, { specDir })
  for (const line of out) console.log(line)
  process.exit(out.length ? 1 : 0)
}

function cmdStatus(name) {
  const s = status(brainDir(name))
  console.log(`awaiting confirmation: ${s.awaiting.join(', ') || '-'}`)
  for (const [area, list] of Object.entries(s.open)) console.log(`open ${area}: ${list.join(', ')}`)
  console.log(s.ready ? 'spec: ready' : `spec: blocked by ${s.blocking.join(', ')}`)
}

const [cmd, name, ...flags] = process.argv.slice(2)
if (cmd === 'new') cmdNew(name, flags)
else if (cmd === 'check') cmdCheck(name, flags)
else if (cmd === 'status') cmdStatus(name)
else die(2, 'usage: discovery.mjs new <name> [--pet] | check <name> [--spec <dir>] | status <name>')
```

- [ ] **Step 5: Run, expect pass**

Run: `lib/discovery/run-tests.sh`
Expected: all PASS.

- [ ] **Step 6: Prove the instrument fails**

Run: `cp -r lib/testing/fixtures/discovery/valid "$TMPDIR/x" && sed -i '' 's/- Supersedes: D-002//' "$TMPDIR/x/decisions.md" && TILLER_BRAINS_DIR="$TMPDIR" node lib/discovery/discovery.mjs check x; echo "exit $?"; rm -rf "$TMPDIR/x"`
Expected: one `D-002 Superseded by D-003, but D-003 does not list it` line, `exit 1`.

- [ ] **Step 7: Commit**

```bash
git add lib/discovery
git commit -m "feat(discovery): add the brain CLI with new, check and status"
```

### Task 3: The skill and docs

Before writing: follow `superpowers:writing-skills` and the executor's own rules for skill text.

**Files:**
- Create: `skills/flow-discovery/SKILL.md`
- Modify: `docs/adding-a-project.md` (new section before `## Scripted path`)
- Modify: `README.md` (Layout block: two lines)

**Interfaces:**
- Consumes: the three CLI commands from Task 2, templates `meeting.md` and `recap.md`.

- [ ] **Step 1: Write `skills/flow-discovery/SKILL.md`**

```markdown
---
name: flow-discovery
description: Agree what a new project is before any code - with a client (prepare a meeting, digest its notes or transcript, draft the recap, record what the client confirmed) or alone for a pet project (a live interview) - and end with a spec and a phased roadmap with deadlines. Keeps a register of decisions and open questions in a brain, so any line of the spec can be traced to when it was agreed and on what evidence. Use when the user starts a new project from scratch, says "new client", "discovery", "kickoff", "prepare the meeting with <client>", "here are the notes from the call", "the client confirmed", "let's spec my side project", or asks what is still open before a spec.
user-invocable: true
---

# flow-discovery

There is no profile-resolution step: the project has no profile yet. Discovery ends where
`flow-onboard-project` begins.

```bash
D="node $TILLER_HOME/lib/discovery/discovery.mjs"
```

## Rules

- **The register is the record.** Every decision is a `D-nnn` in `decisions.md`, every open
  question a `Q-nnn` in `questions.md`, in the format the templates show. Run `$D check <name>`
  after every write; exit 1 lists what to fix, and a session never ends on a failing check.
- **Agreed means the client confirmed.** A decision from a meeting is `proposed`. It becomes
  `agreed` only in **confirm**, with `Confirmed by:` naming the e-mail (date and subject). In a pet
  project the human's answer is the confirmation: `Confirmed by: self`.
- **Never supersede on your own.** When new notes contradict an `agreed` decision, put the
  contradiction to the human with `AskUserQuestion`. Only on their word: a new `D-nnn` with
  `Supersedes:`, the old one `superseded` with `Superseded by:`.
- **Nothing is sent.** Recaps are drafts in `recaps/`; the human sends them.
- **The brain is private, the spec is not.** Nothing from `client.md` (people, politics, budget
  reasoning) goes into the spec; the spec carries what the team building the project needs.
- **One question at a time** when asking the human, through `AskUserQuestion`, recommendation first.

## Discovery areas

Problem and users · how the client operates · functions (must / should / could) · non-functional
requirements · stack and integrations · data and data protection · budget · hard dates · who
accepts and what "done" means · maintenance after launch. A spec is not ready while an area that
matters to this project has an open question with `Blocks spec: yes`.

## Steps

0. **Brain.** `$D new <name>` for a client, `$D new <name> --pet` for a pet project. Exit 3 means
   it exists: carry on with it. The human grants the session access with
   `$TILLER_HOME/lib/brain-access.sh` if the private-access hook denies a read.
1. **prep** (before a meeting). Read `client.md`, `$D status <name>`, and the open questions.
   Copy `lib/discovery/templates/meeting.md` to `meetings/<YYYY-MM-DD>-<slug>.md` and write the
   agenda: blocking questions first, then the discovery areas with nothing recorded yet. Each
   agenda item names the `Q-nnn` it should close or opens one.
2. **digest** (after a meeting). The human gives notes, a transcript or a recording reference.
   Record it under `## Source`, summarise under `## Digest`, then: new decisions as `proposed`,
   questions opened and closed, `client.md` updated, and each change as one line under
   `## Register changes`. Contradictions with `agreed` decisions go to the human (Rules). Draft
   the recap from `templates/recap.md` into `recaps/<YYYY-MM-DD>.md`, listing every `proposed`
   decision and every open question owned by the client.
3. **confirm**. When the human says the client confirmed (or corrected) a recap: confirmed
   decisions get `Status: agreed` and `Confirmed by:`; corrections become new `proposed`
   decisions and go into the next recap.
4. **interview** (pet project). Walk the discovery areas with `AskUserQuestion`, one question at
   a time; record each answer as `agreed`, `Confirmed by: self`, and each "not sure yet" as a
   `Q-nnn` owned by `me`.
5. **spec**. Only when `$D status <name>` prints `spec: ready`. Write `docs/spec.md` and
   `docs/roadmap.md` in the project repo, or in `brains/<name>/spec/` when there is no repo yet.
   Every item cites its `D-nnn`; `proposed` decisions go under `## Unconfirmed`. The roadmap has
   an MVP and later phases, each with an estimate as a range and a date from a `deadline`
   decision. Run `$D check <name> --spec <dir>` until it exits 0. Then hand off in one line each:
   tickets through `flow-write-ticket`, the profile through `flow-onboard-project`.

Each step ends with a commit in the brain (`git -C <brain> commit`), so the register's history
is the history of the conversation.
```

- [ ] **Step 2: `docs/adding-a-project.md`**: insert before `## Scripted path`:

```markdown
## Before the profile

A project that does not exist yet starts with `flow-discovery`: the spec and roadmap are agreed
first, with the client or alone, and recorded in a brain. Onboarding follows once there is a repo.
```

- [ ] **Step 3: `README.md`**: in the Layout block, after the `lib/onboard` line (or after
`lib/new-profile.sh` if there is none):

```
lib/discovery/             discovery brains: new, check, status (flow-discovery)
```

- [ ] **Step 4: Verify**

Run: `lib/discovery/run-tests.sh && lib/leak-guard.sh --staged; git add -A skills/flow-discovery docs/adding-a-project.md README.md && lib/leak-guard.sh --staged`
Expected: tests PASS, leak guard silent with exit 0.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(skills): add flow-discovery"
```

### Task 4: Hand-off outside the repo (no commit)

- [ ] **Step 1:** Give the human the routing row for `~/.claude/CLAUDE.md` (the file is write-protected for the session):

```
| agree a new project's spec, with a client or alone | flow-discovery | superpowers:brainstorming |
```

- [ ] **Step 2:** Install for the human to run: `./install.sh flow-discovery` from the tiller root.
- [ ] **Step 3:** PR only after the brains branch has merged: `git rebase origin/main`, re-run Task 3 Step 4, then `flow-create-pull-request`.
