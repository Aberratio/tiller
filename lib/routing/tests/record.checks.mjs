// Journal record for one routed dispatch, 18-r2 row 30.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withPrices } from '../../driver/adapters/budget.mjs'
import { check } from '../../contract/validate.mjs'
import { route } from '../route.mjs'
import { nextCandidate } from '../ladder.mjs'
import { routeRecord } from '../record.mjs'

const UP = { asOf: '2026-10-07T09:00:00Z', runtimes: { claude: { available: true } } }

export function checks(repoRoot, fixDir) {
  const load = p => JSON.parse(readFileSync(p, 'utf8'))
  const CAT = load(join(fixDir, 'route-catalogue.json'))
  const LANES = load(join(fixDir, 'route-lanes.json'))
  const out = []
  const t = (label, errs) => out.push({ label, errs })
  const r = route('premise', CAT, LANES, UP)
  const first = routeRecord(r)
  t('30 first dispatch record validates against route-decision', check('route-decision', first))
  t('30 first dispatch: top candidate, attempt 1, not escalated, rejected reasons kept',
    first.model === 'cheap' && first.runtime === 'claude' && first.attempt === 1 && first.escalatedFrom === null &&
    first.decisionId === r.decisionId && first.rejectedCount === r.rejected.length && JSON.stringify(first.rejected) === JSON.stringify(r.rejected) ? [] : [JSON.stringify(first)])
  const step = nextCandidate(r, { kind: 'verifier', model: 'cheap' })
  const second = routeRecord(r, step)
  t('30 escalated dispatch record validates', check('route-decision', second))
  t('30 escalated dispatch: next model, escalatedFrom, attempt 2', second.model === 'mid' && second.escalatedFrom === 'cheap' && second.attempt === 2 ? [] : [JSON.stringify(second)])
  t('30 a parked step has no dispatch record', (() => { try { routeRecord(r, { action: 'park', park: 'verifier', ladder: {} }); return ['no throw'] } catch { return [] } })())
  // models.json carries no prices; routing always sees it priced from prices.json.
  const real = n => n === 'models.json' ? withPrices(load(join(repoRoot, 'config', n)), load(join(repoRoot, 'config', 'prices.json'))) : load(join(repoRoot, 'config', n))
  t('30 day-one gate lane record validates', check('route-decision', routeRecord(route('plan', real('models.json'), real('lanes.json'), UP))))
  t('30 a record without avoid carries no sameModel key', 'sameModel' in first ? ['sameModel present'] : [])
  const tiers = real('routing.json').tiers
  const opinion = routeRecord(route('second-opinion', real('models.json'), real('lanes.json'), UP, { avoid: 'opus', tiers }))
  t('30 day-one second opinion: no peer at or above T3, so the same model with sameModel true, and the record validates',
    [...(opinion.model === 'opus' && opinion.sameModel === true ? [] : [JSON.stringify(opinion)]), ...check('route-decision', opinion)])
  const peer = structuredClone(real('models.json')); peer.models.sonnet.pinnedLanes.push('second-opinion')
  const other = routeRecord(route('second-opinion', peer, real('lanes.json'), UP, { avoid: 'opus', tiers }))
  t('30 a lower-tier peer never gives the second opinion: still opus, sameModel true', other.model === 'opus' && other.sameModel === true ? [] : [JSON.stringify(other)])
  const differs = routeRecord(route('second-opinion', peer, real('lanes.json'), UP, { avoid: 'opus', tiers: { ...tiers, T3: ['opus', 'sonnet'] } }))
  t('30 a same-tier peer gives the second opinion: sonnet, sameModel false', differs.model === 'sonnet' && differs.sameModel === false ? [] : [JSON.stringify(differs)])
  return out
}
