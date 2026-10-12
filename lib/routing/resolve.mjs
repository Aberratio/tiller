#!/usr/bin/env node
// Resolve a lane -> model map for one launch.
//
//   node lib/routing/resolve.mjs <routing.json> [facts.json]
//
// <routing.json> is the harness default (config/routing.json): { tiers, lanes: { lane: { tier,
// gate? } } }. <facts.json>, if given, is a rendered profile facts object; its `modelRouting` key
// (lane -> tier, W6's `## model routing` render) overrides the default per lane. A lane marked
// `gate: true` cannot be overridden to anything but T3 - the launch is refused (exit 4) rather
// than silently clamped. Non-gate lanes may move to any tier.
//
// When models.json and lanes.json sit beside <routing.json>, the launch validator runs first and any
// violation refuses the launch the same way.
//
// Prints one script-result line: { status, kind?, reason?, routing? }. `routing` maps each lane
// to its resolved { tier, model }. A tier whose model is null inherits the session model.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from '../contract/validate.mjs'
import { validateLaunch } from './validate-launch.mjs'

function fail(status, kind, reason) {
  const doc = { status, kind, reason }
  console.log(JSON.stringify(doc))
  const errs = check('script-result', doc)
  if (errs.length) { console.error(errs.join('\n')); process.exit(1) }
  process.exit({ refused: 4, error: 1 }[status] ?? 1)
}

export function resolveRouting(config, facts) {
  const override = (facts && facts.modelRouting) || {}
  const routing = {}
  for (const [lane, def] of Object.entries(config.lanes)) {
    let tier = def.tier
    if (lane in override) {
      const wanted = override[lane]
      if (def.gate && wanted !== 'T3') {
        return { error: { kind: 'policy', reason: `lane "${lane}" is gate:true; override tier "${wanted}" is below the T3 floor` } }
      }
      tier = wanted
    }
    routing[lane] = { tier, model: config.tiers[tier] ?? null }
  }
  return { routing }
}

async function main() {
  const [configPath, factsPath] = process.argv.slice(2)
  if (!configPath) fail('error', 'script-error', 'usage: resolve.mjs <routing.json> [facts.json]')

  let config, facts
  try { config = JSON.parse(readFileSync(configPath, 'utf8')) }
  catch (e) { fail('error', 'script-error', `cannot read routing config: ${e.message}`) }
  if (factsPath) {
    try { facts = JSON.parse(readFileSync(factsPath, 'utf8')) }
    catch (e) { fail('error', 'script-error', `cannot read facts: ${e.message}`) }
  }

  const dir = dirname(configPath)
  if (existsSync(join(dir, 'models.json')) && existsSync(join(dir, 'lanes.json'))) {
    let catalogue, lanes
    try { catalogue = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')); lanes = JSON.parse(readFileSync(join(dir, 'lanes.json'), 'utf8')) }
    catch (e) { fail('error', 'script-error', `cannot read model catalogue: ${e.message}`) }
    const errors = validateLaunch(catalogue, lanes, config, facts)
    if (errors.length) fail('refused', 'policy', errors.map(e => `${e.rule}: ${e.reason}`).join('; '))
  }

  const { routing, error } = resolveRouting(config, facts)
  if (error) fail('refused', error.kind, error.reason)

  const doc = { status: 'ok', routing }
  console.log(JSON.stringify(doc))
  const errs = check('script-result', doc)
  if (errs.length) { console.error(errs.join('\n')); process.exit(1) }
  process.exit(0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
