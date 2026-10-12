// nextCandidate() escalation ladder, 18-r2 rows 24-29.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { route } from '../route.mjs'
import { nextCandidate, PARK_REASONS } from '../ladder.mjs'

const UP = { asOf: '2026-10-07T09:00:00Z', runtimes: { claude: { available: true } } }

export function checks(repoRoot, fixDir) {
  const load = p => JSON.parse(readFileSync(p, 'utf8'))
  const CAT = load(join(fixDir, 'route-catalogue.json'))
  const LANES = load(join(fixDir, 'route-lanes.json'))
  const out = []
  const t = (label, errs) => out.push({ label, errs })
  const expect = (label, got, want) => t(label, JSON.stringify(got) === JSON.stringify(want) ? [] : [`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`])
  const pick = s => ({ action: s.action, model: s.model, park: s.park, escalatedFrom: s.escalatedFrom, steps: s.ladder.steps })
  // Feeds one failure kind per step, carrying the ladder state the way the driver would.
  const drive = (r, kinds) => {
    const seen = []; let model = r.candidates[0].model, ladder
    for (const kind of kinds) {
      const s = nextCandidate(r, { kind, model, ladder }); seen.push(pick(s)); ladder = s.ladder
      if (s.action === 'park') break
      if (s.model) model = s.model
    }
    return seen
  }
  const premise = route('premise', CAT, LANES, UP)

  expect('24 schema fail: retry same model with the error, second failure -> next candidate', drive(premise, ['schema', 'schema']), [
    { action: 'retry-same', model: 'cheap', steps: 0 }, { action: 'next', model: 'mid', escalatedFrom: 'cheap', steps: 1 }])
  t('24 retry-same carries the error to append', nextCandidate(premise, { kind: 'schema', model: 'cheap', error: 'missing field x' }).appendError === 'missing field x' ? [] : ['no appendError'])
  expect('25 verifier fail: next candidate once, then park verifier', drive(premise, ['verifier', 'verifier']), [
    { action: 'next', model: 'mid', escalatedFrom: 'cheap', steps: 1 }, { action: 'park', park: 'verifier', steps: 1 }])
  const four = structuredClone(CAT); four.models.mid2 = { ...structuredClone(CAT.models.mid) }; four.models.mid2.priceUsdPerMtok = { in: 3, out: 15 }
  const r4 = route('premise', four, LANES, UP)
  expect('26 ladder bound: maxLadderSteps 2 stops at 2 steps although a fourth candidate exists', drive(r4, ['schema', 'schema', 'schema', 'schema', 'schema', 'schema']).map(s => [s.action, s.model ?? s.park, s.steps]), [
    ['retry-same', 'cheap', 0], ['next', 'mid', 1], ['retry-same', 'mid', 1], ['next', 'mid2', 2], ['retry-same', 'mid2', 2], ['park', 'ladder-exhausted', 2]])
  for (const kind of ['harness-blocked', 'blocked', 'died']) {
    expect(`27 ${kind}: one identical retry, no ladder step, then park ${kind}`, drive(premise, [kind, kind]), [
      { action: 'retry-identical', model: 'cheap', steps: 0 }, { action: 'park', park: kind, steps: 0 }])
  }
  const tr = nextCandidate(premise, { kind: 'transport', model: 'cheap' })
  expect('28 transport: model cooled down, next candidate, ladder count unchanged', [tr.action, tr.model, tr.cooldown, tr.ladder.steps], ['next', 'mid', 'cheap', 0])
  const last = nextCandidate(premise, { kind: 'transport', model: 'strong', ladder: { steps: 0, tried: ['cheap', 'mid'] } })
  expect('28 transport with no candidate left: back off on the same model', [last.action, last.model, last.cooldown], ['backoff', 'strong', 'strong'])

  const gate = structuredClone(CAT); gate.models.mid.pinnedLanes = ['implement']; gate.models.mid.capability.judgment.score = 0.9
  expect('29 gate ladder: next candidate measured at or above gateFloor', pick(nextCandidate(route('implement', gate, LANES, UP), { kind: 'verifier', model: 'strong' })),
    { action: 'next', model: 'mid', escalatedFrom: 'strong', steps: 1 })
  const weak = structuredClone(gate); weak.models.mid.capability = {}
  expect('29 gate ladder never weakens: unmeasured next candidate parks gate-floor', pick(nextCandidate(route('implement', weak, LANES, UP), { kind: 'verifier', model: 'strong' })),
    { action: 'park', park: 'gate-floor', steps: 0 })
  const real = n => load(join(repoRoot, 'config', n))
  expect('day one: a gate lane never escalates (maxLadderSteps 0)', pick(nextCandidate(route('plan', real('models.json'), real('lanes.json'), UP), { kind: 'schema', model: 'opus', ladder: { steps: 0, sameModel: 1 } })),
    { action: 'park', park: 'ladder-exhausted', steps: 0 })
  expect('day one: a T2 lane escalates sonnet -> opus once', pick(nextCandidate(route('premise', real('models.json'), real('lanes.json'), UP), { kind: 'verifier', model: 'sonnet' })),
    { action: 'next', model: 'opus', escalatedFrom: 'sonnet', steps: 1 })

  const empty = route('implement', (() => { const c = structuredClone(CAT); c.models.strong.status = 'disabled'; return c })(), LANES, UP)
  expect('no eligible model parks no-eligible-model', nextCandidate(empty, { kind: 'schema', model: null }).park, 'no-eligible-model')
  t('unknown failure kind throws', (() => { try { nextCandidate(premise, { kind: 'weird', model: 'cheap' }); return ['no throw'] } catch { return [] } })())
  const parks = [drive(premise, ['verifier', 'verifier']), drive(r4, Array(6).fill('schema')), drive(premise, ['died', 'died'])].flat().filter(s => s.park).map(s => s.park)
  t('every park reason is from the closed set', parks.filter(p => !PARK_REASONS.includes(p)))
  const frozen = { steps: 1, tried: ['cheap'] }; const copy = JSON.stringify(frozen)
  nextCandidate(premise, { kind: 'verifier', model: 'mid', ladder: frozen })
  t('nextCandidate does not mutate the ladder it is given', JSON.stringify(frozen) === copy ? [] : ['mutated'])
  return out
}
