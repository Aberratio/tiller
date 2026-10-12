import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { CORE, PROFILE, NO_TRACKER, TICKET_SCRIPT, buildArgs, decisionsOf, harness, makeSim, nativeWorktree, runTicket as runWorkflow, runTicketDriver, state, tmpRoot } from './dryrun.mjs'

// FLOW_TARGET=node runs the scenarios through the Node driver.
const NODE = process.env.FLOW_TARGET === 'node'
const runTicket = NODE ? runTicketDriver : runWorkflow
const execLane = NODE ? { skip: 'no exec lane in the driver' } : {}

// The premise lane dispatched a subagent despite the no-dispatch rule. The
// driver's own runtime.mjs (tested separately) enforces this for the Node driver; here it is the
// raw agent() call the workflow script itself makes, so only meaningful on the workflow path.
const workflowOnly = NODE ? { skip: 'disallowedTools is asserted on the raw agent() call, not the driver runtime' } : {}

const fresh = (tag, opts) => { const root = tmpRoot(tag); return { root, args: buildArgs(root, opts) } }
const lanesOf = sim => sim.labels.map(l => l.split(':')[1]).filter(l => l !== 'exec')
const execNames = sim => sim.execs.map(e => e.name)
const runStatus = (root, t) => JSON.parse(readFileSync(join(root, 'tickets', t, 'run.json'), 'utf8'))
const checkpointOutput = (root, t, phase) => {
  const dir = join(root, 'tickets', t, 'checkpoints')
  const file = readdirSync(dir).filter(f => f.endsWith(`-${phase}.json`)).sort().at(-1)
  return JSON.parse(readFileSync(join(dir, file), 'utf8')).output
}

test('happy path on the acme profile merges and records nothing for a human', async () => {
  const { root, args } = fresh('happy')
  const sim = makeSim(root, args)
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(decisionsOf(root).length, 0)
  assert.equal(runStatus(root, 'ABC-1').status, 'merged')
  const names = execNames(sim)
  for (const s of ['worktree.mjs', 'verify-claim.mjs', 'wait-ci.mjs', 'review-bot-green.mjs', 'pr-merge.mjs', 'cleanup.mjs']) assert.ok(names.includes(s), s)
  const bot = sim.execs.find(e => e.name === 'review-bot-green.mjs').argv
  assert.deepEqual(bot.filter((a, i) => bot[i - 1] === '--skip-pattern'), ['Review limit reached', 'Review skipped', 'Draft PR not reviewed'])
  assert.equal(bot[bot.indexOf('--bot') + 1], 'coderabbitai')
  const diff = sim.execs.find(e => e.name === 'diff-since-review.mjs').argv
  assert.ok(diff[diff.indexOf('--out') + 1].startsWith(join(root, 'diffs')), 'diff output under STATE_ROOT')
  assert.ok(sim.execs.some(e => e.name === 'state.mjs' && e.argv[0] === 'phase-done' && e.argv[2] === 'logs'))
  assert.ok(r.calls.every(c => /^[a-z-]+:[a-z-]+:T[0-3]/.test(c.label)))
  assert.ok(r.calls.every(c => ['ok', 'invalid', 'blocked', 'harness-blocked', 'error'].includes(c.outcome)), 'calls[] speaks the phase-spend outcome vocabulary')
  assert.ok(sim.labels.some(l => l.startsWith('pr:owner-proxy:T3:undraft-pr')), 'undraft goes through the owner proxy')
})

test('verify-claim is matched by the repo\'s short name, not the full org/repo slug (the profile keys its test-toolchain table by "acme-web", never by "example-org/acme-web")', async () => {
  const { root, args } = fresh('verify-match')
  const sim = makeSim(root, args)
  await runTicket(sim)
  const call = sim.execs.find(e => e.name === 'verify-claim.mjs' && !e.argv.includes('--section'))
  assert.ok(call, 'verify-claim.mjs should have been invoked')
  assert.equal(call.argv[1], 'acme-web', 'the match argument must be resolvable against a real test-toolchain row')
})

test('a signature path parks ready-to-sign with the PR open', async () => {
  const { root, args } = fresh('sign')
  const sim = makeSim(root, args, { files: ['client-new/lib/pose.ts'] })
  const r = await runTicket(sim)
  assert.equal(r.status, 'ready-to-sign')
  assert.ok(!execNames(sim).includes('pr-merge.mjs'), 'no merge click')
  const d = decisionsOf(root)
  assert.deepEqual(d.map(x => x.kind), ['ready-to-sign'])
  assert.equal(runStatus(root, 'ABC-1').status, 'ready-to-sign')
  assert.equal(r.gate.readyToSign, true)
  assert.equal(state(root, 'open-count').open, 0, 'ready-to-sign is not counted toward the ceiling')
})

// The plan lane wrote docs/plans/<KEY>-<slug>.md into the worktree, the
// run committed it, and that path is in no agent row of the profile, so every PR ended ready-to-sign.
// The runner now names the plan's place in the run state, outside the repo, and nothing else is accepted.
test('the plan lives in the run state: the plan lane is told the path and every later lane reads it from there', async () => {
  const { root, args } = fresh('plan-in-state')
  const prompts = {}
  const sim = makeSim(root, args, { agent: (lane, ctx) => { (prompts[lane] ||= []).push(ctx.prompt) } })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  const target = join(root, 'tickets', 'ABC-1', 'plan.md')
  assert.ok(prompts.plan[0].includes(`Write the plan to exactly ${target}`), `plan prompt:\n${prompts.plan[0]}`)
  assert.ok(!prompts.plan[0].includes('Write the plan into the worktree'), 'the plan lane is no longer told to write into the worktree')
  assert.equal(checkpointOutput(root, 'ABC-1', 'plan').planPath, target)
  assert.ok(prompts.implement[0].includes(`following the plan at ${target}`))
  assert.ok(/never copy it into the worktree or commit it/.test(prompts.implement[0]), 'the implement lane is told the plan stays out of the repo')
  assert.ok(prompts['review-axis'].every(p => p.includes(`against the plan at ${target}`)))
})

for (const [name, returned] of [
  ['a repo-relative docs/plans path', () => 'docs/plans/ABC-1-x.md'],
  // The default worktree sits under STATE_ROOT, so "under the state root" is not "outside the repo".
  ['a docs/plans path inside a worktree under STATE_ROOT', root => join(root, 'worktrees', 'ABC-1-run', 'docs', 'plans', 'ABC-1-x.md')],
]) {
  test(`a plan lane that returns ${name} parks the run before implement, naming both paths`, async () => {
    const { root, args } = fresh('plan-elsewhere')
    const sim = makeSim(root, args, { agent: lane => lane === 'plan' ? { planPath: returned(root) } : undefined })
    const r = await runTicket(sim)
    assert.equal(r.status, 'parked', JSON.stringify(r))
    assert.ok(r.reason.includes(returned(root)) && r.reason.includes(join(root, 'tickets', 'ABC-1', 'plan.md')), r.reason)
    assert.ok(!lanesOf(sim).includes('implement'), 'nothing is implemented against a plan the runner cannot place')
  })
}

// Fail-closed stays: a plan file that reaches the PR anyway is still a path the profile lists for nobody.
test('a docs/plans file in the PR still holds the merge for a signature', async () => {
  const { root, args } = fresh('plan-in-pr')
  const sim = makeSim(root, args, { files: ['server-new/a.ts', 'docs/plans/ABC-1-x.md'] })
  const r = await runTicket(sim)
  assert.equal(r.status, 'ready-to-sign', JSON.stringify(r))
  assert.ok(!execNames(sim).includes('pr-merge.mjs'))
})

const capFinding = (severity, location) => (lane, ctx) => lane === 'review-axis' && ctx.detail.startsWith('standards')
  ? { findings: [{ id: 'S1', axis: 'standards', severity, summary: 'leak in the pose buffer', locations: [location] }], stillOpen: ['S1'] }
  : undefined

// P2 (09 §3 cause 2): the cap used to park before the PR, so a real residual finding cost the whole
// run. The findings now travel to the PR and the gate holds the merge on them.
test('fix-round cap: open findings are recorded, travel to the PR body and hold the gate; no third round', async () => {
  const { root, args } = fresh('cap')
  const sim = makeSim(root, args, { agent: capFinding('high', 'server-new/a.ts:1') })
  const r = await runTicket(sim)
  assert.equal(lanesOf(sim).filter(l => l === 'fix').length, 2)
  assert.equal(runStatus(root, 'ABC-1').counters.fixRounds, 2)
  const d = decisionsOf(root)
  assert.deepEqual(d.map(x => x.kind), ['split', 'gate-red'])
  assert.match(d[0].question, /S1/)
  assert.ok(execNames(sim).includes('pr-open.mjs'), 'the run reaches the PR')
  const body = readFileSync(join(root, 'tickets', 'ABC-1', 'pr-body.md'), 'utf8')
  assert.match(body.split('\n').slice(0, 5).join('\n'), /^## Open review findings/, 'the findings open the PR body')
  assert.match(body, /S1.*high.*leak in the pose buffer.*server-new\/a\.ts:1/)
  assert.ok(lanesOf(sim).includes('confidence-dim'), 'confidence still runs')
  const review = r.gate.conditions.find(c => c.name === 'review')
  assert.equal(review.state, 'red')
  assert.match(review.evidence, /S1/)
  assert.ok(!execNames(sim).includes('pr-merge.mjs'), 'an open finding never merges')
  assert.equal(r.status, 'parked')
  assert.equal(r.prUrl, 'https://forge.test/pr/7')
  assert.equal(runStatus(root, 'ABC-1').status, 'parked')
})

test('fix-round cap: a finding an axis re-lists on every pass is carried once', async () => {
  const { root, args } = fresh('cap-dup')
  const again = { id: 'S1', axis: 'spec', severity: 'high', summary: 'leak in the pose buffer', locations: ['server-new/a.ts:1'] }
  const sim = makeSim(root, args, { agent: (lane, ctx) => lane === 'review-axis' && ctx.detail.startsWith('spec') ? { findings: [again], stillOpen: ['S1'] } : undefined })
  const r = await runTicket(sim)
  const body = readFileSync(join(root, 'tickets', 'ABC-1', 'pr-body.md'), 'utf8')
  assert.equal(body.match(/`S1`/g).length, 1)
  assert.equal(r.gate.conditions.find(c => c.name === 'review').evidence, 'S1')
})

test('fix-round cap: a blocker on an agent-merged path still goes to the PR', async () => {
  const { root, args } = fresh('cap-blocker-agent')
  const sim = makeSim(root, args, { agent: capFinding('blocker', 'server-new/a.ts:3') })
  const r = await runTicket(sim)
  assert.ok(execNames(sim).includes('pr-open.mjs'))
  assert.equal(r.gate.conditions.find(c => c.name === 'review').state, 'red')
})

test('fix-round cap: a blocker on a path that needs a signature parks before the PR', async () => {
  const { root, args } = fresh('cap-blocker-sign')
  const sim = makeSim(root, args, { files: ['client-new/lib/pose.ts'], agent: capFinding('blocker', 'client-new/lib/pose.ts:12') })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.match(r.reason, /blocker.*client-new\/lib\/pose\.ts/)
  assert.ok(!execNames(sim).includes('pr-open.mjs'), 'no PR for a regulated-path blocker')
  assert.deepEqual(decisionsOf(root).map(x => x.kind), ['split'])
})

// A finding about the harness says nothing a fix agent can repair (a fix agent once "fixed" one by
// editing plan text), so it goes to `blocked`, never to a fix round.
test('a review finding sourced from the harness goes to blocked, never to a fix round', async () => {
  const { root, args } = fresh('harness-finding')
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => lane === 'review-axis' && ctx.detail === 'spec'
      ? { findings: [{ id: 'SPEC-9', axis: 'spec', severity: 'blocker', summary: 'verify-claim could not run the test command', locations: [], source: 'verify-claim' }] }
      : undefined,
  })
  const r = await runTicket(sim)
  assert.ok(!lanesOf(sim).includes('fix'), 'no fix lane for a harness finding')
  assert.equal(runStatus(root, 'ABC-1').counters.fixRounds, 0)
  assert.ok(execNames(sim).includes('pr-open.mjs'), 'the run reaches the PR')
  const cond = r.gate.conditions.find(c => c.name === 'harness')
  assert.equal(cond && cond.state, 'blocked')
  assert.match(cond.evidence, /SPEC-9/)
  assert.ok(!execNames(sim).includes('pr-merge.mjs'))
})

test('a confidence finding sourced from the harness goes to blocked, never to a fix', async () => {
  const { root, args } = fresh('harness-confidence')
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => lane === 'confidence-dim' && ctx.detail === 'correctness'
      ? { findings: [{ id: 'C9', axis: 'correctness', severity: 'high', summary: 'exec lane refused the test run', locations: [], source: 'exec' }] }
      : lane === 'reverify' ? { verdict: 'confirmed' } : undefined,
  })
  const r = await runTicket(sim)
  assert.ok(!lanesOf(sim).includes('fix'))
  assert.equal(r.gate.conditions.find(c => c.name === 'harness').state, 'blocked')
})

test('every fix prompt forbids editing plan or spec text to satisfy a harness finding', async () => {
  const { root, args } = fresh('fix-guard')
  const prompts = []
  let calls = 0
  const sim = makeSim(root, args, {
    exec: (name, argv) => name === 'verify-claim.mjs' && !argv.includes('--section') && calls++ === 0
      ? { status: 'ok', command: 'npm test', claim: 'pass', actual: 'fail', exitCode: 1, mismatch: true } : undefined,
    agent: (lane, ctx) => { if (lane === 'fix') prompts.push(ctx.prompt) },
  })
  await runTicket(sim)
  assert.ok(prompts.length)
  for (const p of prompts) assert.match(p, /never edit the plan, the spec or the ticket text/i)
})

const staticRuns = sim => sim.execs.filter(e => e.name === 'verify-claim.mjs' && e.argv.includes('static checks'))
const staticResult = (check, over) => ({ status: 'ok', match: check, command: `npm run ${check}`, claim: 'pass', actual: 'pass', exitCode: 0, mismatch: false, ...over })

test('the profile static checks run once through verify-claim before the review axes, and the axes are told what they cover', async () => {
  const { root, args } = fresh('static')
  const axisPrompts = []
  const sim = makeSim(root, args, { agent: (lane, ctx) => { if (lane === 'review-axis' && ctx.phase === 'review') axisPrompts.push(ctx.prompt) } })
  const r = await runTicket(sim)
  assert.deepEqual(staticRuns(sim).map(e => e.argv[1]), ['typecheck', 'lint', 'test'])
  const firstAxis = sim.labels.findIndex(l => l.startsWith('review:review-axis'))
  const lastStatic = sim.labels.lastIndexOf(staticRuns(sim).at(-1).label)
  assert.ok(lastStatic < firstAxis, 'checks before axes')
  assert.ok(axisPrompts.length)
  for (const p of axisPrompts) {
    assert.match(p, /typecheck: green/)
    assert.match(p, /do not raise/i)
  }
  assert.equal(r.gate.conditions.find(c => c.name === 'static-checks').state, 'green')
})

test('a static check that cannot run is blocked with kind toolchain, never a fix round', async () => {
  const { root, args } = fresh('static-blocked')
  const sim = makeSim(root, args, {
    exec: (name, argv) => name === 'verify-claim.mjs' && argv[1] === 'lint'
      ? { status: 'blocked', kind: 'toolchain', command: 'cd client-new && npm run lint', exitCode: 127, reason: 'lint could not run (exit 127: not found)' } : undefined,
  })
  const r = await runTicket(sim)
  assert.ok(!lanesOf(sim).includes('fix'))
  const cond = r.gate.conditions.find(c => c.name === 'static-checks')
  assert.equal(cond.state, 'blocked')
  assert.match(cond.evidence, /lint.*toolchain/)
  assert.ok(!execNames(sim).includes('pr-merge.mjs'))
})

test('a failing static check goes to a fix round and is re-run after it', async () => {
  const { root, args } = fresh('static-red')
  let lint = 0
  const fixPrompts = []
  const sim = makeSim(root, args, {
    exec: (name, argv) => name === 'verify-claim.mjs' && argv[1] === 'lint' && lint++ === 0
      ? staticResult('lint', { actual: 'fail', exitCode: 1, mismatch: true }) : undefined,
    agent: (lane, ctx) => { if (lane === 'fix') fixPrompts.push(ctx.prompt) },
  })
  const r = await runTicket(sim)
  assert.equal(lanesOf(sim).filter(l => l === 'fix').length, 1)
  assert.match(fixPrompts[0], /static-lint/)
  assert.equal(staticRuns(sim).filter(e => e.argv[1] === 'lint').length, 2)
  assert.equal(r.gate.conditions.find(c => c.name === 'static-checks').state, 'green')
})

// The acme profile declares a real `## worktree setup` row (`cd client-new && npm ci`); an
// "absent section" variant drops it, to prove the no-op default other profiles get.
const setupRuns = sim => sim.execs.filter(e => e.name === 'verify-claim.mjs' && e.argv.includes('worktree setup'))
const noSetupProfile = root => {
  const text = readFileSync(PROFILE, 'utf8').replace(/## worktree setup\n\n[\s\S]*?\n\n(?=## static checks)/, '')
  const path = join(root, 'acme-no-setup.md')
  writeFileSync(path, text)
  return path
}

// `## worktree` names the repo's own worktree command (acme: `bin/worktree new <branch>`).
const worktreeProfile = (root, section) => {
  const text = readFileSync(PROFILE, 'utf8').replace(/## worktree\n\n[\s\S]*?\n\n(?=## )/, '')
    .replace('## worktree setup', section ? `## worktree\n\n${section}\n\n## worktree setup` : '## worktree setup')
  const path = join(root, 'acme-worktree.md')
  writeFileSync(path, text)
  return path
}
const worktreeCall = sim => sim.execs.find(e => e.name === 'worktree.mjs').argv

test('a profile worktree Create command creates the worktree through it, and the run continues where git put it', async () => {
  const root = tmpRoot('wt-native')
  const args = buildArgs(root, { profile: worktreeProfile(root, '- Create: `bin/worktree new <branch>`') })
  const sim = makeSim(root, args)
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  const argv = worktreeCall(sim)
  assert.equal(argv[argv.indexOf('--command') + 1], 'bin/worktree new <branch>')
  assert.equal(argv[argv.indexOf('--repo') + 1], args.facts.repos[0].path, 'run from the main checkout')
  assert.ok(!argv.includes('--dir'), 'the repo command decides the directory')
  const wt = nativeWorktree(args.branch)
  assert.equal(checkpointOutput(root, 'ABC-1', 'start').worktree, wt)
  const setup = setupRuns(sim)[0].argv
  assert.equal(setup[setup.indexOf('--cwd') + 1], wt, 'worktree setup runs in the worktree the command made')
  const diff = sim.execs.find(e => e.name === 'diff-since-review.mjs').argv
  assert.ok(diff.includes(wt), 'later phases work in it too')
})

test('without a worktree Create command the runner makes a plain worktree at its own --dir', async () => {
  const root = tmpRoot('wt-plain')
  const args = buildArgs(root, { profile: worktreeProfile(root, null) })
  const sim = makeSim(root, args)
  await runTicket(sim)
  const argv = worktreeCall(sim)
  assert.ok(!argv.includes('--command'))
  assert.equal(argv[argv.indexOf('--dir') + 1], join(args.worktreeRoot, args.branch))
})

test('an absent worktree setup section runs nothing and reports green, "none declared"', async () => {
  const root = tmpRoot('setup-absent')
  const args = buildArgs(root, { profile: noSetupProfile(root) })
  const sim = makeSim(root, args)
  const r = await runTicket(sim)
  assert.equal(setupRuns(sim).length, 0)
  const cond = r.gate.conditions.find(c => c.name === 'worktree-setup')
  assert.equal(cond.state, 'green')
  assert.match(cond.evidence, /none declared/)
})

test('worktree setup runs once via verify-claim right after the worktree is created, before premise', async () => {
  const { root, args } = fresh('setup-runs')
  const sim = makeSim(root, args)
  const r = await runTicket(sim)
  const runs = setupRuns(sim)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].argv[1], 'install')
  const premiseIdx = sim.labels.findIndex(l => l.startsWith('premise:'))
  assert.ok(sim.labels.indexOf(runs[0].label) < premiseIdx, 'setup runs before premise')
  assert.equal(r.gate.conditions.find(c => c.name === 'worktree-setup').state, 'green')
})

test('a worktree setup command that cannot run is blocked, kind toolchain — not a hard park at start, ' +
  'but same as a blocked static check it withholds the merge', async () => {
  const { root, args } = fresh('setup-blocked')
  const sim = makeSim(root, args, {
    exec: (name, argv) => name === 'verify-claim.mjs' && argv.includes('worktree setup')
      ? { status: 'blocked', kind: 'toolchain', command: 'cd client-new && npm ci', exitCode: 127, reason: 'install could not run (exit 127: not found)' } : undefined,
  })
  const r = await runTicket(sim)
  assert.ok(execNames(sim).includes('review-bot-green.mjs'), 'setup blocked does not stop the run short of CI/review-bot, unlike a worktree.mjs failure')
  assert.ok(!execNames(sim).includes('pr-merge.mjs'), 'a blocked gate condition still withholds the merge')
  const cond = r.gate.conditions.find(c => c.name === 'worktree-setup')
  assert.equal(cond.state, 'blocked')
  assert.match(cond.evidence, /install.*toolchain/)
})

// An exec whose checks fail after the write landed is retried; the retry must not count twice.
test('a retried counter increment is counted once', execLane, async () => {
  const { root, args } = fresh('keyed-inc')
  let lost = 0
  const sim = makeSim(root, args, {
    exec: (name, argv) => {
      if (name !== 'state.mjs' || argv[0] !== 'counter' || argv[2] !== 'confidencePasses' || lost++) return undefined
      state(root, ...argv)
      return { raw: { ran: true, exitCode: 0, stdout: 'not json\n' } }
    },
  })
  await runTicket(sim)
  assert.equal(runStatus(root, 'ABC-1').counters.confidencePasses, 1)
  const keyed = sim.execs.filter(e => e.name === 'state.mjs' && e.argv[0] === 'counter' && e.argv.includes('--inc'))
  assert.ok(keyed.length && keyed.every(e => /^[^:]+:[a-z-]+:\d+$/.test(e.argv[e.argv.indexOf('--key') + 1])), 'every increment carries <runId>:<phase>:<seq>')
})

// A run parked on the fix-round cap, and run.json still read `running`
// afterwards — the separate status write had gone through an exec call that failed its checks.
test('a park leaves a terminal run.json even when the separate status write is lost', async () => {
  const { root, args } = fresh('park-terminal')
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => lane === 'review-axis' && ctx.detail.startsWith('standards')
      ? { findings: [{ id: 'S1', axis: 'standards', severity: 'blocker', summary: 'leak', locations: ['client-new/lib/pose.ts:1'] }], stillOpen: ['S1'] }
      : undefined,
    files: ['client-new/lib/pose.ts'],
    exec: (name, argv) => name === 'state.mjs' && argv.join(' ').includes('set-status') && argv.join(' ').includes('parked')
      ? { raw: { ran: true, exitCode: 0, stdout: 'not a script-result line' } } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  const run = runStatus(root, 'ABC-1')
  assert.equal(run.status, 'parked')
  assert.equal(run.reason, r.reason)
})

test('a park in the merge phase writes parked, not the open-pr status the pr phase left', async () => {
  const { root, args } = fresh('merge-park-terminal')
  const sim = makeSim(root, args, {
    exec: name => name === 'pr-merge.mjs' ? { status: 'refused', kind: 'refused', reason: 'branch protection' } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  const run = runStatus(root, 'ABC-1')
  assert.equal(run.status, 'parked')
  assert.ok(run.reason, 'a park names its reason in run.json')
})

test('the start phase checks for another run\'s PR or branch before it creates the worktree, excluding a given own branch', async () => {
  const { root, args } = fresh('dup-order', { extra: ['--branch', 'ABC-1-given'] })
  const sim = makeSim(root, args)
  await runTicket(sim)
  const names = execNames(sim)
  assert.ok(names.includes('duplicate-guard.mjs'), 'the guard runs')
  assert.ok(names.indexOf('duplicate-guard.mjs') < names.indexOf('worktree.mjs'), 'before the worktree')
  const g = sim.execs.find(e => e.name === 'duplicate-guard.mjs')
  const opt = k => g.argv[g.argv.indexOf(k) + 1]
  assert.equal(opt('--key'), 'ABC-1')
  assert.equal(opt('--repo'), args.facts.repos[0].repo)
  assert.equal(opt('--repo-path'), args.facts.repos[0].path)
  assert.equal(opt('--own-branch'), args.branch)
})

// A run duplicated a ticket whose PR had already merged.
test('a ticket another run already delivered parks at start with the existing PR named, and creates nothing', async () => {
  const { root, args } = fresh('dup-refused')
  const reason = 'duplicate: ABC-1 already has merged PR #502 (https://forge.test/pull/502, branch ABC-1-run-38dcd7cc) from another run'
  const sim = makeSim(root, args, {
    exec: name => name === 'duplicate-guard.mjs'
      ? { status: 'refused', kind: 'duplicate', reason, key: 'ABC-1', prs: [{ number: 228, state: 'MERGED', headRefName: 'ABC-1-run-38dcd7cc', url: 'https://forge.test/pull/502' }], branches: [] }
      : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.match(r.reason, /#502/)
  assert.match(r.reason, /duplicate/)
  const run = runStatus(root, 'ABC-1')
  assert.equal(run.status, 'parked')
  assert.match(run.reason, /#502/)
  assert.ok(!execNames(sim).includes('worktree.mjs'), 'no worktree')
  assert.ok(!lanesOf(sim).some(l => ['premise', 'plan', 'implement'].includes(l)), 'no lane after start')
  const d = decisionsOf(root)
  assert.deepEqual(d.map(x => x.kind), ['duplicate'])
  assert.match(d[0].question, /#502/)
  assert.ok(!lanesOf(sim).some(l => ['resolver', 'owner-proxy'].includes(l)), 'a duplicate goes to neither resolver nor proxy')
  const decideOp = sim.execs.filter(e => e.name === 'state.mjs').flatMap(e => e.argv[0] === 'batch' ? JSON.parse(e.argv[1]) : [e.argv]).find(op => op[0] === 'decide')
  assert.ok(!decideOp.includes('--ledger'), 'no ledger write into a worktree that was never created')
})

test('a guard refusal that is not a duplicate parks as a guard failure, with no duplicate decision', async () => {
  const { root, args } = fresh('dup-usage')
  const sim = makeSim(root, args, {
    exec: name => name === 'duplicate-guard.mjs' ? { status: 'refused', kind: 'policy', reason: 'usage: --repo <owner/repo> --repo-path <path> --key <KEY>' } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.match(r.reason, /^duplicate-guard: usage/)
  assert.ok(!execNames(sim).includes('worktree.mjs'), 'no worktree')
  assert.deepEqual(decisionsOf(root).map(x => x.kind), [])
})

test('a duplicate guard that cannot look parks the run instead of starting it', async () => {
  const { root, args } = fresh('dup-error')
  const sim = makeSim(root, args, {
    exec: name => name === 'duplicate-guard.mjs' ? { status: 'error', kind: 'script-error', reason: 'gh pr list failed' } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.match(r.reason, /gh pr list failed/)
  assert.ok(!execNames(sim).includes('worktree.mjs'), 'no worktree')
})

test('an uncaught error still leaves run.json terminal (died) before the run fails', async () => {
  const { root, args } = fresh('died-terminal')
  const sim = makeSim(root, args, { skipLaneCheck: true, agent: lane => lane === 'implement' ? { commits: 7 } : undefined })
  await assert.rejects(runTicket(sim))
  const run = runStatus(root, 'ABC-1')
  assert.equal(run.status, 'died')
  assert.match(run.reason, /TypeError|undefined/)
})

// Runs parked on a falsified premise with the ticket already moved.
test('a falsified premise leaves the tracker untouched: no transition is asked for', async () => {
  const { root, args } = fresh('premise-no-move')
  const prompts = []
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => { prompts.push([ctx.detail, ctx.prompt]); return lane === 'premise' ? { verdict: 'falsified', evidence: 'no such code', awaiting: [] } : undefined },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.ok(!sim.labels.some(l => l.startsWith('premise:') && /tracker/.test(l)), sim.labels.join(' '))
  const status = args.facts.tracker.startStatus
  assert.ok(status)
  assert.ok(prompts.every(([, p]) => !p.includes(`"${status}"`)), 'no lane was told to move the ticket')
})

test('a premise that holds moves the ticket in a separate call after the verdict', async () => {
  const { root, args } = fresh('premise-move')
  const prompts = []
  const sim = makeSim(root, args, { agent: (lane, ctx) => { if (lane === 'premise') prompts.push([ctx.detail, ctx.prompt]) } })
  await runTicket(sim)
  const status = args.facts.tracker.startStatus
  assert.deepEqual(prompts.map(([d]) => d), ['ticket', 'tracker'])
  assert.ok(!prompts[0][1].includes(`"${status}"`), 'the premise check itself writes nothing')
  assert.ok(prompts[1][1].includes(`"${status}"`))
})

test('premise lane dispatched a subagent despite no-dispatch: every judgment and exec lane call denies Agent, Task and Workflow', workflowOnly, async () => {
  const { root, args } = fresh('dispatch-deny')
  const sim = makeSim(root, args)
  await runTicket(sim)
  assert.ok(sim.agentOpts.length > 5)
  for (const o of sim.agentOpts) for (const t of ['Agent', 'Task', 'Workflow']) assert.ok((o.disallowedTools || []).includes(t), `${o.label}: ${t}`)
})

test('a falsified premise carries its full evidence into the decision, not clipped below decide()\'s own 1000-char cap', async () => {
  const { root, args } = fresh('premise-falsified')
  const longEvidence = 'src/a.js:1 does X. '.repeat(60) // > 1000 chars, well past the old 400-char default clip
  const sim = makeSim(root, args, {
    agent: lane => lane === 'premise' ? { verdict: 'falsified', evidence: longEvidence, awaiting: [] } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  const d = decisionsOf(root)
  assert.equal(d.length, 1)
  assert.equal(d[0].kind, 'premise')
  assert.ok(d[0].why.length > 400, `why should not be clipped to the 400-char default; got ${d[0].why.length} chars`)
  assert.ok(longEvidence.startsWith(d[0].why.slice(0, 900)), 'why is a true, uncut-mid-sentence prefix of the evidence up to decide()\'s own cap')
})

// A resumed plan turn returned an awaiting item with no reversalCost —
// schema-valid (lane-plan.json's awaiting.reversalCost is optional, only decision.json requires
// it), but the checkpoint's decide() call is validated against decision.json, refused, and parked
// the whole run before implement/review ever ran. A live agent() call enforces the looser schema,
// so this can and did happen for real; decide() must not let a missing field kill the run.
test('an awaiting item missing reversalCost does not park the run at the checkpoint', async () => {
  const { root, args } = fresh('awaiting-no-reversal')
  const sim = makeSim(root, args, {
    skipLaneCheck: true,
    agent: lane => lane === 'plan' ? {
      ok: true, ticketKind: 'code', premiseVerdict: 'holds', planSummary: 'plan',
      authorisedFiles: ['server-new/'],
      awaiting: [{ kind: 'question', question: 'dev-image gap', why: 'git missing in the front-new image',
        blocks: 'closing this decision', options: ['leave it', 'fold into this ticket'], recommendation: 'leave it' }],
    } : undefined,
  })
  const r = await runTicket(sim)
  assert.notEqual(r.status, 'parked', JSON.stringify(r))
  const d = decisionsOf(root)
  const dev = d.find(x => x.question === 'dev-image gap')
  assert.ok(dev, 'the awaiting item must still be recorded as a decision')
  if (NODE) {
    assert.equal(dev.reversalCost, undefined, 'the Node driver never invents a reversal cost')
    assert.ok(dev.violations.some(v => v.startsWith('L03')), `the missing reversal cost is listed: ${dev.violations}`)
  } else assert.ok(dev.reversalCost, 'the recorded decision must carry a reversalCost, never omit it silently')
})

// A confidence-phase resolver dispatch returned an awaiting item with a
// completely empty options array. decide()'s existing pad-to-two logic only ever appends ONE
// filler, so zero options in still meant one option out — one short of decision.json's own
// "needs at least two options" rule — and the checkpoint's decide-batch call was refused all
// over again, parking the run at "stdout is not a script-result line" after exhausting the exec
// lane's retries on a command that could never succeed. Padding must reach two, not just grow by one.
test('an awaiting item with zero options is padded to two by the Workflow script, listed as violations by the Node driver', async () => {
  const { root, args } = fresh('awaiting-zero-options')
  const sim = makeSim(root, args, {
    skipLaneCheck: true,
    agent: lane => lane === 'plan' ? {
      ok: true, ticketKind: 'code', premiseVerdict: 'holds', planSummary: 'plan',
      authorisedFiles: ['server-new/'],
      awaiting: [{ kind: 'question', question: 'no alternative was offered', why: 'the lane found only one path',
        blocks: 'closing this decision', options: [], recommendation: 'proceed' }],
    } : undefined,
  })
  const r = await runTicket(sim)
  assert.notEqual(r.status, 'parked', JSON.stringify(r))
  const d = decisionsOf(root)
  const dec = d.find(x => x.question === 'no alternative was offered')
  assert.ok(dec, 'the awaiting item must still be recorded as a decision')
  if (NODE) {
    assert.equal(dec.options, undefined, 'the Node driver never pads options')
    assert.ok(dec.violations.length, 'the broken rules are listed instead')
  } else assert.ok(Array.isArray(dec.options) && dec.options.length >= 2, `options must be padded to at least two; got ${JSON.stringify(dec.options)}`)
})

test('harness-blocked: one identical retry, then a decision with no options that is never counted', execLane, async () => {
  const { root, args } = fresh('blocked')
  const sim = makeSim(root, args, { exec: name => name === 'pr-open.mjs' ? { denied: 'Permission to use Bash has been denied.' } : undefined })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.equal(sim.execs.filter(e => e.name === 'pr-open.mjs').length, 2)
  const d = decisionsOf(root)
  assert.equal(d.length, 1)
  assert.equal(d[0].kind, 'harness-blocked')
  assert.equal(d[0].options, undefined)
  assert.ok(!sim.labels.some(l => l.includes(':resolver:')), 'never asked to anyone')
  assert.equal(state(root, 'open-count').open, 0)
})

test('harness-blocked: the park reason breaks on a word boundary and run.json keeps the full denial as reasonFull', execLane, async () => {
  const longDenial = 'Permission to use Bash has been denied because the sandboxed filesystem refused the write to a path outside the worktree root, which the harness classifies as a policy violation rather than a transient infrastructure error.'
  const { root, args } = fresh('blocked-long')
  const sim = makeSim(root, args, { exec: name => name === 'pr-open.mjs' ? { denied: longDenial } : undefined })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked', JSON.stringify(r))
  const kept = r.reason.replace(/^harness-blocked: /, '')
  assert.ok(kept.length <= 201, `reason is short: ${JSON.stringify(r.reason)}`)
  assert.ok(kept.endsWith('…'), 'the short reason is marked as cut')
  assert.ok(longDenial.startsWith(kept.replace(/…$/, '')), 'the kept prefix is verbatim and word-aligned')
  assert.ok(r.reasonFull.includes(longDenial), 'the full denial text is preserved verbatim on the result')
  assert.equal(runStatus(root, 'ABC-1').reasonFull, r.reasonFull, 'run.json keeps the same full text')
})

// A live run: implement finished green with commits but carried environment notes labelled
// harness-blocked (a missing env file, a sandboxed spawn). No tool call was refused, yet the lane
// was re-run identically and the run parked before CI.
const ENV_NOTE = {
  kind: 'harness-blocked',
  question: 'Confirm the three full-suite failures in the front-new container before merge',
  why: 'Repo rule: a failing frontend test is not believed until it fails in the container; no `.env.worktree` (`ls: .env.worktree: No such file or directory`)',
  blocks: 'Nothing on this branch; the merge only',
  options: ['Accept them as environment artifacts', 'Hold the merge'],
  recommendation: 'Accept them as environment artifacts; confirm in the container at PR time',
}
const SPAWN_NOTE = { kind: 'harness-blocked', question: 'git and npm could not be spawned', why: 'Error: spawnSync git EPERM; Error: spawnSync npm EPERM', blocks: 'nothing' }
const implementWith = awaiting => (lane, ctx) => lane === 'implement'
  ? { ok: true, headSha: ctx.nextSha(), commits: ['c1', 'c2'], testCommand: 'npm test', testResult: 'pass', awaiting }
  : undefined

test('an ok implement lane whose awaiting[] carries environment notes is neither retried nor parked', async () => {
  const { root, args } = fresh('env-notes')
  const sim = makeSim(root, args, { files: ['client-new/lib/pose.ts'], skipLaneCheck: true, agent: implementWith([ENV_NOTE, SPAWN_NOTE]) })
  const r = await runTicket(sim)
  assert.equal(lanesOf(sim).filter(l => l === 'implement').length, 1, 'no identical retry')
  assert.ok(!decisionsOf(root).some(d => d.kind === 'harness-blocked'), JSON.stringify(decisionsOf(root)))
  assert.ok(execNames(sim).includes('pr-open.mjs'), `the run reaches the PR; got ${r.status} ${r.reason || ''}`)
  assert.equal(r.status, 'ready-to-sign', JSON.stringify(r.gate && r.gate.conditions))
  const body = readFileSync(join(root, 'tickets', 'ABC-1', 'pr-body.md'), 'utf8')
  assert.match(body, /## Environment notes/)
  assert.match(body, /\.env\.worktree: No such file or directory/, 'the note text is kept')
  assert.match(body, /spawnSync git EPERM/)
  const cond = r.gate.conditions.find(c => c.name === 'environment')
  assert.equal(cond && cond.state, 'green')
  assert.match(cond.evidence, /2 note/)
})

test('environment notes survive a resume past the phase that raised them', async () => {
  const { root, args } = fresh('env-notes-resume')
  const first = makeSim(root, args, { skipLaneCheck: true, agent: (lane, ctx) => lane === 'review-axis' ? { hang: true } : implementWith([ENV_NOTE])(lane, ctx) })
  assert.ok((await runTicket(first)).killed)
  // The worktree outlives the kill, so the rerun measures the head the first run left in it.
  const second = makeSim(root, args)
  Object.assign(second.heads, first.heads)
  const r = await runTicket(second)
  assert.ok(!lanesOf(second).includes('implement'), second.labels.join(' '))
  assert.match(readFileSync(join(root, 'tickets', 'ABC-1', 'pr-body.md'), 'utf8'), /\.env\.worktree: No such file or directory/)
  assert.match(r.gate.conditions.find(c => c.name === 'environment').evidence, /1 note/)
})

test('a quoted refusal inside an ok lane reaches the PR and holds the merge on the environment condition', async () => {
  const { root, args } = fresh('ok-refusal')
  const refusal = { kind: 'harness-blocked', question: 'the container test run was refused', why: 'Permission to use Bash has been denied.', blocks: 'the container confirmation' }
  const sim = makeSim(root, args, { agent: implementWith([refusal]) })
  const r = await runTicket(sim)
  assert.equal(lanesOf(sim).filter(l => l === 'implement').length, 1)
  assert.ok(execNames(sim).includes('pr-open.mjs'), `the run reaches the PR; got ${r.status} ${r.reason || ''}`)
  assert.ok(!execNames(sim).includes('pr-merge.mjs'), 'the merge stays withheld')
  const cond = r.gate.conditions.find(c => c.name === 'environment')
  assert.equal(cond && cond.state, 'blocked')
  assert.match(cond.evidence, /Permission to use Bash has been denied/)
})

test('a quoted refusal on a lane that did not finish keeps one identical retry, then parks', async () => {
  const { root, args } = fresh('refusal-not-ok')
  const refusal = { kind: 'harness-blocked', question: 'the worktree write was refused', why: 'Permission to use Bash has been denied.', blocks: 'implement' }
  const sim = makeSim(root, args, { skipLaneCheck: true, agent: lane => lane === 'implement' ? { ok: false, commits: [], awaiting: [refusal] } : undefined })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.equal(lanesOf(sim).filter(l => l === 'implement').length, 2)
  const d = decisionsOf(root)
  assert.deepEqual(d.map(x => x.kind), ['harness-blocked'])
  assert.match(d[0].why, /Permission to use Bash has been denied/)
})

test('summary and prose lanes cannot raise decisions: their awaiting[] is kept as notes', async () => {
  const { root, args } = fresh('prose-awaiting')
  const question = { kind: 'question', question: 'Should the title say fix?', why: 'the diff fixes a bug', blocks: 'nothing', options: ['fix', 'chore'], recommendation: 'fix', reversalCost: 'low' }
  const env = { kind: 'harness-blocked', question: 'Container-based node v22 run could not be completed', why: "Repo rule: 'A failing frontend test is not believed until it fails in the container'", blocks: 'nothing' }
  const sim = makeSim(root, args, { skipLaneCheck: true, agent: lane => lane === 'pr-description' ? { title: '[ABC-1] fix: change', body: 'Body.', awaiting: [question] }
    : lane === 'log-prose' ? { text: 'Run summary.', awaiting: [env] } : undefined })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(decisionsOf(root).length, 0, JSON.stringify(decisionsOf(root)))
  assert.equal(lanesOf(sim).filter(l => l === 'log-prose').length, 1, 'no identical retry of a summary lane')
  assert.equal(lanesOf(sim).filter(l => l === 'pr-description').length, 1)
})

test('a real exec success is not thrown away when the model echoes the command with different quoting', execLane, async () => {
  const { root, args } = fresh('quote-echo')
  const sim = makeSim(root, args, {
    exec: (name, sargs, ctx) => {
      if (name !== 'resume') return undefined
      // A real, successful `harness.mjs resume` result, echoed back with the quoting stripped —
      // exactly what a live model does; it is not a different command, just a different rendering.
      const unquoted = ctx.prompt.split('nothing else: ')[1].split('\nReturn JSON')[0].replace(/'/g, '')
      return { raw: { command: unquoted, ran: true, exitCode: 0, stdout: JSON.stringify({
        status: 'ok', ticket: 'ABC-1', clean: true, startPhase: 'start', outputs: {}, resumes: 0, cap: 2, capReached: false, runStatus: 'running', prUrl: null,
      }) } }
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(sim.execs.filter(e => e.name === 'resume').length, 1, 'the real success is accepted on the first attempt, not retried three times')
  assert.equal(decisionsOf(root).length, 0)
})

// A pr-body write echoed a real, successful command back with its literal
// newlines rendered as the two-character sequence \n instead of an actual line break — a live
// model's structured-output rendering of a long multi-line string, not a different command. Only
// quoting was normalized before this, so the mismatch parked the run ("pr body: exec lane failed
// its checks three times: pr-body") even though the file was written correctly on the first try.
test('a real exec success is not thrown away when the model renders the command\'s newlines as literal \\n', execLane, async () => {
  const { root, args } = fresh('newline-echo')
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => (lane === 'pr-description' ? { title: 'Change', body: 'Line one.\n\nLine two, the why.', awaiting: [] } : undefined),
    exec: (name, sargs, ctx) => {
      if (ctx.detail !== 'pr-body') return undefined
      const real = ctx.prompt.split('nothing else: ')[1].split('\nReturn JSON')[0]
      const rendered = real.replace(/\n/g, '\\n')
      const wrote = harness(root, 'write', ...sargs)
      return { raw: { command: rendered, ran: true, exitCode: wrote.exitCode, stdout: wrote.stdout } }
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(sim.execs.filter(e => e.name === 'write').length, 1, 'the real success is accepted on the first attempt, not retried three times')
  assert.equal(decisionsOf(root).length, 0)
})

// 2026-10-02 day run: every ticket parked on its pr-body write. The haiku exec lane wrote the file
// with the right byte count each time, but its ~3 KB echo came back with `Other\ Repos`, with the
// body cut to `...`, or with '\'' re-rendered as '"'"'. The echoes below are the journal's own.
const ECHOES = JSON.parse(readFileSync(join(CORE, 'skills', 'flow-run-ticket', 'tests', 'fixtures', 'exec-echo', '2026-10-02-pr-body.json'), 'utf8'))
const commandOf = ctx => ctx.prompt.split('nothing else: ')[1].split('\nReturn JSON')[0]

for (const [kind, echo] of Object.entries(ECHOES.echoes)) {
  test(`a pr-body write is accepted on what landed, not on its echo (${kind}, journal line ${echo.journalLine})`, execLane, async () => {
    const { root, args } = fresh(`write-echo-${kind}`)
    const sim = makeSim(root, args, {
      agent: lane => (lane === 'pr-description' ? { body: ECHOES.text, awaiting: [] } : undefined),
      exec: (name, sargs, ctx) => {
        if (ctx.detail !== 'pr-body') return undefined
        const real = harness(root, 'write', ...sargs)
        return { raw: { command: echo.command, ran: true, exitCode: real.exitCode, stdout: real.stdout } }
      },
    })
    const r = await runTicket(sim)
    assert.equal(r.status, 'merged', JSON.stringify(r))
    assert.equal(sim.execs.filter(e => e.label.endsWith(':pr-body')).length, 1, 'accepted on the first attempt')
    assert.equal(readFileSync(join(root, 'tickets', 'ABC-1', 'pr-body.md'), 'utf8'), ECHOES.text)
  })
}

test('a pr-body write whose reported bytes differ from the body is not accepted, whatever the echo', execLane, async () => {
  const { root, args } = fresh('write-short')
  const sim = makeSim(root, args, {
    exec: (name, sargs, ctx) => {
      if (ctx.detail !== 'pr-body') return undefined
      const real = harness(root, 'write', ...sargs)
      // A re-typed body one byte off (journal line 383: 2135 against 2134), echoed back verbatim.
      return { raw: { command: commandOf(ctx), ran: true, exitCode: 0, stdout: JSON.stringify({ ...real.result, bytes: real.result.bytes + 1 }) } }
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.match(r.reason || '', /pr body/)
  assert.equal(r.calls.filter(c => /:pr-body$/.test(c.label) && c.why === 'write not verified').length, 3)
})

test('a write to another file is not accepted even with the right byte count', execLane, async () => {
  const { root, args } = fresh('write-elsewhere')
  const sim = makeSim(root, args, {
    exec: (name, sargs, ctx) => {
      if (ctx.detail !== 'pr-body') return undefined
      const real = harness(root, 'write', ...sargs)
      return { raw: { command: commandOf(ctx), ran: true, exitCode: 0, stdout: JSON.stringify({ ...real.result, artifact: `${real.result.artifact}.bak` }) } }
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
})

test('a non-write echo with backslash-escaped spaces and unquoted words is the same command', execLane, async () => {
  const { root, args } = fresh('escaped-space')
  assert.match(CORE, / /, 'this test needs a core path with a space in it, like the real one')
  const sim = makeSim(root, args, {
    exec: (name, sargs, ctx) => {
      if (name !== 'resume') return undefined
      const echoed = commandOf(ctx).replace(/'([^']*)'/g, (_, w) => w.replace(/ /g, '\\ '))
      return { raw: { command: echoed, ran: true, exitCode: 0, stdout: JSON.stringify({
        status: 'ok', ticket: 'ABC-1', clean: true, startPhase: 'start', outputs: {}, resumes: 0, cap: 2, capReached: false, runStatus: 'running', prUrl: null,
      }) } }
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(sim.execs.filter(e => e.name === 'resume').length, 1)
})

test('a non-write echo that renders an embedded quote as \'"\'"\' is the same command', execLane, async () => {
  const { root, args } = fresh('quote-rewrite')
  const sim = makeSim(root, args, {
    agent: lane => (lane === 'pr-description' ? { title: "[ABC-1] chore: don't change", awaiting: [] } : undefined),
    exec: (name, sargs, ctx) => {
      if (name !== 'pr-open.mjs') return undefined
      const echoed = commandOf(ctx).replace(/'\\''/g, `'"'"'`)
      return { raw: { command: echoed, ran: true, exitCode: 0, stdout: JSON.stringify({ status: 'ok', prUrl: 'https://forge.test/pr/7', number: 7, draft: true }) } }
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(sim.execs.filter(e => e.name === 'pr-open.mjs').length, 1)
})

// A confidence-phase wait-ci call (script timeout 540s) parked the whole run
// with "subagent completed without calling StructuredOutput (after in-conversation nudge)" — the
// exec-lane haiku agent, worried a synchronous Bash call would be cut off before a long-running
// command finished, called Monitor instead of Bash and then sat waiting for a notification that
// never arrives inside a single exec-lane turn, so it never called StructuredOutput at all. The
// exec prompt never told it to run Bash synchronously with a long enough timeout, so it improvised.
test('the exec prompt tells the model to run Bash synchronously with a long timeout, not to use Monitor or background tools', execLane, async () => {
  const { root, args } = fresh('exec-prompt-sync')
  const prompts = []
  const sim = makeSim(root, args, { exec: (name, sargs, ctx) => { prompts.push(ctx.prompt); return undefined } })
  await runTicket(sim)
  assert.ok(prompts.length > 0, 'at least one exec-lane call happened')
  for (const p of prompts) {
    assert.match(p, /do not use Monitor|run_in_background/i, 'must forbid async/background waiting tools')
    assert.match(p, /timeout/i, 'must instruct an explicit, long-enough Bash timeout')
  }
})

test('usage limit pauses, and the rerun resumes without re-dispatching finished phases', async () => {
  const { root, args } = fresh('usage')
  let hit = false
  const first = makeSim(root, args, {
    agent: lane => (lane === 'confidence-dim' && !hit ? (hit = true, { throw: 'You have hit your usage limit. Limit resets at 2026-09-28T23:00:00Z' }) : undefined),
  })
  const r1 = await runTicket(first)
  assert.equal(r1.status, 'paused-usage')
  assert.equal(runStatus(root, 'ABC-1').status, 'paused-usage')
  assert.match(readFileSync(join(root, 'state.md'), 'utf8'), /supervisor: paused-usage 2026-09-28T23:00:00Z/)
  assert.equal(decisionsOf(root).length, 0, 'a pause is never a park')
  const second = makeSim(root, args)
  const r2 = await runTicket(second)
  assert.equal(r2.status, 'merged')
  const lanes = lanesOf(second)
  for (const l of ['premise', 'plan', 'implement', 'pr-description']) assert.ok(!lanes.includes(l), `${l} not re-dispatched`)
  assert.ok(lanes.includes('confidence-dim'))
})

// wf_a59c2d14-3bf: a relaunch reused "<KEY>-run" while the previous worktree still held it.
test('every args build names its own run branch, so a relaunch never collides with the last one', () => {
  const root = tmpRoot('branch')
  const a = buildArgs(root)
  const b = buildArgs(root)
  assert.match(a.branch, /^ABC-1-run-[0-9a-f]{8}$/)
  assert.notEqual(a.branch, b.branch)
  assert.ok(a.worktreeRoot && !a.worktreeRoot.includes(a.branch))
})

// The repo convention is `<KEY>-<short-kebab-description>`; `-run-<hex>` ignored it.
test('with the ticket summary the branch is the key plus a short kebab of it', () => {
  const root = tmpRoot('branch-summary')
  const a = buildArgs(root, { extra: ['--summary', 'ABC-1: Orders are counted twice when the user retries'] })
  assert.equal(a.branch, 'ABC-1-orders-are-counted-twice-when-the')
  assert.equal(a.branchGiven, false)
  const b = buildArgs(root, { extra: ['--summary', '[Acme] Überprüfung: “fix” the __API__ v2 route!!'] })
  assert.equal(b.branch, 'ABC-1-acme-uberprufung-fix-the-api-v2')
})

const summaryRepo = root => {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  for (const a of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'base']])
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  const profile = join(root, 'acme-repo.md')
  writeFileSync(profile, readFileSync(PROFILE, 'utf8').replace('`~/src/acme-web`', `\`${repo}\``))
  return { repo, profile }
}

test('a summary branch the primary checkout already has gets a short suffix, so each launch still owns its branch', () => {
  const root = tmpRoot('branch-taken')
  const { repo, profile } = summaryRepo(root)
  const extra = ['--summary', 'Fix the rep counter']
  assert.equal(buildArgs(root, { profile, extra }).branch, 'ABC-1-fix-the-rep-counter')
  execFileSync('git', ['-C', repo, 'branch', 'ABC-1-fix-the-rep-counter'])
  const b = buildArgs(root, { profile, extra }).branch
  assert.match(b, /^ABC-1-fix-the-rep-counter-[0-9a-f]{4}$/)
  execFileSync('git', ['-C', repo, 'update-ref', `refs/remotes/origin/ABC-1-fix-the-rep-counter`, 'HEAD'])
  execFileSync('git', ['-C', repo, 'branch', '-D', 'ABC-1-fix-the-rep-counter'])
  assert.match(buildArgs(root, { profile, extra }).branch, /^ABC-1-fix-the-rep-counter-[0-9a-f]{4}$/, 'a remote-tracking ref counts too')
})

test('an explicit --branch is taken as given and marked as such', () => {
  const root = tmpRoot('branch-given')
  const a = buildArgs(root, { extra: ['--branch', 'ABC-1-mine', '--summary', 'Ignored here'] })
  assert.equal(a.branch, 'ABC-1-mine')
  assert.equal(a.branchGiven, true)
})

// A derived name can equal the head of an earlier merged PR whose branch was since deleted; the
// guard's own-branch exemption would then hide exactly the duplicate it exists to catch.
test('a derived branch is not exempted from the duplicate guard; a given one is', async () => {
  const guardArgv = async args => {
    const root = args.stateRoot
    const sim = makeSim(root, args)
    await runTicket(sim)
    return sim.execs.find(e => e.name === 'duplicate-guard.mjs').argv
  }
  const derived = await guardArgv(buildArgs(tmpRoot('guard-derived'), { extra: ['--summary', 'Fix the rep counter'] }))
  assert.ok(!derived.includes('--own-branch'), derived.join(' '))
  const given = await guardArgv(buildArgs(tmpRoot('guard-given'), { extra: ['--branch', 'ABC-1-mine'] }))
  assert.equal(given[given.indexOf('--own-branch') + 1], 'ABC-1-mine')
})

test('a relaunch with rebuilt args resumes on the branch and worktree of the run it continues', async () => {
  const root = tmpRoot('relaunch')
  const first = makeSim(root, buildArgs(root), { exec: name => name === 'wait-ci.mjs' ? { hang: true } : undefined })
  await runTicket(first)
  const started = first.execs.find(e => e.name === 'worktree.mjs').argv
  const branch = started[started.indexOf('--branch') + 1]
  const prompts = []
  const second = makeSim(root, buildArgs(root), { agent: (lane, ctx) => { prompts.push(ctx.prompt) } })
  assert.notEqual(second.args.branch, branch)
  const r = await runTicket(second)
  assert.equal(r.status, 'merged')
  assert.ok(!execNames(second).includes('worktree.mjs'), 'no second worktree')
  const named = second.execs.flatMap(e => e.argv).filter(a => typeof a === 'string' && a.includes('ABC-1-run-'))
  assert.ok(named.length > 0)
  for (const v of named) assert.ok(v.includes(branch) && !v.includes(second.args.branch), v)
  const stray = prompts.find(p => p.includes(second.args.branch))
  assert.ok(!stray, stray && stray.slice(Math.max(0, stray.indexOf(second.args.branch) - 200), stray.indexOf(second.args.branch) + 60))
})

test('killed mid-run, the rerun resumes from the last checkpoint', async () => {
  const { root, args } = fresh('kill')
  const first = makeSim(root, args, { exec: name => name === 'wait-ci.mjs' ? { hang: true } : undefined })
  const r1 = await runTicket(first)
  assert.ok(r1.killed, 'killed')
  const second = makeSim(root, args)
  const r2 = await runTicket(second)
  assert.equal(r2.status, 'merged')
  assert.ok(!lanesOf(second).includes('implement'))
  assert.ok(!execNames(second).includes('worktree.mjs'))
  assert.ok(execNames(second).includes('wait-ci.mjs'))
  assert.equal(runStatus(root, 'ABC-1').counters.resumes, 1)
})

test('claim mismatch becomes a review finding and spends a fix round', async () => {
  const { root, args } = fresh('claim')
  let calls = 0
  const sim = makeSim(root, args, {
    exec: (name, argv) => name === 'verify-claim.mjs' && !argv.includes('--section') && calls++ === 0
      ? { status: 'ok', command: 'npm test', claim: 'pass', actual: 'fail', exitCode: 1, mismatch: true } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(runStatus(root, 'ABC-1').counters.fixRounds, 1)
  assert.equal(r.status, 'merged')
})

// A toolchain the profile cannot run says nothing about the code: no fix agent can close it, so it
// must not spend a round, and it must still stop the merge at the gate.
test('verify-claim blocked on the toolchain spends no fix round, reaches the PR and holds the gate', async () => {
  const { root, args } = fresh('claim-blocked')
  const sim = makeSim(root, args, {
    exec: name => name === 'verify-claim.mjs'
      ? { status: 'blocked', kind: 'toolchain', command: 'cd client-new && npm test', exitCode: 127, reason: 'test command "cd client-new && npm test" could not run (exit 127: sh: vitest: command not found)' } : undefined,
  })
  const r = await runTicket(sim)
  assert.ok(!lanesOf(sim).includes('fix'), 'no fix lane for a harness-side finding')
  assert.equal(runStatus(root, 'ABC-1').counters.fixRounds || 0, 0)
  assert.ok(execNames(sim).includes('pr-open.mjs'), 'the run reaches the PR')
  assert.ok(!execNames(sim).includes('pr-merge.mjs'), 'a blocked claim never merges')
  const cond = r.gate.conditions.find(c => c.name === 'verify-claim')
  assert.equal(cond.state, 'blocked')
  assert.match(cond.evidence, /exit 127/)
  const d = decisionsOf(root)
  assert.deepEqual(d.map(x => x.kind), ['gate-red'])
  assert.match(d[0].question, /verify-claim \(blocked\)/)
})

test('decisions and counter increments ride on the next state call, each decision keyed to its phase', async () => {
  const { root, args } = fresh('batched')
  let calls = 0
  const sim = makeSim(root, args, {
    exec: (name, argv) => name !== 'verify-claim.mjs' || argv.includes('--section') ? undefined : calls++ === 0
      ? { status: 'ok', command: 'npm test', claim: 'pass', actual: 'fail', exitCode: 1, mismatch: true }
      : { status: 'blocked', kind: 'toolchain', command: 'npm test', exitCode: 127, reason: 'test command "npm test" could not run (exit 127)' },
  })
  await runTicket(sim)
  const lone = sim.execs.filter(e => e.name === 'state.mjs' && (['decide', 'set-status'].includes(e.argv[0]) || (e.argv[0] === 'counter' && e.argv.includes('--inc'))))
  assert.deepEqual(lone.map(e => e.argv.slice(0, 3).join(' ')),
    ['counter ABC-1 confidencePasses'], 'only a write whose answer is read at once goes alone')
  assert.equal(runStatus(root, 'ABC-1').counters.fixRounds, 1)
  assert.ok(sim.execs.some(e => e.name === 'state.mjs' && e.argv[0] === 'batch'))
  const d = decisionsOf(root)
  assert.deepEqual(d.map(x => [x.kind, x.key]), [['gate-red', 'merge:1']])
})

test('CI red once is fixed under the ci-fix counter', async () => {
  const { root, args } = fresh('ci')
  let reds = 0
  const sim = makeSim(root, args, {
    exec: (name, argv) => name === 'wait-ci.mjs' && reds++ === 0
      ? { status: 'ok', sha: argv[3], state: 'red', checks: [{ name: 'test', conclusion: 'failure' }] } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(runStatus(root, 'ABC-1').counters.ciFix, 1)
  assert.ok(sim.labels.some(l => l.startsWith('ci:fix:T3:ci')))
  assert.equal(r.status, 'merged')
})

test('a skipped bot review records a quota decision and blocks the gate', async () => {
  const { root, args } = fresh('quota')
  const sim = makeSim(root, args, {
    exec: (name, argv) => name === 'review-bot-green.mjs'
      ? { status: 'ok', headSha: argv[5], reviewed: false, green: false, reviewId: 2, reviewCommit: argv[5], matchedSkipPattern: 'Review limit reached', matchedSkipBody: 'Review limit reached — retry after the window resets.' } : undefined,
  })
  const r = await runTicket(sim)
  assert.deepEqual(decisionsOf(root).map(d => d.kind).sort(), ['gate-red', 'quota'])
  assert.equal(state(root, 'open-count').open, 1, 'quota is not counted, gate-red is')
  assert.equal(r.status, 'parked')
  const cp = checkpointOutput(root, 'ABC-1', 'review-bot')
  assert.ok(cp.observations['review-bot'].evidence.includes('Review limit reached — retry after the window resets.'), 'the gate evidence quotes the matched comment body, not just the pattern')
})

test('review-bot is re-observed against the head its own thread fix produces, after CI re-runs on it', async () => {
  const { root, args } = fresh('bot-thread-fix')
  let asks = 0
  const sim = makeSim(root, args, {
    exec: (name, argv) => name === 'review-bot-green.mjs' && asks++ === 0
      ? { status: 'ok', headSha: argv[5], reviewed: true, green: false, reviewId: 1, reviewCommit: argv[5], matchedSkipPattern: null } : undefined,
  })
  await runTicket(sim)
  const shaOf = e => e.argv[e.argv.indexOf('--sha') + 1]
  const bot = sim.execs.filter(e => e.name === 'review-bot-green.mjs')
  assert.ok(sim.labels.some(l => l.startsWith('review-bot:fix:')), sim.labels.join(' '))
  assert.ok(bot.length >= 2)
  assert.notEqual(shaOf(bot[0]), shaOf(bot[1]), 'the second ask names the post-fix head')
  const ci = sim.execs.filter(e => e.name === 'wait-ci.mjs').map(shaOf)
  assert.ok(ci.includes(shaOf(bot[1])), 'CI re-ran on the post-fix head before the bot was asked again')
  assert.equal(runStatus(root, 'ABC-1').counters.fixRounds, 1, 'the thread fix spends the shared fix-round budget')
})

// pr-ready.mjs reported ok while the PR stayed
// draft, so review-bot polled a PR CodeRabbit was silently skipping for its whole wait budget.
// pr-ready.mjs itself now re-reads isDraft and never reports ok while it is still true; here we
// pin the runner's side: a non-ok pr-ready result must stop review-bot from ever calling
// review-bot-green.mjs, and must show up as a blocked gate condition instead.
test('a PR that stays draft after pr-ready blocks review-bot without ever polling it', async () => {
  const { root, args } = fresh('stay-draft')
  const sim = makeSim(root, args, {
    exec: name => name === 'pr-ready.mjs'
      ? { status: 'blocked', kind: 'toolchain', reason: 'PR still draft after gh pr ready and one retry', draft: true } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.ok(!execNames(sim).includes('review-bot-green.mjs'), 'review-bot never polls a draft PR')
  const d = decisionsOf(root)
  assert.ok(d.some(x => x.kind === 'gate-red'), 'the still-draft PR surfaces as a gate-red decision')
  assert.match(d.find(x => x.kind === 'gate-red').why, /still draft/, 'the gate-red decision carries the draft evidence')
})

test('confidence cap: a finding confirmed on every pass is a confidence-cap decision; reverify is capped per pass', async () => {
  const { root, args } = fresh('conf')
  const findings = Array.from({ length: 10 }, (_, i) => ({ id: `C${i}`, axis: 'correctness', severity: 'high', summary: `bug ${i}`, locations: ['a.ts:1'] }))
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => lane === 'confidence-dim' && ctx.detail === 'correctness' ? { findings }
      : lane === 'reverify' ? { findingId: ctx.detail, verdict: 'confirmed' } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  const reverifies = lanesOf(sim).filter(l => l === 'reverify').length
  assert.equal(reverifies, 2 * args.caps.reverifyPerPass)
  assert.ok(decisionsOf(root).some(d => d.kind === 'confidence-cap'))
  assert.equal(runStatus(root, 'ABC-1').counters.confidencePasses, 2)
  assert.equal(runStatus(root, 'ABC-1').counters.fixRounds, 0, 'confidence fixes do not spend the review fix rounds')
})

// A confidence-phase fix pushes a new commit and re-runs CI on it, but review-bot's own
// observation was captured once, in the review-bot phase, against the pre-fix head. The gate
// compares that observation's headSha to the run's current head (evaluate()'s `o.headSha !==
// headSha` check) and blocks on a mismatch it calls staleness — exactly what a real CodeRabbit
// review pinned to an old commit looks like, except here the harness itself never asked the bot
// to look at the new commit at all.
test('review-bot is re-observed against the head a confidence-phase fix produces, not left pinned to the pre-fix sha', async () => {
  const { root, args } = fresh('bot-refresh')
  const finding = { id: 'C1', axis: 'correctness', severity: 'high', summary: 'off-by-one', locations: ['a.ts:1'] }
  let dimCalls = 0
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => {
      if (lane === 'confidence-dim' && ctx.detail === 'correctness') { dimCalls++; return { findings: dimCalls === 1 ? [finding] : [] } }
      if (lane === 'reverify') return { findingId: ctx.detail, verdict: 'confirmed' }
      return undefined
    },
  })
  const r = await runTicket(sim)
  const bot = sim.execs.filter(e => e.name === 'review-bot-green.mjs')
  assert.equal(bot.length, 2, 'review-bot is asked again after the confidence-phase fix, not just once before it')
  const shaOf = e => e.argv[e.argv.indexOf('--sha') + 1]
  assert.notEqual(shaOf(bot[0]), shaOf(bot[1]), 'the second ask names the post-fix head, not the one the first ask saw')
  assert.equal(shaOf(bot[1]), r.headSha, 'the re-ask targets the run\'s final head')
  const cond = r.gate.conditions.find(c => c.name === 'review-bot')
  assert.equal(cond.state, 'green', 'the gate sees a review of the actual head, not a stale-sha block')
})

// PRs went CONFLICTING while the run waited on CI and the bot, and the
// gate still declared them ready. Mergeability is now a gate condition, and the update is a script.
const behindOnce = (updated = { status: 'ok', updated: true, method: 'rebase', baseSha: 'ma1n002', previousSha: 'x', headSha: 'add0001', forced: false }) => {
  let behind = true
  return (name, argv) => {
    if (name === 'pr-state.mjs' && behind) return { status: 'ok', state: 'OPEN', mergeStateStatus: 'BEHIND', mergeable: 'MERGEABLE', isDraft: false }
    if (name === 'update-from-base.mjs') { behind = false; return updated }
    return undefined
  }
}
const baseOf = r => r.gate.conditions.find(c => c.name === 'base')

test('a profile that does not declare force-push after rebase updates from base without --lease', async () => {
  const root = tmpRoot('behind-no-lease')
  const text = readFileSync(PROFILE, 'utf8').replace(/^- Force-push after rebase:.*\n/m, '')
  assert.ok(!/Force-push after rebase/.test(text), 'the variant drops the row')
  const profile = join(root, 'acme-no-lease.md')
  writeFileSync(profile, text)
  const sim = makeSim(root, buildArgs(root, { profile }), { files: ['client-new/lib/pose.ts'], exec: behindOnce() })
  await runTicket(sim)
  const upd = sim.execs.filter(e => e.name === 'update-from-base.mjs')
  assert.equal(upd.length, 1)
  assert.ok(!upd[0].argv.includes('--lease'), 'absent means never: the script refuses a force-push and the run parks')
})

test('a behind PR on a signature path is updated from base by the script and re-observed before ready-to-sign', async () => {
  const { root, args } = fresh('behind-sign')
  const sim = makeSim(root, args, { files: ['client-new/lib/pose.ts'], exec: behindOnce() })
  const r = await runTicket(sim)
  assert.equal(r.status, 'ready-to-sign', JSON.stringify(r.gate && r.gate.conditions))
  assert.equal(r.headSha, 'add0001')
  assert.equal(baseOf(r).state, 'green')
  const upd = sim.execs.filter(e => e.name === 'update-from-base.mjs')
  assert.equal(upd.length, 1)
  assert.equal(upd[0].argv[upd[0].argv.indexOf('--method') + 1], 'rebase', 'the profile integrates main by rebase')
  assert.ok(upd[0].argv.includes('--lease'), 'the profile declares Force-push after rebase: with-lease')
  const idx = n => sim.execs.findIndex(e => e.name === n)
  assert.ok(sim.execs.findIndex(e => e.name === 'wait-ci.mjs' && e.argv.includes('add0001')) > idx('update-from-base.mjs'), 'CI re-observed on the updated head')
  assert.ok(sim.execs.some(e => e.name === 'review-bot-green.mjs' && e.argv.includes('add0001')), 'review bot re-observed on the updated head')
  assert.ok(sim.labels.some(l => l.startsWith('gate:review-axis:T3:') && l.endsWith(':repin')), 'axes re-pinned on the delta')
  assert.equal(runStatus(root, 'ABC-1').counters.rebase, 1)
  assert.ok(!lanesOf(sim).includes('conflict'), 'no agent resolves anything')
})

test('a conflicting PR parks with the base condition blocked and the conflicting files as evidence, never ready-to-sign', async () => {
  const { root, args } = fresh('conflict-sign')
  const sim = makeSim(root, args, {
    files: ['client-new/lib/pose.ts'],
    exec: name => name === 'pr-state.mjs' ? { status: 'ok', state: 'OPEN', mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', isDraft: false }
      : name === 'update-from-base.mjs' ? { status: 'blocked', kind: 'conflict', reason: 'rebase conflicts in 2 file(s)', conflictingFiles: ['client-new/lib/pose.ts', 'server-new/a.ts'], baseSha: 'ma1n002', headSha: 'ba5e000' }
      : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.equal(r.gate.readyToSign, false)
  assert.equal(baseOf(r).state, 'blocked')
  assert.match(baseOf(r).evidence, /client-new\/lib\/pose\.ts.*server-new\/a\.ts/)
  assert.ok(!lanesOf(sim).includes('conflict'), 'no agent resolves the conflict')
  const d = decisionsOf(root)
  assert.deepEqual(d.map(x => x.kind), ['gate-red'])
  assert.match(d[0].why, /base: .*pose\.ts/)
})

test('mergeable CONFLICTING is out of date even while the forge has not settled mergeStateStatus', async () => {
  const { root, args } = fresh('conflict-unknown')
  const sim = makeSim(root, args, {
    files: ['client-new/lib/pose.ts'],
    exec: name => name === 'pr-state.mjs' ? { status: 'ok', state: 'OPEN', mergeStateStatus: 'UNKNOWN', mergeable: 'CONFLICTING', isDraft: false }
      : name === 'update-from-base.mjs' ? { status: 'blocked', kind: 'conflict', reason: 'conflicts', conflictingFiles: ['client-new/lib/pose.ts'], baseSha: 'ma1n002', headSha: 'ba5e000' }
      : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.equal(baseOf(r).state, 'blocked')
})

test('an agent-path PR is never merged while behind: updated by the script, re-gated, merged on the new head', async () => {
  const { root, args } = fresh('behind-agent')
  const sim = makeSim(root, args, { exec: behindOnce() })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged')
  const merge = sim.execs.find(e => e.name === 'pr-merge.mjs').argv
  assert.equal(merge[merge.indexOf('--sha') + 1], 'add0001')
  assert.ok(sim.execs.findIndex(e => e.name === 'update-from-base.mjs') < sim.execs.findIndex(e => e.name === 'pr-merge.mjs'))
  assert.ok(!lanesOf(sim).includes('conflict'))
})

test('a PR that turns behind between the gate and the merge click is re-gated through the script, not an agent', async () => {
  const { root, args } = fresh('behind-race')
  // Clean at the gate, behind from the merge loop's own read until the update lands.
  let calls = 0
  let behind = false
  const sim = makeSim(root, args, {
    exec: name => {
      if (name === 'pr-state.mjs') { if (++calls === 2) behind = true; return behind ? { status: 'ok', state: 'OPEN', mergeStateStatus: 'BEHIND', mergeable: 'MERGEABLE', isDraft: false } : undefined }
      if (name === 'update-from-base.mjs') { behind = false; return { status: 'ok', updated: true, method: 'rebase', baseSha: 'ma1n003', previousSha: 'x', headSha: 'add0002', forced: false } }
      return undefined
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged')
  assert.equal(r.headSha, 'add0002')
  assert.ok(!lanesOf(sim).includes('conflict'))
  assert.equal(runStatus(root, 'ABC-1').counters.rebase, 1)
})

test('a PR still behind after the rebase cap parks on the base condition', async () => {
  const { root, args } = fresh('behind-cap')
  let n = 0
  const sim = makeSim(root, args, {
    exec: name => name === 'pr-state.mjs' ? { status: 'ok', state: 'OPEN', mergeStateStatus: 'BEHIND', mergeable: 'MERGEABLE', isDraft: false }
      : name === 'update-from-base.mjs' ? { status: 'ok', updated: true, method: 'rebase', baseSha: 'ma1n00' + n, previousSha: 'x', headSha: `add100${++n}`, forced: false }
      : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.equal(sim.execs.filter(e => e.name === 'update-from-base.mjs').length, args.caps.rebase)
  // r.gate is the gate phase's checkpoint; the cap is reached in the merge loop's re-gate.
  assert.match(r.reason, /base blocked/)
  assert.match(decisionsOf(root).find(d => d.kind === 'gate-red').why, /base: still BEHIND .*rebase cap/)
})

test('a PR whose mergeability cannot be read blocks the base condition instead of passing it', async () => {
  const { root, args } = fresh('state-fail')
  const sim = makeSim(root, args, {
    files: ['client-new/lib/pose.ts'],
    exec: name => name === 'pr-state.mjs' ? { status: 'error', kind: 'script-error', reason: 'gh pr view failed' } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.equal(baseOf(r).state, 'blocked')
  assert.match(baseOf(r).evidence, /gh pr view failed/)
})

test('an update the push policy refuses blocks the base condition with the refusal as evidence', async () => {
  const { root, args } = fresh('behind-policy')
  const sim = makeSim(root, args, {
    files: ['client-new/lib/pose.ts'],
    exec: behindOnce({ status: 'refused', kind: 'policy', reason: 'rebase rewrote pushed commits of ABC-1-run; pushing it needs a force-push', baseSha: 'ma1n002', headSha: 'ba5e000', rebasedSha: 'eba5ed0' }),
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.equal(baseOf(r).state, 'blocked')
  assert.match(baseOf(r).evidence, /force-push/)
})

test('a dropped review axis parks instead of passing silently', async () => {
  const { root, args } = fresh('drop')
  const sim = makeSim(root, args, { agent: (lane, ctx) => (lane === 'review-axis' && ctx.detail === 'spec' ? null : undefined) })
  const r = await runTicket(sim)
  assert.equal(r.status, 'parked')
  assert.ok(sim.labels.includes('review:review-axis:T3:spec'))
  assert.ok(decisionsOf(root).some(d => d.kind === 'gate-red'))
})

test('a lane question goes through the resolver and the lane is re-run with the ruling', async () => {
  const { root, args } = fresh('question')
  let asked = false
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => lane === 'plan' && !asked
      ? (asked = true, { questions: [{ question: 'Which module?', options: ['a', 'b'], recommendation: 'a', why: 'ticket is vague' }] })
      : lane === 'plan' ? (assert.match(ctx.prompt, /RULINGS FROM THE RESOLVER/), undefined) : undefined,
  })
  const r = await runTicket(sim)
  assert.ok(sim.labels.includes('plan:resolver:T3:question'))
  assert.equal(decisionsOf(root).length, 0)
  assert.equal(r.status, 'merged')
})

test('no-tracker profile: --spec stands in for the ticket, command gates run, --ticket is refused', async () => {
  const root = tmpRoot('spec')
  const spec = join(root, 'add-flag.md')
  writeFileSync(spec, '# Add a --json flag\n\nAcceptance: the CLI prints JSON when --json is passed.\n')
  const refused = harness(root, 'args', '--profile', NO_TRACKER, '--date', '2026-09-28', '--root', root, '--ticket', 'X-1')
  assert.equal(refused.exitCode, 4)
  const args = buildArgs(root, { profile: NO_TRACKER, spec })
  assert.equal(args.ticket, 'ADD-FLAG')
  assert.equal(args.caps.ciFix, 1)
  const sim = makeSim(root, args, { files: ['src/cli.js'] })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.ok(execNames(sim).includes('command'))
  assert.ok(!execNames(sim).includes('review-bot-green.mjs'))
  assert.ok(!sim.labels.some(l => l.startsWith('premise:') && /tracker/.test(l)))
})

// The pr-description lane's raw prose became the PR
// title verbatim in every real run ("Prose only — no push, no PR opened (per task). Title and
// body for …"). The runner now rejects a title that isn't a conforming
// "[TICKET] type(scope)?: summary" line, retries the lane once with the rejection reason, and
// falls back to a deterministic title built from the ticket key and the plan summary.
test('pr title: a conforming title from the lane is used as-is, no retry', async () => {
  const { root, args } = fresh('pr-title-ok')
  let calls = 0
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => {
      if (lane !== 'pr-description') return undefined
      calls += 1
      return { title: '[ABC-1] fix: correct pose smoothing', body: 'Body text.', awaiting: [] }
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(calls, 1, 'a conforming title is accepted on the first try')
  const opened = sim.execs.find(e => e.name === 'pr-open.mjs').argv
  assert.equal(opened[opened.indexOf('--title') + 1], '[ABC-1] fix: correct pose smoothing')
})

test('pr title: raw prose is rejected, retried once with the rejection reason, and the correction is accepted', async () => {
  const { root, args } = fresh('pr-title-retry-ok')
  let calls = 0
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => {
      if (lane !== 'pr-description') return undefined
      calls += 1
      if (calls === 1) return { title: 'Prose only — no push, no PR opened (per task).', body: 'Body text.', awaiting: [] }
      assert.match(ctx.prompt, /rejected/i, 'the retry prompt carries the rejection reason')
      assert.match(ctx.prompt, /Prose only/, 'the retry prompt quotes the rejected title')
      return { title: '[ABC-1] fix: correct pose smoothing', body: 'Body text.', awaiting: [] }
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(calls, 2, 'exactly one retry')
  const opened = sim.execs.find(e => e.name === 'pr-open.mjs').argv
  assert.equal(opened[opened.indexOf('--title') + 1], '[ABC-1] fix: correct pose smoothing')
})

test('pr title: two non-conforming titles fall back to a deterministic one built from the ticket key and the plan summary', async () => {
  const { root, args } = fresh('pr-title-fallback')
  let calls = 0
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => {
      if (lane === 'plan') {
        return { ok: true, ticketKind: 'code', premiseVerdict: 'holds',
          planSummary: 'stabilise the pose smoothing filter', authorisedFiles: ['server-new/'], awaiting: [] }
      }
      if (lane !== 'pr-description') return undefined
      calls += 1
      return { title: 'Prose only — no push, no PR opened (per task).', body: 'Body text.', awaiting: [] }
    },
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(calls, 2, 'the lane is retried exactly once, never looped')
  const opened = sim.execs.find(e => e.name === 'pr-open.mjs').argv
  assert.equal(opened[opened.indexOf('--title') + 1], '[ABC-1] chore: stabilise the pose smoothing filter')
  const body = readFileSync(join(root, 'tickets', 'ABC-1', 'pr-body.md'), 'utf8')
  assert.equal(body, 'Body text.', 'the body prefix behaviour for open findings is unchanged when there are none')
})

test('pr title: a title missing its ticket prefix is rejected the same as raw prose', async () => {
  const { root, args } = fresh('pr-title-no-prefix')
  const sim = makeSim(root, args, {
    agent: lane => lane === 'pr-description' ? { title: 'fix: correct pose smoothing', body: 'Body text.', awaiting: [] } : undefined,
  })
  const r = await runTicket(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  const opened = sim.execs.find(e => e.name === 'pr-open.mjs').argv
  assert.equal(opened[opened.indexOf('--title') + 1], '[ABC-1] chore: plan')
})

test('the inlined gate evaluator, escalation router and awaiting triage match their libraries', execLane, () => {
  const wf = readFileSync(TICKET_SCRIPT, 'utf8')
  const strip = s => s.replace(/^export /gm, '')
  const ev = readFileSync(join(CORE, 'lib/gates/evaluate.mjs'), 'utf8')
  const evBlock = strip(ev.slice(ev.indexOf('const RANK'), ev.indexOf('// ---------------------------------------------------------------- CLI'))).trim()
  assert.ok(wf.includes(evBlock), 'evaluate.mjs block drifted')
  const rt = readFileSync(join(CORE, 'lib/escalation/route.mjs'), 'utf8')
  const rtBlock = strip(rt.slice(rt.indexOf('export const NEVER'), rt.indexOf('// ------------------------------------------------------------------------------------------ CLI'))).trim()
  assert.ok(wf.includes(rtBlock), 'route.mjs block drifted')
  const aw = readFileSync(join(CORE, 'lib/contract/awaiting.mjs'), 'utf8')
  const awBlock = aw.slice(aw.indexOf('function isQuotedRefusal'), aw.indexOf('// ---------------------------------------------------------------- end inlined block')).trim()
  assert.ok(wf.includes(awBlock), 'awaiting.mjs block drifted')
})

test('args carry the awaiting triage rules: the classifier refusal patterns and the prose lanes', () => {
  const args = buildArgs(tmpRoot('awaiting-args'))
  const patterns = JSON.parse(readFileSync(join(CORE, 'lib', 'resilience', 'patterns.json'), 'utf8'))
  for (const p of patterns.kinds['harness-blocked']) assert.ok(args.awaiting.refusals.includes(p), p)
  assert.deepEqual(args.awaiting.prose, ['pr-description', 'log-prose', 'sweep-summary'])
})

test('args carry the judgment-lane budget caps and the fan-out limit from config/routing.json', () => {
  const root = tmpRoot('budgets')
  const args = buildArgs(root)
  const config = JSON.parse(readFileSync(join(CORE, 'config', 'routing.json'), 'utf8'))
  assert.ok(args.budgetsUsd && args.budgetsUsd.T3 > 0, JSON.stringify(args.budgetsUsd))
  assert.deepEqual(args.budgetsUsd, config.budgetsUsd)
  assert.equal(args.concurrency, config.concurrency)
})

// diff-since-review printing no script-result line once let the gate report authority agent on
// PRs that touched signature paths.
test('changed-files without a script-result line: the gate requires a signature, not agent', async () => {
  const { root, args } = fresh('no-files')
  const sim = makeSim(root, args, {
    files: ['client-new/lib/pose.ts'],
    exec: name => name === 'diff-since-review.mjs' ? { raw: { ran: true, exitCode: 0, stdout: 'warning: noise\n' } } : undefined,
  })
  const r = await runTicket(sim)
  assert.notEqual(r.status, 'merged')
  assert.ok(!execNames(sim).includes('pr-merge.mjs'), 'no merge click')
  assert.equal(r.gate.authority, 'unconfirmed')
  assert.equal(r.gate.mergeAllowed, false)
  assert.equal(r.gate.readyToSign, false)
  assert.match(r.gate.conditions.find(c => c.name === 'touched-paths').evidence, /no changed files known/, 'a failed script is not an empty diff')
})

test('changed-files ok but empty: the gate still requires a signature', async () => {
  const { root, args } = fresh('empty-files')
  const sim = makeSim(root, args, { files: [] })
  const r = await runTicket(sim)
  assert.notEqual(r.status, 'merged')
  assert.ok(!execNames(sim).includes('pr-merge.mjs'), 'no merge click')
  assert.equal(r.gate.authority, 'unconfirmed')
  assert.equal(r.gate.mergeAllowed, false)
  assert.match(r.gate.conditions.find(c => c.name === 'touched-paths').evidence, /no changed files listed/)
})
