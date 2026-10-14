// One plain async function per phase of a ticket run; each takes the run context from core.mjs.
import { evaluate } from '../gates/evaluate.mjs'
import { clip } from './core.mjs'
import { fenceUntrusted, UNTRUSTED_READ_RULE } from '../text/untrusted.mjs'

// Text the harness did not write enters a prompt only fenced. Lines in it that read as orders go on
// the phase output, so whoever reads the run sees what tried to steer it.
function untrusted(c, raw, source, into) {
  const f = fenceUntrusted(raw, { source })
  if (f.suspicious.length) {
    into.push(...f.suspicious)
    c.log(`${c.TICKET}: ${f.suspicious.length} suspicious line(s) in ${source}, fenced and recorded`)
  }
  return f.text
}
const withSuspicious = (out, list) => (list.length ? { ...out, suspicious: list.slice(0, 20) } : out)

export async function start(c) {
  const dup = await c.run('forge/duplicate-guard.mjs', ['--repo', c.REPO_SLUG, '--repo-path', c.REPO_PATH, '--key', c.TICKET, ...(c.args.branchGiven ? ['--own-branch', c.branch] : [])])
  if (dup.status === 'refused' && dup.kind === 'duplicate') {
    // No ledger line: the worktree that would hold the ledger is never created.
    await c.decide({ kind: 'duplicate', question: clip(`${dup.reason}. Stop this run, or clear the existing work and relaunch?`, 1000),
      why: 'another run already opened, merged or pushed work for this ticket; a second run would duplicate it',
      options: ['stop: the existing PR or branch carries this ticket', 'close or delete the existing PR or branch, then relaunch'],
      recommendation: 'stop: the existing PR or branch carries this ticket', reversalCost: 'low: nothing was created', ledger: null })
    throw c.stop('parked', clip(dup.reason, 600))
  }
  if (dup.status !== 'ok') throw c.stop('parked', `duplicate-guard: ${dup.reason || dup.kind}`)
  // The profile's own worktree command, when it has one, decides where the worktree lives.
  const r = await c.run('git/worktree.mjs', ['new', '--repo', c.REPO_PATH, '--branch', c.branch, '--base', c.BASE,
    ...(c.F.worktreeCreate ? ['--command', c.F.worktreeCreate] : ['--dir', c.wt])])
  if (r.status !== 'ok') throw c.stop('parked', `worktree: ${r.reason || r.kind}`)
  if (r.path) c.setWorktree(c.branch, r.path)
  c.head = r.headSha
  // A fresh worktree starts with no node_modules; the profile's declared setup runs once, before
  // anything else reads it. A command that cannot run is blocked for the gate, never a park here.
  const setup = []
  for (const s of (c.F.worktreeSetup || [])) {
    const sr = await c.run('resilience/verify-claim.mjs', [c.F.profilePath, s.check, 'pass', '--cwd', c.wt, '--section', 'worktree setup'], 'worktree-setup')
    setup.push(sr.status !== 'ok'
      ? { check: s.check, state: 'blocked', kind: sr.kind || 'toolchain', reason: clip(sr.reason || sr.status, 200) }
      : { check: s.check, state: sr.actual === 'pass' ? 'green' : 'red', command: clip(sr.command, 200), exitCode: sr.exitCode })
  }
  c.out.start = { worktree: c.wt, branch: c.branch, baseSha: r.headSha, headSha: r.headSha, setup }
  await c.checkpoint('start', c.out.start)
}

export async function premise(c) {
  const r = await c.lane('premise', c.taskBrief(
    `${c.ticketSource()} ${UNTRUSTED_READ_RULE}\nCheck the ticket's premise against the repo at ${c.wt}: does the code it describes exist and ` +
    `behave as it says? Return verdict holds, falsified or ambiguous with file:line evidence. Do not plan or edit anything, and do not write to the tracker.`), 'ticket')
  if (!r) throw c.stop('parked', 'premise lane returned nothing')
  if (r) c.verdict(r, 'premise', 'verdict', r.verdict, 'ticket')
  if (r.verdict === 'falsified') {
    await c.decide({ kind: 'premise', question: `The premise of ${c.TICKET} does not hold. Rewrite the ticket or close it?`, why: clip(r.evidence, 1000),
      options: ['rewrite the ticket against what the repo does', 'close the ticket as not reproducible'], recommendation: 'rewrite the ticket against what the repo does', reversalCost: 'low: nothing was changed' })
    throw c.stop('parked', 'premise falsified')
  }
  if (c.TRACKER.kind !== 'none' && c.TRACKER.startStatus) {
    await c.lane('premise', c.taskBrief(
      `Move ${c.TICKET} to "${c.TRACKER.startStatus}" in the tracker; that is the only tracker write of this phase. ` +
      'Return verdict holds once it has moved, or ambiguous with the tracker\'s error as evidence.'), 'tracker')
  }
  c.out.premise = { verdict: r.verdict, evidence: clip(r.evidence, 600) }
  await c.checkpoint('premise', c.out.premise)
}

// A plan committed with the change is a file like any other to the merge-authority table, and no
// profile lists a plan path for the agent, so a committed plan alone would make every PR signature-bound.
const PLAN_OUTSIDE_REPO = 'The plan lives outside the repository; never copy it into the worktree or commit it.'
export const planTarget = c => `${c.ROOT}/tickets/${c.TICKET}/plan.md`

export async function plan(c) {
  const target = planTarget(c)
  const suspicious = []
  const r = await c.lane('plan', c.taskBrief(
    `Use the flow-plan-ticket skill, unattended. ${c.ticketSource()} ${UNTRUSTED_READ_RULE}\n` +
    `Premise check: ${c.out.premise.verdict}. Its evidence quotes the ticket and the repo:\n${untrusted(c, c.out.premise.evidence, 'premise-evidence', suspicious)}\n` +
    `Write the plan to exactly ${target} and return that path as planPath. ${PLAN_OUTSIDE_REPO} Return a short planSummary, the ticketKind, the premiseVerdict, and ` +
    'authorisedFiles: every path or directory prefix (ending in /) the implementation may touch. The fix rounds are fenced to that list.'), 'plan')
  if (!r || !r.ok) throw c.stop('parked', `plan: ${r ? clip(r.notes, 200) : 'no result'}`)
  if (r.premiseVerdict === 'falsified' || r.premiseVerdict === 'corrected-without-oracle') {
    if (c.out.premise && c.out.premise.verdict === 'holds')
      c.overturn({ phase: 'premise', lane: 'premise', detail: 'ticket', field: 'verdict' }, 'lane', 'plan', r.premiseEvidence || r.planSummary)
    await c.decide({ kind: 'premise', question: `The plan found the premise of ${c.TICKET} ${r.premiseVerdict}. Proceed with the corrected premise?`,
      why: clip(r.premiseEvidence || r.planSummary, 1000), options: ['proceed with the corrected premise', 'send the ticket back for rewriting'],
      recommendation: 'send the ticket back for rewriting', reversalCost: 'low: only a plan file exists' })
    throw c.stop('parked', `premise ${r.premiseVerdict}`)
  }
  if (r.planPath !== target) throw c.stop('parked', `plan: the lane put the plan at ${clip(r.planPath, 200)}, not at ${target}`)
  const fence = Array.isArray(r.authorisedFiles) ? r.authorisedFiles : []
  if (!fence.length || fence.some(f => ['', '/', '.', './', '*', '**', '**/'].includes(String(f).trim())))
    throw c.stop('parked', `plan: authorisedFiles ${fence.length ? `fences nothing (${clip(fence.join(', '), 200)})` : 'is empty or missing'}`)
  c.out.plan = withSuspicious({ planPath: target, planSummary: clip(r.planSummary, 600), ticketKind: r.ticketKind, authorisedFiles: r.authorisedFiles }, suspicious)
  await c.checkpoint('plan', c.out.plan)
}

export async function implement(c) {
  const r = await c.lane('implement', c.taskBrief(
    `Use the flow-tdd skill: red, green, refactor, following the plan at ${c.out.plan.planPath}. ${PLAN_OUTSIDE_REPO} Touch only: ${c.out.plan.authorisedFiles.join(', ')}. ` +
    'Commit locally with flow-create-commit; never push. Return headSha, the commit list, the exact testCommand you ran and testResult "pass" or "fail".'), 'tdd')
  if (!r || !r.ok) throw c.stop('parked', `implement: ${r ? clip(r.notes, 200) : 'no result'}`)
  const claim = /pass/i.test(r.testResult) ? 'pass' : 'fail'
  c.verdict(r, 'implement', 'testResult', claim, 'tdd')
  c.verdict(r, 'implement', 'headSha', r.headSha, 'tdd')
  c.head = await measuredHead(c, r.headSha, 'implement')
  c.out.implement = { headSha: c.head, commits: (r.commits || []).slice(0, 20), testCommand: clip(r.testCommand, 200), claim }
  await c.checkpoint('implement', c.out.implement)
}

// A lane's headSha is a claim; the worktree is measured instead. A claim that disagrees, a dirty tree
// or a head without the base is held for the gate, and the run goes on with the measured head.
export async function measuredHead(c, claimed, source) {
  const t = await c.run('git/head-truth.mjs', ['--repo', c.wt, '--base', c.out.start.baseSha, ...(claimed ? ['--expect', String(claimed)] : [])], 'head-truth')
  const hold = summary => c.holdHarness([{ id: `head-truth-${source}`, severity: 'high', source: 'harness', summary: clip(summary, 200) }])
  if (t.status !== 'ok' || !t.headSha) { hold(`head unmeasured after ${source}: ${t.reason || t.kind || t.status}`); return c.head }
  if (!claimed) hold(`${source} returned no headSha; the worktree is at ${t.headSha}`)
  else if (!t.matchesExpect) {
    hold(`${source} claimed ${claimed}; the worktree is at ${t.headSha}`)
    if (source === 'implement') c.overturn({ phase: 'implement', lane: 'implement', detail: 'tdd', field: 'headSha' }, 'script', 'head-truth', `worktree at ${t.headSha}`)
  }
  if (!t.clean) hold(`uncommitted changes after ${source}: ${(t.dirty || []).slice(0, 10).join(', ')}`)
  if (t.descendsFromBase === false) hold(`${t.headSha} after ${source} does not contain the base ${c.out.start.baseSha}`)
  return t.headSha
}

// The claimant's "green" is never trusted: the profile's own test command is re-run.
export async function verifyClaim(c) {
  // A profile's `## test toolchain` table keys rows by the repo's short name (see
  // the profile: "widget", never "example-org/widget"), so the org/repo slug facts.repos
  // carries is never a substring of any row; fall back to its last path segment instead.
  const match = c.args.testMatch || String(c.PRIMARY.repo || '').split('/').pop() || ''
  const r = await c.run('resilience/verify-claim.mjs', [c.F.profilePath, match, 'pass', '--cwd', c.wt, '--expect-sha', c.head], 'verify-claim')
  // Not measured is not a mismatch: no fix agent can repair the profile's toolchain, so a blocked
  // claim never enters a fix round. The gate still reads it, as `blocked`, and holds the merge.
  if (r.status !== 'ok') return { ok: false, blocked: true, finding: `verify-claim could not run: ${r.reason || r.kind}` }
  return r.actual === 'pass' ? { ok: true } : { ok: false, finding: `the test command "${r.command}" fails on ${c.head} (exit ${r.exitCode})` }
}
export const claimFinding = claim => claim.ok || claim.blocked ? [] : [{ id: 'claim-mismatch', axis: 'spec', severity: 'blocker', summary: claim.finding, locations: [] }]

// The profile's static checks run before the axes, so no axis spends a finding on what a compiler
// or linter already reports. One that cannot run is blocked for the gate, never a fix round.
export async function runStatic(c, only) {
  const results = []
  for (const s of (c.F.staticChecks || []).filter(s => !only || only.includes(s.check))) {
    const r = await c.run('resilience/verify-claim.mjs', [c.F.profilePath, s.check, 'pass', '--cwd', c.wt, '--section', 'static checks', '--expect-sha', c.head], 'static-check')
    results.push(r.status !== 'ok'
      ? { check: s.check, state: 'blocked', kind: r.kind || 'toolchain', reason: clip(r.reason || r.status, 200) }
      : { check: s.check, state: r.actual === 'pass' ? 'green' : 'red', command: clip(r.command, 200), exitCode: r.exitCode })
  }
  c.statics = [...(c.statics || []).filter(s => !results.some(x => x.check === s.check)), ...results]
  return results
}
const staticFindings = (c, results) => results.filter(r => r.state === 'red').map(r => ({ id: `static-${r.check}`, axis: 'standards', severity: 'blocker',
  summary: `static check ${r.check} ("${r.command}") fails on ${c.head} (exit ${r.exitCode})`, locations: [] }))
const staticNote = c => (c.statics || []).length
  ? `Static checks already run on ${c.head}: ${c.statics.map(r => `${r.check}: ${r.state}`).join(', ')}. Do not raise what these checks cover ` +
    '(type errors, lint rules, failing tests); the runner reports a red or blocked check itself.\n'
  : ''

// Fix rounds are one budget for the review phase and the review-bot phase.
export async function fixRound(c, findings, source) {
  const n = await c.counter('fixRounds', false)
  if (n.capReached) {
    const what = findings.map(f => f.id ? `${f.id}: ${f.summary}` : (f.summary || f)).join('; ')
    await c.decide({ kind: 'split', question: `The fix-round cap (${n.value}/${n.cap}) is spent and these stay open: ${clip(what, 600)}. Split them into a separate ticket?`,
      why: `open after ${source}`, options: [`split into a separate ticket: ${clip(what, 200)}; this PR goes on without them`, 'leave them as known-open in the PR body and merge', 'authorise a named extra round on this PR'],
      recommendation: `split into a separate ticket: ${clip(what, 200)}`, reversalCost: 'low: a split ticket can be closed as a duplicate; extra rounds on the same PR tend to add new defects', blocks: `merge of ${c.prUrl || c.TICKET}` })
    return null
  }
  c.defer(['counter', c.TICKET, 'fixRounds', '--inc', '--key', c.incKey()])
  const r = await c.lane('fix', c.taskBrief(
    `Fix exactly these findings (source: ${source}) and nothing else, test-first where behaviour changes:\n` +
    findings.map(f => `- ${f.id || 'finding'} [${f.severity || 'high'}] ${f.summary || f} ${(f.locations || []).join(', ')}`).join('\n') +
    `\n${UNTRUSTED_READ_RULE}\nStay inside: ${c.out.plan.authorisedFiles.join(', ')}. Commit locally${c.prUrl ? ' and push to the PR branch' : ''}. ${c.FIX_GUARD} Return the new headSha, fixed[] and skipped[] ids.`), source)
  if (!r) return null
  c.head = await measuredHead(c, r.headSha, `fix-${source}`)
  const fence = await c.run('git/scope-fence.mjs', ['--repo', c.wt, '--pin', c.out.start.baseSha, '--head', c.head, '--authorised', ...c.out.plan.authorisedFiles], 'scope-fence')
  if (fence.status !== 'ok') c.holdHarness([{ id: 'scope-fence', severity: 'high', source: 'harness', summary: `scope fence unmeasured after the fix round: ${fence.reason || fence.kind}` }])
  return { ...r, extra: fence.status === 'ok' ? fence.extra || [] : [] }
}

const axisPrompt = (c, axis, extra) => c.taskBrief(
  `Use the flow-code-review skill, axis "${axis}" only: follow the "## ${axis[0].toUpperCase()}${axis.slice(1)}" section of its ` +
  `references/subagent-briefs.md. Review ${c.BASE}..${c.head} in ${c.wt} against the plan at ${c.out.plan.planPath}. ${c.NO_DISPATCH}\n${staticNote(c)}${extra || ''}` +
  `Return axis "${axis}", reviewedSha ${c.head}, findings with severity blocker|high|medium|low, and a short report. ` +
  'Give a finding source "harness" (or verify-claim, exec, toolchain) when it is about the run\'s own tooling, not the code; it is held for the gate, never sent to a fix agent.')

const SEVERITY_RANK = { blocker: 3, high: 2, medium: 1, low: 0 }
const rankOf = s => SEVERITY_RANK[s] ?? -1

// Two axes disagree on a file when one raises a severe finding there and the other raises nothing
// there at any severity.
export function disagreements(c, open, byAxis) {
  const paths = findings => new Set((findings || []).flatMap(f => (f.locations || []).map(c.pathOf)).filter(Boolean))
  const seen = Object.fromEntries(Object.entries(byAxis).map(([axis, findings]) => [axis, paths(findings)]))
  return open.filter(f => {
    const mine = (f.locations || []).map(c.pathOf).filter(Boolean)
    const others = Object.keys(byAxis).filter(a => a !== f.axis)
    return mine.length > 0 && others.length > 0 && others.some(a => !mine.some(p => seen[a].has(p)))
  })
}

// A downgrade stands only with a reason and evidence; the lane is refuted otherwise.
const unevidenced = r => (r.verdicts || []).find(v => v.verdict === 'downgrade' && (!String(v.reason || '').trim() || String(v.evidence || '').trim().length < 8))
export const verifyOpinion = r => { const v = unevidenced(r); return v ? `downgrade of ${v.id} without reason or evidence` : null }

// One second opinion per run (caps.secondOpinions) on the contested findings, from a model other
// than the one that raised them when the catalogue admits one at that tier or above. A verdict may
// lower a finding's severity with evidence; it never raises one, adds one or touches merge authority.
async function secondOpinion(c, open, contested, why) {
  if (!contested.length || (await c.counter('secondOpinions', false)).capReached) return open
  await c.counter('secondOpinions', true)
  const avoid = contested.map(f => f.model).find(Boolean) || null
  const r = await c.lane('second-opinion', c.taskBrief(
    `Use the flow-code-review skill as an independent second reviewer of ${c.BASE}..${c.head} in ${c.wt} (${why}). ${c.NO_DISPATCH}
` +
    `Contested findings:
${c.findingLines(contested)}
` +
    'For each id return a verdict: "uphold" keeps its severity; "downgrade" lowers it to the severity you give, with a reason and evidence ' +
    '(path:line, a quote or command output). You cannot raise a severity, add findings or change who may merge. ' +
    `Return reviewedSha ${c.head} and a short report.`), why, { avoid, verify: verifyOpinion })
  if (!r) return open
  const verdicts = new Map((r.verdicts || []).map(v => [v.id, v]))
  const kept = []
  for (const f of open) {
    const v = verdicts.get(f.id)
    if (!v || v.verdict !== 'downgrade' || rankOf(v.severity) >= rankOf(f.severity)) { kept.push(f); continue }
    c.overturn({ phase: c.cur, lane: 'review-axis', detail: f.axis, field: `finding:${f.id}` }, 'lane', 'second-opinion', `${v.reason} — ${v.evidence}`)
    const lowered = { ...f, severity: v.severity }
    if (c.severe([lowered]).length) kept.push(lowered)
  }
  c.out.secondOpinion = { why, model: c.modelOf(r), contested: contested.map(f => f.id), verdicts: (r.verdicts || []).map(v => ({ id: v.id, verdict: v.verdict, severity: v.severity })) }
  return kept
}

// Lanes may return a short SHA; anything shorter than 7 hex characters proves nothing.
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))

// Review lanes are read-only, so the head they reviewed is measured around them, never taken from their
// reply: a lane can echo the SHA its brief names. A head that is unmeasured or moved makes the result missing.
async function headNow(c) {
  const t = await c.run('git/head-truth.mjs', ['--repo', c.wt], 'head-truth')
  return t.status === 'ok' && t.headSha ? t.headSha : null
}
const onHead = (c, scope, prompt, detail) => c.withScope(scope, async () => {
  const before = await headNow(c)
  const r = await c.lane('review-axis', prompt, detail)
  const after = await headNow(c)
  return r && sameSha(before, c.head) && sameSha(after, c.head) ? r : null
})

export async function review(c) {
  const claim = await verifyClaim(c)
  if (!claim.ok && !claim.blocked && c.out.implement && c.out.implement.claim === 'pass')
    c.overturn({ phase: 'implement', lane: 'implement', detail: 'tdd', field: 'testResult' }, 'script', 'verify-claim', claim.finding)
  await runStatic(c)
  const results = await c.fanOut(c.AXES.map(axis => () => onHead(c, `axis:${axis}`, axisPrompt(c, axis), axis)))
  let open = []
  const missing = []
  const byAxis = {}
  c.AXES.forEach((axis, i) => {
    if (!results[i]) { missing.push(axis); return }
    byAxis[axis] = results[i].findings || []
    for (const f of c.severe(results[i].findings)) c.verdict(results[i], 'review-axis', `finding:${f.id}`, f.severity, axis)
    open.push(...c.severe(results[i].findings).map(f => ({ ...f, axis, model: c.modelOf(results[i]) })))
  })
  open = c.holdHarness(open)
  open = await secondOpinion(c, open, disagreements(c, open, byAxis), 'axes disagree')
  open.push(...claimFinding(claim), ...staticFindings(c, c.statics))
  while (open.length) {
    if ((await c.counter('fixRounds', false)).capReached) open = await secondOpinion(c, open, open.filter(f => f.axis && f.model), 'fix rounds exhausted')
    if (!open.length) break
    const fixed = await fixRound(c, open, 'review')
    if (!fixed) break
    if (fixed.extra.length) open.push({ id: 'scope', axis: 'standards', severity: 'high', summary: `changes outside the authorised files: ${fixed.extra.join(', ')}`, locations: fixed.extra })
    const byAxis = [...new Set(open.map(f => f.axis))]
    const again = await c.fanOut(byAxis.map(axis => () => onHead(c, `reverify:${axis}`, axisPrompt(c, axis,
      `Re-verify only these findings you raised: ${open.filter(f => f.axis === axis).map(f => `${f.id}: ${f.summary}`).join('; ')}. ` +
      'List each as resolved (with evidence) or stillOpen; add only new blocker/high findings.\n'), `${axis}:reverify`)))
    const stillOpen = []
    byAxis.forEach((axis, i) => {
      const r = again[i]
      const mine = open.filter(f => f.axis === axis && f.id !== 'claim-mismatch' && f.id !== 'scope' && !f.id.startsWith('static-'))
      if (!r) { stillOpen.push(...mine); return }
      // Only an explicit resolution closes a finding; one the output leaves out stays open.
      const resolved = new Set((r.resolved || []).map(x => x && x.id))
      stillOpen.push(...mine.filter(f => !resolved.has(f.id) || (r.stillOpen || []).includes(f.id)), ...c.holdHarness(c.severe(r.findings)).map(f => ({ ...f, axis })))
    })
    const reclaim = open.some(f => f.id === 'claim-mismatch') ? await verifyClaim(c) : { ok: true }
    stillOpen.push(...claimFinding(reclaim))
    const rerun = open.filter(f => f.id.startsWith('static-')).map(f => f.id.slice('static-'.length))
    if (rerun.length) stillOpen.push(...staticFindings(c, await runStatic(c, rerun)))
    // An axis may list a finding it keeps open both in stillOpen and again among its findings.
    open = stillOpen.filter((f, i) => stillOpen.findIndex(g => g.id === f.id && g.axis === f.axis) === i)
  }
  c.out.review = { headSha: c.head, reviewedSha: c.head, missing, harness: [...c.harnessFindings], staticChecks: c.statics, secondOpinion: c.out.secondOpinion || null, open: open.map(f => ({ id: f.id, axis: f.axis, severity: f.severity, summary: clip(f.summary, 200), locations: (f.locations || []).slice(0, 10).map(l => clip(l, 200)) })) }
  await c.checkpoint('review', c.out.review)
  const signed = [...new Set(c.signatureBlockers(open))]
  if (signed.length) throw c.stop('parked', clip(`review: blocker finding(s) open after the fix-round cap on path(s) that need a signature: ${signed.join(', ')}`, 600))
  if (missing.length) {
    await c.decide({ kind: 'gate-red', question: `Review axis ${missing.join(', ')} returned nothing twice. Re-run it or accept the gap?`, why: 'a missing axis is a failed review condition',
      options: ['re-run the missing axis in a fresh run', 'accept the gap for this ticket'], recommendation: 're-run the missing axis in a fresh run', reversalCost: 'low' })
    throw c.stop('parked', `review axis missing: ${missing.join(', ')}`)
  }
}

// The PR title is a commit-format subject line (flow-create-commit's type table and ticket prefix).
// The lane's schema only guarantees a string; raw prose once became the title verbatim.
const COMMIT_TYPES = ['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'perf', 'build', 'ci', 'style']
const PR_TITLE_RE = new RegExp(`^\\[[A-Z]+-\\d+\\] (${COMMIT_TYPES.join('|')})(\\([^)]+\\))?: .+`)

// `chore` is the only type that claims nothing about the change the runner cannot verify, unless the
// plan already named this a diagnosed bug.
const deterministicTitle = c => {
  const type = c.out.plan && c.out.plan.ticketKind === 'bug-after-diagnosis' ? 'fix' : 'chore'
  const summary = clip(String((c.out.plan && c.out.plan.planSummary) || `${c.TICKET} changes`).replace(/\s+/g, ' ').trim(), 100) || `${c.TICKET} changes`
  return `[${c.TICKET}] ${type}: ${summary}`
}

export async function pr(c) {
  const known = c.out.review.open || []
  const prTask =
    `Use the flow-create-pull-request skill for the prose only. Write the title and body for ${c.BASE}..${c.head}: the change, why, how it was verified. ` +
    'Impersonal, no names, no attribution. Do not push or open anything.' +
    (known.length ? ` ${known.length} review finding(s) stay open after the fix-round cap; the runner puts them at the top of the body itself, so do not repeat them and do not say the review is clean.` : '') +
    ` The title must be exactly one commit-format subject line: "[${c.TICKET}] <type>[(scope)]: <summary>", type one of ${COMMIT_TYPES.join(', ')}. No other prose in the title.`
  let d = await c.lane('pr-description', c.taskBrief(prTask), 'prose')
  if (!d) throw c.stop('parked', 'pr-description returned nothing')
  if (!PR_TITLE_RE.test(d.title || '')) {
    const reason = `the title ${JSON.stringify(clip(d.title, 200))} does not match ^\\[TICKET-NUMBER\\] type(scope)?: summary (type one of ${COMMIT_TYPES.join(', ')})`
    const retry = await c.lane('pr-description', c.taskBrief(
      `${prTask}\n\nThe previous title was rejected: ${reason}. Return a corrected title in exactly that shape, e.g. "[${c.TICKET}] fix: short summary".`), 'prose-retry')
    d = retry && PR_TITLE_RE.test(retry.title || '') ? retry : { ...d, title: deterministicTitle(c) }
  }
  const bodyFile = `${c.ROOT}/tickets/${c.TICKET}/pr-body.md`
  const main = known.length
    ? `## Open review findings (fix-round cap reached)\n\nThe review stopped after the fix-round cap with these open. The merge gate holds on them.\n\n${c.findingLines(known)}\n\n---\n\n${d.body}`
    : d.body
  const body = c.notes.length ? `${main}\n\n## Environment notes\n\nReported by the run's agents; not decisions.\n\n${c.noteLines()}\n` : main
  const w = await c.harness(['write', '--file', bodyFile, '--text', body], 'pr-body')
  if (w.status !== 'ok') throw c.stop('parked', `pr body: ${w.reason || w.kind}`)
  const push = await c.harness(['push', '--cwd', c.wt, '--branch', c.branch], 'push')
  if (push.status !== 'ok') throw c.stop('parked', `push: ${push.reason || push.kind}`)
  const r = await c.run('forge/pr-open.mjs', ['--repo', c.REPO_SLUG, '--base', c.BASE, '--head', c.branch, '--title', d.title, '--body-file', bodyFile])
  if (r.status !== 'ok') throw c.stop('parked', `pr-open: ${r.reason || r.kind}`)
  c.prUrl = r.prUrl; c.prNumber = r.number
  c.defer(['set-status', c.TICKET, 'open-pr', '--pr', c.prUrl])
  const proxy = await c.ownerProxy('undraft-pr', `PR ${c.prUrl} at ${c.head}; ${known.length ? `${known.length} blocker/high review finding(s) open after the fix-round cap, listed in the PR body: ${clip(known.map(f => f.id).join(', '), 200)}` : 'review round closed with no open blocker/high findings'}.`)
  let draft = true
  let draftEvidence = null
  if (proxy.action === 'act') {
    const ready = await c.run('forge/pr-ready.mjs', ['--repo', c.REPO_SLUG, '--pr', String(c.prNumber)])
    draft = ready.status !== 'ok'
    if (draft) draftEvidence = clip(ready.reason || ready.kind || 'pr-ready did not confirm the PR left draft', 300)
  } else {
    await c.decide({ kind: 'question', question: `Take ${c.prUrl} out of draft?`, why: clip(proxy.rationale), options: ['take it out of draft', 'keep it as draft'], recommendation: 'take it out of draft', reversalCost: 'low', blocks: 'review-bot gate' })
    draftEvidence = 'left in draft: owner proxy did not act on the undraft mandate'
  }
  c.out.pr = { prUrl: c.prUrl, number: c.prNumber, headSha: c.head, draft, draftEvidence }
  await c.checkpoint('pr', c.out.pr)
}

// CI: a blocking script wait, never polling by an agent turn. Each wait is its own step, so a
// resumed run replays the waits that already settled and goes on with the next one.
async function waitCi(c) {
  for (let recall = 0; ; recall++) {
    const r = await c.run('forge/wait-ci.mjs', ['--repo', c.REPO_SLUG, '--sha', c.head, '--timeout', String(c.CAPS.waitCiSeconds)], 'wait-ci')
    if (r.status === 'pending') {
      if (recall + 1 >= c.CAPS.waitCiRecalls) return { state: 'blocked', headSha: c.head, evidence: 'checks not settled', timeout: true }
      continue
    }
    if (r.status !== 'ok') return { state: 'blocked', headSha: c.head, evidence: r.reason || r.kind }
    return { state: r.state, headSha: c.head, evidence: (r.checks || []).filter(x => x.conclusion !== 'success').map(x => `${x.name}: ${x.conclusion}`).join('; ') || 'all checks success', checks: r.checks }
  }
}

async function observeCommandGate(c, gate) {
  const r = await c.harness(['command', '--cwd', c.wt, '--cmd', gate.source.ref], `gate-${gate.name}`)
  return { state: r.status === 'ok' ? r.state : 'blocked', headSha: c.head, evidence: `exit ${r.exitCode}` }
}

// A re-observation after the ci phase (a later fix round, an update from base) adds what it saw to out.ci.
export async function ciObservations(c, into) {
  const suspicious = into || []
  const obs = {}
  for (const gate of (c.F.gates || []).filter(g => g.source.type !== 'bot')) {
    if (gate.source.type === 'command') { obs[gate.name] = await observeCommandGate(c, gate); continue }
    for (;;) {
      const o = await waitCi(c)
      if (o.timeout) {
        await c.decide({ kind: 'ci-timeout', question: `CI on ${c.head} did not settle. Re-run the checks or wait longer?`, why: `${c.CAPS.waitCiRecalls} waits of ${c.CAPS.waitCiSeconds}s`,
          options: ['re-run the checks', 'wait for the next run of the day'], recommendation: 're-run the checks', reversalCost: 'low' })
      }
      if (o.state !== 'red') { obs[gate.name] = o; break }
      const n = await c.counter('ciFix', false)
      if (n.capReached) {
        await c.decide({ kind: 'ci-red', question: `CI stays red on ${c.head} after ${n.value} fix attempts: ${clip(o.evidence, 300)}. Take over or split?`, why: 'ci-fix cap reached',
          options: ['a human takes over the red checks', 'split the failing part into a separate ticket'], recommendation: 'a human takes over the red checks', reversalCost: 'low' })
        obs[gate.name] = o; break
      }
      c.defer(['counter', c.TICKET, 'ciFix', '--inc', '--key', c.incKey()])
      const f = await c.lane('fix', c.taskBrief(
        `CI is red on ${c.head}. The failing checks, as the forge names them:\n${untrusted(c, o.evidence, 'ci-checks', suspicious)}\n${UNTRUSTED_READ_RULE}\n` +
        `Reproduce locally, fix test-first, commit and push to ${c.branch}. ${c.FIX_GUARD} Return the new headSha.`), 'ci')
      if (!f) { obs[gate.name] = o; break }
      c.head = await measuredHead(c, f.headSha, 'fix-ci')
    }
  }
  if (!into && suspicious.length && c.out.ci) c.out.ci.suspicious = [...(c.out.ci.suspicious || []), ...suspicious].slice(0, 20)
  return obs
}

export async function ci(c) {
  const suspicious = []
  c.out.ci = withSuspicious({ headSha: c.head, observations: await ciObservations(c, suspicious) }, suspicious)
  await c.checkpoint('ci', c.out.ci)
}

export async function botObservations(c) {
  const obs = {}
  for (const gate of (c.F.gates || []).filter(g => g.source.type === 'bot')) {
    // A bot review skips a draft PR outright, so polling it only burns the wait budget.
    if (c.out.pr && c.out.pr.draft) {
      obs[gate.name] = { state: 'blocked', headSha: c.head, evidence: `PR ${c.prUrl} is still draft: ${c.out.pr.draftEvidence || 'undraft did not take effect'}` }
      continue
    }
    const argv = ['--repo', c.REPO_SLUG, '--pr', String(c.prNumber), '--sha', c.head, '--bot', gate.source.ref]
    for (const p of gate.skipPatterns || []) argv.push('--skip-pattern', p)
    let o = null
    for (let recall = 0; recall < c.CAPS.waitCiRecalls; recall++) {
      argv[5] = c.head
      const r = await c.run('forge/review-bot-green.mjs', argv, `bot-${gate.name}`)
      if (r.status !== 'ok') { o = { state: 'blocked', headSha: c.head, evidence: r.reason || r.kind }; break }
      if (r.matchedSkipPattern) {
        await c.decide({ kind: 'quota', question: `${gate.source.ref} skipped the review of ${c.head} ("${r.matchedSkipPattern}"). Wait for the window or ask for a manual review?`,
          why: 'a skipped review is not a review', options: ['wait for the bot window and re-request', 'ask a human reviewer instead'], recommendation: 'wait for the bot window and re-request', reversalCost: 'low' })
        o = { state: 'blocked', headSha: c.head, evidence: `skipped: ${r.matchedSkipPattern} — "${clip(r.matchedSkipBody || r.matchedSkipPattern, 400)}"` }; break
      }
      if (!r.reviewed) { await c.harness(['sleep', '--seconds', String(c.CAPS.waitCiSeconds)], 'bot-wait'); continue }
      if (r.green) { o = { state: 'green', headSha: c.head, evidence: `review ${r.reviewId} on ${r.reviewCommit}` }; break }
      const fixed = await fixRound(c, [{ id: `${gate.name}-threads`, severity: 'high', summary: `answer every open ${gate.source.ref} thread on ${c.prUrl} with a fix commit or a reasoned rebuttal. ${c.reviewBotPredicate(gate)}` }], gate.name)
      if (!fixed) { o = { state: 'red', headSha: c.head, evidence: 'threads open after the fix-round cap' }; break }
      const again = await ciObservations(c)
      Object.assign(c.out.ci.observations, again)
      c.out.ci.headSha = c.head
    }
    obs[gate.name] = o || { state: 'blocked', headSha: c.head, evidence: 'no review of the head within the wait budget' }
  }
  return obs
}

export async function reviewBot(c) {
  c.out['review-bot'] = { headSha: c.head, observations: await botObservations(c) }
  await c.checkpoint('review-bot', c.out['review-bot'])
}

// The scripted security dimension. Its findings are measured, not claimed, so they skip the reverify
// lane; a scan that cannot answer is a held high finding, so the gate blocks instead of passing.
async function securityScan(c) {
  const r = await c.run('security/scan-diff.mjs', ['--repo', c.wt, '--base', c.out.start.baseSha, '--head', c.head, '--profile', c.F.profilePath], 'scan-diff')
  const failed = r.status !== 'ok' || !Array.isArray(r.findings)
  const findings = failed
    ? [{ id: 'SEC-SCAN-ERROR', axis: 'security', category: 'scan-error', severity: 'high', source: 'harness', summary: clip(`security scan did not run on ${c.head}: ${r.reason || r.kind || 'no findings list'}`, 200), locations: [] }]
    : r.findings.map(f => ({ ...f, dimension: 'security-scan' }))
  return { status: failed ? 'blocked' : 'ok', total: failed ? 1 : r.total ?? findings.length, artifact: r.artifact || null, findings }
}
const scanNote = scan => scan.status !== 'ok' ? '' :
  `The scripted security scan (scan-diff) already ran on this head: ${scan.findings.length ? scan.findings.map(f => `${f.id} [${f.severity}] ${(f.locations || []).join(', ')}`).join('; ') : 'no finding'}. ` +
  'It covers credential shapes, dependency-file changes and the profile\'s audit command; do not raise those again, but do judge what a changed dependency brings in.\n'

export async function confidence(c) {
  let confirmedOpen = []
  let reverified = 0
  let scan = null
  for (;;) {
    const pass = await c.counter('confidencePasses', true)
    scan = await securityScan(c)
    const scripted = c.holdHarness(c.severe(scan.findings))
    const dims = await c.fanOut(c.DIMENSIONS.map(dim => () => c.withScope(`dim:${dim}`, () => c.lane('confidence-dim', c.taskBrief(
      `Use the flow-confidence-check skill, dimension "${dim}" only (references/subagent-prompts.md). Grade ${c.BASE}..${c.head} on PR ${c.prUrl}. ${c.NO_DISPATCH}\n${UNTRUSTED_READ_RULE}\n${scanNote(scan)}` +
      `Return dimension "${dim}", reviewedSha ${c.head}, findings with severity, and acCoverage for every acceptance criterion.`), dim))))
    const missingDims = c.DIMENSIONS.filter((d, i) => !dims[i])
    for (const d of dims.filter(Boolean)) for (const f of c.severe(d.findings)) c.verdict(d, 'confidence-dim', `finding:${f.id}`, f.severity, d.dimension)
    const candidates = c.holdHarness(dims.filter(Boolean).flatMap(d => c.severe(d.findings).map(f => ({ ...f, dimension: d.dimension }))))
    const perPass = candidates.slice(0, c.CAPS.reverifyPerPass)
    if (candidates.length > perPass.length) c.log(`${c.TICKET}: ${candidates.length - perPass.length} confidence finding(s) beyond reverifyPerPass left unverified and counted as confirmed`)
    const verdicts = await c.fanOut(perPass.map(f => () => c.withScope(`reverify:${f.id}`, () => c.lane('reverify', c.taskBrief(
      `Try to refute this finding on ${c.head}; default to confirmed only with file:line evidence. Finding ${f.id} [${f.severity}] (${f.dimension}): ${f.summary} ${(f.locations || []).join(', ')}. ` +
      `Return findingId "${f.id}", verdict confirmed|refuted and a rationale.`), f.id))))
    reverified += perPass.length
    perPass.forEach((f, i) => { if (verdicts[i] && verdicts[i].verdict === 'refuted')
      c.overturn({ phase: 'confidence', lane: 'confidence-dim', detail: f.dimension, field: `finding:${f.id}` }, 'lane', 'reverify', verdicts[i].rationale) })
    confirmedOpen = [...scripted, ...perPass.filter((f, i) => !verdicts[i] || verdicts[i].verdict !== 'refuted'), ...candidates.slice(c.CAPS.reverifyPerPass)]
    if (missingDims.length) confirmedOpen.push({ id: 'missing-dimension', severity: 'high', summary: `dimension(s) returned nothing: ${missingDims.join(', ')}` })
    if (!confirmedOpen.length) break
    if (pass.capReached) {
      await c.decide({ kind: 'confidence-cap', question: `Confidence still finds ${confirmedOpen.length} confirmed high+ issue(s) after ${pass.value} passes: ${clip(confirmedOpen.map(f => f.summary).join('; '), 500)}. Split or take over?`,
        why: 'confidence-pass cap reached', options: ['split the open issues into a separate ticket', 'a human takes over this branch'], recommendation: 'split the open issues into a separate ticket', reversalCost: 'low' })
      break
    }
    const f = await c.lane('fix', c.taskBrief(
      `Fix these confirmed findings, one commit per finding with its id in the message, and push to ${c.branch}:\n` +
      confirmedOpen.map(x => `- ${x.id} [${x.severity}] ${x.summary} ${(x.locations || []).join(', ')}`).join('\n') + `\n${c.FIX_GUARD} Return the new headSha.`), 'confidence')
    if (!f) break
    c.head = await measuredHead(c, f.headSha, 'fix-confidence')
    Object.assign(c.out.ci.observations, await ciObservations(c))
    // A confidence fix moves the head like a review fix round; review-bot's observation must move
    // with it or the gate reads a stale review pinned to the pre-fix commit.
    Object.assign(c.out['review-bot'].observations, await botObservations(c))
  }
  c.out.confidence = { headSha: c.head, reverified, harness: [...c.harnessFindings], open: confirmedOpen.map(f => ({ id: f.id, severity: f.severity, summary: clip(f.summary, 200) })),
    securityScan: { status: scan.status, total: scan.total, artifact: scan.artifact,
      findings: scan.findings.slice(0, 20).map(f => ({ id: f.id, category: f.category, severity: f.severity, summary: clip(f.summary, 200), locations: (f.locations || []).slice(0, 5) })) } }
  await c.checkpoint('confidence', c.out.confidence)
}

// A PR can fall behind or into conflict during hours of CI and bot waits, so mergeability is read
// before every gate. The update is a script and a conflict is never resolved here: it blocks the
// gate with the files named. A moved head is re-observed by CI and the bot here, and by the review
// axes through runGate's repin.
const outOfDate = s => ['BEHIND', 'DIRTY'].includes(s.mergeStateStatus) || s.mergeable === 'CONFLICTING'
export async function updateFromBase(c) {
  const s = await c.run('forge/pr-state.mjs', ['--repo', c.REPO_SLUG, '--pr', String(c.prNumber)])
  if (s.status !== 'ok') return { state: 'blocked', evidence: `mergeability unreadable: ${s.reason || s.kind}` }
  if (!outOfDate(s)) return { state: 'green', evidence: `${s.mergeStateStatus}, ${s.mergeable}` }
  const n = await c.counter('rebase', true)
  if (n.value > n.cap) return { state: 'blocked', evidence: `still ${s.mergeStateStatus} after ${n.cap} update(s) from ${c.BASE} (rebase cap)` }
  const method = c.F.integrateMain === 'merge' ? 'merge' : 'rebase'
  const lease = (c.F.runPolicy || {}).forcePushAfterRebase === 'with-lease' ? ['--lease'] : []
  const u = await c.run('git/update-from-base.mjs', ['--repo', c.wt, '--base', c.BASE, '--branch', c.branch, '--method', method, ...lease])
  if (u.status === 'blocked' && u.kind === 'conflict')
    return { state: 'blocked', evidence: clip(`${method} onto ${c.BASE} conflicts in ${(u.conflictingFiles || []).join(', ') || 'unnamed files'}`, 600) }
  if (u.status !== 'ok') return { state: 'blocked', evidence: clip(`update from ${c.BASE}: ${u.reason || u.kind}`, 600) }
  if (!u.updated) return { state: 'green', evidence: `${s.mergeStateStatus} on the forge, but ${c.branch} already contains ${c.BASE}` }
  c.head = u.headSha
  Object.assign(c.out.ci.observations, await ciObservations(c))
  c.out.ci.headSha = c.head
  Object.assign(c.out['review-bot'].observations, await botObservations(c))
  return { state: 'green', evidence: `updated from ${c.BASE} by ${method} to ${u.headSha}` }
}

// Profile gates and merge authority, plus the runner's own conditions, fail-closed.
export async function runGate(c) {
  const { out } = c
  const base = await updateFromBase(c)
  if (out.review.reviewedSha !== c.head) {
    const diff = await c.run('git/diff-since-review.mjs', ['--repo', c.wt, '--pin', out.review.reviewedSha, '--out', `${c.args.roots.diffs}/${c.TICKET}-${c.head}.diff`, '--head', c.head])
    if (diff.status === 'ok' && (diff.changedFiles || []).length) {
      const repin = await c.fanOut(c.AXES.map(axis => () => onHead(c, `repin:${axis}`, axisPrompt(c, axis,
        `Review ONLY the delta since your last round, in ${diff.artifact} (${diff.changedFiles.length} file(s)).\n`), `${axis}:repin`)))
      const fresh = repin.flatMap((r, i) => (r ? c.severe(r.findings) : [{ id: `${c.AXES[i]}-repin-missing`, severity: 'high', summary: 'repin returned nothing' }]))
      out.review.open.push(...fresh.map(f => ({ id: f.id, severity: f.severity, summary: clip(f.summary, 200) })))
    }
    out.review.reviewedSha = c.head
  }
  const files = await c.run('git/diff-since-review.mjs', ['--repo', c.wt, '--pin', out.start.baseSha, '--out', `${c.args.roots.diffs}/${c.TICKET}-full.diff`, '--head', c.head], 'changed-files')
  const observations = { ...out.ci.observations, ...out['review-bot'].observations }
  const g = evaluate({ facts: c.F, headSha: c.head, files: files.status === 'ok' ? files.changedFiles : null, observations })
  const claim = await verifyClaim(c)
  const held = [...(out.confidence.harness || out.review.harness || [])]
  const extra = [
    c.setupCondition(out.start.setup || []),
    c.environmentCondition(),
    { name: 'base', state: base.state, source: 'runner', evidence: base.evidence },
    c.staticCondition(out.review.staticChecks || []),
    { name: 'harness', state: held.length ? 'blocked' : 'green', source: 'runner', evidence: held.map(f => `${f.id} (${f.source}): ${f.summary}`).join('; ') || 'no harness finding' },
    { name: 'review', state: out.review.open.length ? 'red' : 'green', source: 'runner', evidence: out.review.open.map(f => f.id).join(', ') || 'no open blocker/high' },
    { name: 'confidence', state: out.confidence.open.length ? 'red' : 'green', source: 'runner', evidence: out.confidence.open.map(f => f.id).join(', ') || 'no confirmed high+' },
    { name: 'verify-claim', state: claim.ok ? 'green' : claim.blocked ? 'blocked' : 'red', source: 'runner', evidence: claim.ok ? 'test command re-run green' : claim.finding },
    { name: 'changed-files', state: files.status === 'ok' && (files.changedFiles || []).length ? 'green' : 'blocked', source: 'runner', evidence: files.status === 'ok' ? `${(files.changedFiles || []).length} file(s)` : String(files.reason || files.kind) },
  ]
  // Measured over the whole branch, not only fix rounds: a clean review never runs the fix-round fence.
  const fence = await c.run('git/scope-fence.mjs', ['--repo', c.wt, '--pin', out.start.baseSha, '--base-ref', `origin/${c.BASE}`, '--head', c.head,
    '--authorised', ...(out.plan.authorisedFiles || [])], 'scope')
  extra.push(fence.status !== 'ok'
    ? { name: 'scope', state: 'blocked', source: 'runner', evidence: `scope fence unmeasured: ${fence.reason || fence.kind}` }
    : { name: 'scope', state: (fence.extra || []).length ? 'red' : 'green', source: 'runner', evidence: (fence.extra || []).length ? clip(`outside the authorised files: ${fence.extra.join(', ')}`, 600) : 'every changed file authorised' })
  const truth = await c.run('git/head-truth.mjs', ['--repo', c.wt, '--expect', c.head, '--base', out.start.baseSha], 'head-truth')
  const off = truth.status !== 'ok' ? null : [!truth.matchesExpect && `worktree at ${truth.headSha}, not ${c.head}`, !truth.clean && `uncommitted: ${(truth.dirty || []).slice(0, 10).join(', ')}`,
    truth.descendsFromBase === false && `does not contain the base ${out.start.baseSha}`].filter(Boolean)
  extra.push(truth.status !== 'ok'
    ? { name: 'head-truth', state: 'blocked', source: 'runner', evidence: `head unmeasured: ${truth.reason || truth.kind}` }
    : { name: 'head-truth', state: off.length ? 'red' : 'green', source: 'runner', evidence: off.join('; ') || `clean at ${truth.headSha}` })
  if (!(c.F.gates || []).length) extra.push({ name: 'gates', state: 'blocked', source: 'runner', evidence: 'the profile declares no gate' })
  const conditions = [...g.conditions, ...extra]
  const allGreen = conditions.every(x => x.state === 'green')
  return { ...g, conditions, mergeAllowed: g.authority === 'agent' && allGreen, readyToSign: g.authority !== 'agent' && allGreen }
}

export async function gate(c) {
  c.out.gate = await runGate(c)
  await c.checkpoint('gate', c.out.gate)
}

// The merge phase ends the run without a Stop: it sets the status, and qa and cleanup still run.
export async function merge(c) {
  let g = c.out.gate
  let merged = false
  const end = (status, reason) => { c.status = status; if (reason !== undefined) c.reason = reason }
  for (;;) {
    if (!g.mergeAllowed && !g.readyToSign) {
      const red = g.conditions.filter(x => x.state !== 'green')
      await c.decide({ kind: 'gate-red', question: `The gate is not green on ${c.head}: ${red.map(x => `${x.name} (${x.state})`).join(', ')}. Fix forward or take over?`,
        why: clip(red.map(x => `${x.name}: ${x.evidence}`).join('; ')), options: ['fix forward in a fresh run', 'a human takes over the branch'], recommendation: 'fix forward in a fresh run', reversalCost: 'low: the PR stays open', blocks: `merge of ${c.prUrl}` })
      end('parked', clip(`gate: ${red.map(x => `${x.name} ${x.state}`).join(', ')}`, 300)); break
    }
    if (g.readyToSign) {
      await c.decide({ kind: 'ready-to-sign', question: `${c.prUrl} is green on ${c.head} and waits for a signature on ${g.humanPaths.join(', ')}.`,
        why: `merge authority for these paths is ${g.authority}; every gate condition is green`, blocks: `merge of ${c.prUrl}`,
        options: ['sign and merge as it stands', 'send it back with changes requested'], recommendation: 'sign and merge as it stands', reversalCost: 'a revert PR after merge; nothing before' })
      c.defer(['set-status', c.TICKET, 'ready-to-sign', '--pr', c.prUrl])
      end('ready-to-sign'); break
    }
    if (c.args.holdMerge) {
      c.defer(['set-status', c.TICKET, 'open-pr', '--pr', c.prUrl])
      end('open-pr', c.args.holdMergeReason || 'merge held by the launcher'); break
    }
    const s = await c.run('forge/pr-state.mjs', ['--repo', c.REPO_SLUG, '--pr', String(c.prNumber)])
    // Fell behind between the gate and the click: the gate's own base condition updates or parks.
    if (s.status === 'ok' && outOfDate(s)) { g = await runGate(c); continue }
    const m = await c.run('forge/pr-merge.mjs', ['--repo', c.REPO_SLUG, '--pr', String(c.prNumber), '--authority', 'agent', '--sha', c.head])
    if (m.status !== 'ok') {
      await c.decide({ kind: 'gate-red', question: `Merge of ${c.prUrl} refused: ${m.reason || m.kind}.`, why: 'pr-merge did not merge', options: ['retry in a fresh run', 'a human merges'], recommendation: 'retry in a fresh run', reversalCost: 'low' })
      end('parked', clip(`merge refused: ${m.reason || m.kind}`, 300)); break
    }
    c.defer(['set-status', c.TICKET, 'merged', '--pr', c.prUrl])
    merged = true; end('merged'); break
  }
  c.out.merge = { headSha: c.head, merged, status: c.status, gate: { authority: g.authority, mergeAllowed: g.mergeAllowed, readyToSign: g.readyToSign } }
  await c.checkpoint('merge', c.out.merge)
}

export async function qa(c) {
  let result = { skipped: true }
  if (c.out.merge.merged) {
    const r = await c.lane('qa-judge', c.taskBrief(
      `${c.ticketSource()} ${UNTRUSTED_READ_RULE}\nJudge every acceptance criterion against the deployed SHA (${c.PRIMARY.mergingMeans || 'the merge target'}). Oracle first, eyes last. ` +
      'Return deployedSha and, per criterion, verdict pass|fail|needs-human with evidence.'), 'criteria')
    const open = r ? r.criteria.filter(x => x.verdict !== 'pass') : [{ id: 'all', verdict: 'needs-human' }]
    if (open.length) await c.decide({ kind: 'manual-qa', question: `${c.TICKET}: ${open.length} criterion(s) not verified by the runner: ${open.map(x => x.id).join(', ')}.`, why: 'qa-judge could not pass them',
      options: ['verify them by hand', 'accept them as unverified'], recommendation: 'verify them by hand', reversalCost: 'low' })
    result = { deployedSha: r ? r.deployedSha : null, open: open.map(x => x.id) }
  }
  c.out.qa = result
  await c.checkpoint('qa', c.out.qa)
}

export async function cleanup(c) {
  c.out.cleanup = c.out.merge.merged ? { removed: ((await c.run('git/cleanup.mjs', ['--repo', c.REPO_PATH, '--base', c.BASE, '--branch', c.branch, '--worktree', c.wt])).removed || []).length } : { skipped: true }
  await c.checkpoint('cleanup', c.out.cleanup)
}

export const PHASE_FNS = { start, premise, plan, implement, review, pr, ci, 'review-bot': reviewBot, confidence, gate, merge, qa, cleanup }
