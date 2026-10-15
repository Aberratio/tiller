#!/usr/bin/env node
// Join a run journal with subagent transcripts into per-phase spend records.
//
//   node lib/journal/spend.mjs <journal.jsonl> <transcripts-dir> <runId> <ticket> <out.jsonl>
//
// The run journal (written by the runner) has one "spawn" line per dispatched agent:
//   { "type": "spawn", "agentId", "key", "label", "phase", "transcript" }
// `label` is `<phase>:<lane>:<tier>[:<detail>]`; `transcript` is the subagent's transcript file
// name, relative to <transcripts-dir>. An optional "result" line closes the call:
//   { "type": "result", "agentId", "outcome", "escalatedFrom" }
// A result line without agentId carries `label` instead (the runners' calls[] entries, appended by
// the launcher). Those join by label in journal order: the n-th result line with a label closes the
// n-th spawn with that label, so a retried lane's attempts each keep their own outcome.
// A journal with no "result" line for an agent is not an error: outcome is then derived from the
// transcript itself (see deriveOutcome). This lets spend.mjs run against journals from before
// outcome was tracked explicitly, and against ones that log it directly.
//
// A transcript is the harness's own JSONL turn log: one JSON object per line, `timestamp` on
// every line, `type: "assistant"` lines carrying `message.model` and `message.usage`
// (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens).
//
// No tokens/time exist for tier T0 (exec/script lanes never run a model): those records carry
// model "none" and zeroed counters, taken from the journal alone.

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from '../contract/validate.mjs'

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l))
}

// label = "<phase>:<lane>:<tier>[:<detail>]"
function parseLabel(label) {
  const [phase, lane, tier] = label.split(':')
  return { phase, lane, tier }
}

function deriveOutcome(turns) {
  if (turns.some(t => t.isApiErrorMessage)) return 'error'
  return 'ok'
}

function summarizeTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { turns: 0, in: 0, out: 0, cacheRead: 0, cacheCreate: 0, startedAt: null, endedAt: null, model: 'none', outcome: 'blocked' }
  }
  const lines = readJsonl(transcriptPath)
  const assistantTurns = lines.filter(l => l.type === 'assistant')
  const timestamps = lines.map(l => l.timestamp).filter(Boolean).sort()
  const models = assistantTurns.map(l => l.message?.model).filter(m => m && m !== '<synthetic>')
  const totals = assistantTurns.reduce((acc, l) => {
    const u = l.message?.usage || {}
    acc.in += u.input_tokens || 0
    acc.out += u.output_tokens || 0
    acc.cacheRead += u.cache_read_input_tokens || 0
    acc.cacheCreate += u.cache_creation_input_tokens || 0
    return acc
  }, { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 })
  return {
    turns: assistantTurns.length,
    ...totals,
    startedAt: timestamps[0] || null,
    endedAt: timestamps[timestamps.length - 1] || null,
    model: models[models.length - 1] || 'unknown',
    outcome: deriveOutcome(assistantTurns),
  }
}

export function buildSpendRecords(journalEntries, transcriptsDir, runId, ticket) {
  const spawns = new Map()
  const results = new Map()
  const byLabel = new Map()
  for (const entry of journalEntries) {
    // Legacy: a journal from the retired Workflow runner writes "started" with no "transcript"
    // field instead of "spawn" with an explicit one; its transcript file is "agent-<agentId>.jsonl".
    // Kept so old journals still report.
    if (entry.type === 'spawn') spawns.set(entry.agentId, entry)
    else if (entry.type === 'started') spawns.set(entry.agentId, { ...entry, transcript: entry.transcript || `agent-${entry.agentId}.jsonl` })
    else if (entry.type === 'result' && entry.agentId) results.set(entry.agentId, entry)
    else if (entry.type === 'result' && entry.label) {
      if (!byLabel.has(entry.label)) byLabel.set(entry.label, [])
      byLabel.get(entry.label).push(entry)
    }
  }

  const records = []
  for (const spawn of spawns.values()) {
    const { phase: labelPhase, lane, tier } = parseLabel(spawn.label)
    const phase = spawn.phase || labelPhase
    const transcriptPath = spawn.transcript ? join(transcriptsDir, spawn.transcript) : null
    const summary = summarizeTranscript(transcriptPath)
    // Legacy: a spawn from the retired Workflow runner can carry both an agentId-keyed completion
    // record ({command, ran, exitCode, stdout}, no "outcome" field) and a label-keyed calls[] result
    // carrying the lane's actual outcome. The agentId record is truthy even without "outcome", so it
    // must not win the join just by existing: the label-keyed result (when present) is the one that
    // names ok/invalid/harness-blocked.
    const byLabelResult = (byLabel.get(spawn.label) || []).shift()
    const result = byLabelResult ?? results.get(spawn.agentId)

    records.push({
      runId,
      ticket,
      phase,
      lane,
      model: tier === 'T0' ? 'none' : summary.model,
      tier,
      turns: tier === 'T0' ? 0 : summary.turns,
      in: summary.in,
      out: summary.out,
      cacheRead: summary.cacheRead,
      cacheCreate: summary.cacheCreate,
      startedAt: summary.startedAt || new Date(0).toISOString(),
      endedAt: summary.endedAt || summary.startedAt || new Date(0).toISOString(),
      outcome: result?.outcome ?? summary.outcome,
      escalatedFrom: result?.escalatedFrom ?? null,
    })
  }
  return records.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
}

// A Node-driver run journal (lib/driver/journal.mjs's laneLine/execLine shape) has no transcripts
// to join against: each lane call already carries its own model/outcome/usage/cost, and each exec
// call carries only exitCode/durationMs. One phase-spend record per journal line, no join needed.
export function buildSpendRecordsFromDriverJournal(driverEntries, ticket) {
  return driverEntries.filter(entry => entry.kind !== 'warning').map((entry, i) => {
    const parts = (entry.label || '').split(':')
    const tier = entry.kind === 'exec' ? 'T0' : (/^T\d$/.test(parts[2]) ? parts[2] : 'T0')
    const lane = entry.lane || parts[1]
    const usage = entry.kind === 'exec' ? null : (entry.usage || {})
    // Driver-journal lines carry no timestamps; a monotonic placeholder (journal order, spaced by
    // each call's own durationMs) keeps records schema-valid and sortable without inventing wall time.
    const startedAt = new Date(i * 1000).toISOString()
    const endedAt = new Date(i * 1000 + (entry.durationMs || 0)).toISOString()
    return {
      runId: entry.runId,
      ticket,
      phase: entry.phase,
      lane,
      model: entry.kind === 'exec' ? 'none' : (entry.model || 'unknown'),
      tier,
      turns: entry.kind === 'exec' ? 0 : 1,
      in: usage?.input || 0,
      out: usage?.output || 0,
      cacheRead: usage?.cacheRead || 0,
      cacheCreate: usage?.cacheCreate || 0,
      startedAt,
      endedAt,
      outcome: entry.kind === 'exec' ? (entry.exitCode === 0 ? 'ok' : 'error') : (entry.outcome || 'ok'),
      escalatedFrom: null,
      costUsd: entry.kind === 'exec' ? 0 : (entry.costUsd || 0),
    }
  })
}

function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--driver-journal') {
    const [, driverJournalPath, ticket, outPath] = argv
    if (!driverJournalPath || !ticket || !outPath) {
      console.error('usage: spend.mjs --driver-journal <driver-journal.jsonl> <ticket> <out.jsonl>')
      process.exit(1)
    }
    const driverJournal = readJsonl(driverJournalPath)
    const records = buildSpendRecordsFromDriverJournal(driverJournal, ticket)
    const errors = records.flatMap((r, i) => check('phase-spend', r).map(e => `record[${i}]: ${e}`))
    if (errors.length) {
      console.error(errors.join('\n'))
      process.exit(1)
    }
    writeFileSync(outPath, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
    console.log(JSON.stringify({ status: 'ok', written: records.length, out: outPath }))
    return
  }

  const [journalPath, transcriptsDir, runId, ticket, outPath] = argv
  if (!journalPath || !transcriptsDir || !runId || !ticket || !outPath) {
    console.error('usage: spend.mjs <journal.jsonl> <transcripts-dir> <runId> <ticket> <out.jsonl>')
    console.error('       spend.mjs --driver-journal <driver-journal.jsonl> <ticket> <out.jsonl>')
    process.exit(1)
  }
  const journal = readJsonl(journalPath)
  const records = buildSpendRecords(journal, transcriptsDir, runId, ticket)

  const errors = records.flatMap((r, i) => check('phase-spend', r).map(e => `record[${i}]: ${e}`))
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exit(1)
  }

  writeFileSync(outPath, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
  console.log(JSON.stringify({ status: 'ok', written: records.length, out: outPath }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
