// Journal record for one routed dispatch, 18-r2 row 30.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  const real = n => load(join(repoRoot, 'config', n))
  t('30 day-one gate lane record validates', check('route-decision', routeRecord(route('plan', real('models.json'), real('lanes.json'), UP))))
  return out
}
