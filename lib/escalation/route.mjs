#!/usr/bin/env node
// Escalation routine: source cascade -> resolver -> owner proxy -> human, one hop per call.
//
//   node lib/escalation/route.mjs <input.json | ->
//
// Input:  { facts:    {inviolables, ownerProxy, escalation, profilePath},   from lib/profile-facts.sh
//           decision: a decision record (lib/contract/schemas/decision.json); optional when `step`
//                     names a mandate and there is no question behind it
//           step:     {mandate, channel, authority, foreignPr}   only when what waits is an action
//           answers:  {source: {answer, source}, resolver: <lane-resolver>, owner-proxy: <lane-owner-proxy>} }
// Output: one script-result line, payload {route, next, by, reason, hops, human, record, brief,
//         harnessBlock, doubt}. `route: pending` names the lane to call in `next`; the caller adds
//         its output under `answers[next]` and calls again. Writing `record` is the caller's job
//         (lib/state/state.mjs decide | resolve). Exit 0 whenever routing ran, 1 on unusable input.
//
// Everything above the CLI section is dependency-free: the driver imports it as a plain module.

export const NEVER = ['usage-limit', 'rate-limit', 'quota', 'context-exhaustion', 'harness-blocked', 'stop-hour', 'battery-wait', 'no-progress', 'duplicate', 'locked', 'interrupted-step']
export const SIGN = ['ready-to-sign']
export const MANDATES = ['approve-day-queue', 'start-next-ticket', 'approve-peer-step', 'resume-run', 'lift-cap-once', 'undraft-pr']
export const ROUTES = ['decided', 'proxied', 'pending', 'parked-human', 'inviolable-park', 'ready-to-sign', 'no-escalation', 'invalid-answer']
const TO_HUMAN = ['parked-human', 'inviolable-park', 'ready-to-sign']

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function isDeclaredInviolable(cited, inviolables = []) {
  const c = norm(cited)
  return c !== '' && inviolables.some(i => norm(i).includes(c))
}

function harnessBlockIn(answers) {
  for (const lane of ['resolver', 'owner-proxy']) {
    const hit = (answers[lane]?.awaiting || []).find(a => a.kind === 'harness-blocked')
    if (hit) return { lane, item: hit }
  }
  return null
}

function stripQuestion(record) {
  if (!record || record.kind !== 'harness-blocked') return record
  const { options, recommendation, reversalCost, ...rest } = record
  return rest
}

export function route(input) {
  const { facts = {}, decision = null, step = {}, answers = {} } = input
  const hops = ['resolver', 'owner-proxy'].filter(l => answers[l])
  let record = decision ? { ...decision } : null
  const done = (r, fields = {}) => ({
    route: r, next: null, by: null, reason: '', hops,
    human: TO_HUMAN.includes(r) ? (facts.escalation?.human || null) : null,
    record, ...fields,
  })
  const resolved = (by, resolution) => {
    if (record) record = { ...record, status: 'resolved', resolution, resolvedBy: by }
  }
  const park = (r, reason, recommendation) => {
    if (record && recommendation) record = { ...record, recommendation }
    return done(r, { reason })
  }

  if (record && NEVER.includes(record.kind)) {
    record = stripQuestion(record)
    return done('no-escalation', { reason: `${record.kind} is listed in run state and routed to nobody` })
  }
  if (record && SIGN.includes(record.kind)) return done('ready-to-sign', { reason: 'only a human signature moves it' })

  const block = harnessBlockIn(answers)
  if (block) {
    return done('no-escalation', {
      reason: `${block.lane} hit a harness block; no answer unblocks it`,
      harnessBlock: {
        runId: record?.runId, ticket: record?.ticket, kind: 'harness-blocked', status: 'open',
        question: block.item.question, why: block.item.why, blocks: block.item.blocks,
      },
    })
  }

  if (answers.source?.answer) {
    resolved('source-cascade', answers.source.answer)
    return done('decided', { by: 'source-cascade', reason: `answered from ${answers.source.source || 'sources'}` })
  }

  if (step.authority && step.authority !== 'agent') return done('ready-to-sign', { reason: `hard-stop path: authority ${step.authority}` })
  if (step.foreignPr) return park('parked-human', 'hard-stop path: merging a PR someone else authored')
  if (step.channel) return park('parked-human', `hard-stop channel: ${step.channel}`)

  let mandate = step.mandate || ''
  const res = answers.resolver
  if (!mandate) {
    if (!record) return done('invalid-answer', { reason: 'neither a decision nor a mandate step' })
    if (!res) return done('pending', { next: 'resolver', brief: brief(record, '', facts) })
    if (typeof res.park !== 'boolean') return park('parked-human', 'unreadable resolver answer')
    if (res.inviolable) {
      const declared = isDeclaredInviolable(res.inviolable, facts.inviolables)
      return done('inviolable-park', {
        reason: `inviolable: ${res.inviolable}${declared ? '' : ' (not declared in the profile; parked anyway)'}`,
        record: record && res.decision ? { ...record, recommendation: res.decision } : record,
      })
    }
    if (res.park) return park('parked-human', `resolver parked: ${res.rationale}`, res.decision)
    const doubt = res.doubt ? { ...res.doubt, log: facts.escalation?.doubtLog || null } : undefined
    if (!res.mandate) {
      resolved('resolver', res.decision)
      return done('decided', { by: 'resolver', reason: res.rationale, doubt })
    }
    mandate = res.mandate
  }

  if (!MANDATES.includes(mandate)) return park('parked-human', `not-in-mandate: "${mandate}" is outside the mandate vocabulary`)
  const proxy = facts.ownerProxy
  if (!proxy) return park('parked-human', 'no-proxy: the profile declares no owner proxy', res?.decision)
  if (!(proxy.mandate || []).includes(mandate)) return park('parked-human', `not-in-mandate: ${mandate}`, res?.decision)

  const act = answers['owner-proxy']
  if (!act) return done('pending', { next: 'owner-proxy', brief: brief(record, mandate, facts, step) })
  if (act.action !== 'act') return park('parked-human', `owner proxy parked: ${act.parkReason || 'no reason'} — ${act.rationale}`, res?.decision)
  if (act.mandate !== mandate) return park('parked-human', `owner proxy acted on "${act.mandate}", asked for "${mandate}"`)
  const unmet = (act.conditions || []).filter(c => c.met !== true)
  if (unmet.length) return park('parked-human', `condition-unmet: ${unmet.map(c => c.condition).join('; ')}`)
  resolved('owner-proxy', `${act.step} — ${act.rationale} — reversal: ${act.reversalCost}`)
  return done('proxied', { by: 'owner-proxy', reason: `mandate ${mandate}` })
}

function brief(record, mandate, facts, step = {}) {
  return {
    decisionId: record?.id || null,
    question: record?.question || step.what || null,
    mandate: mandate || null,
    profilePath: facts.profilePath || null,
    doubtLog: facts.escalation?.doubtLog || null,
  }
}

// Drives route() to a terminal answer. callLane(lane, brief) returns that lane's output.
export async function runChain(input, callLane, maxHops = 3) {
  let cur = { ...input, answers: { ...(input.answers || {}) } }
  for (let i = 0; i <= maxHops; i++) {
    const r = route(cur)
    if (r.route !== 'pending') return r
    cur = { ...cur, answers: { ...cur.answers, [r.next]: await callLane(r.next, r.brief) } }
  }
  return { ...route(cur), route: 'parked-human', reason: 'escalation did not settle within its hops' }
}

// ------------------------------------------------------------------------------------------ CLI

async function cli(argv) {
  const { readFileSync } = await import('node:fs')
  const { check } = await import('../contract/validate.mjs')
  const out = (code, obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code) }
  let input
  try {
    input = JSON.parse(readFileSync(!argv[0] || argv[0] === '-' ? 0 : argv[0], 'utf8'))
  } catch (e) {
    out(1, { status: 'error', kind: 'script-error', reason: `unreadable input: ${e.message}` })
  }
  if (!input.decision && !input.step?.mandate) out(1, { status: 'error', kind: 'script-error', reason: 'input needs a decision or a step.mandate' })
  if (input.decision) {
    const errors = check('decision', input.decision)
    if (errors.length) out(1, { status: 'error', kind: 'script-error', reason: 'decision schema violation', errors })
  }
  for (const lane of ['resolver', 'owner-proxy']) {
    const ans = input.answers?.[lane]
    if (!ans) continue
    const errors = check(`lane-${lane}`, ans)
    if (errors.length) out(0, { status: 'ok', route: 'invalid-answer', lane, errors })
  }
  const r = route(input)
  const { reason, ...payload } = r
  out(0, { status: 'ok', ...payload, routeReason: reason })
}

import { fileURLToPath } from 'node:url'
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) cli(process.argv.slice(2))
