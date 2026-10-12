#!/usr/bin/env node
// Reads a PR's merge state directly, replacing hand-run `gh pr view` calls re-issued as
// separate model turns. One call, one answer, never a claim about a SHA it did not check.
//
//   pr-state.mjs --repo <owner/repo> --pr <number>
//
// stdout: one script-result line. `mergeStateStatus`, `state`, `mergeable` and `isDraft` are
// GitHub's own vocabularies, passed through unchanged (docs/harness.md leaves them to the caller).
import { parseArgs, emit, refuse, scriptError, ghJson } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
if (!args.repo || !args.pr) refuse('usage: --repo <owner/repo> --pr <number>')

const fields = 'headRefOid,mergeStateStatus,state,mergeable,isDraft,number,url'
const res = ghJson(['pr', 'view', args.pr, '--repo', args.repo, '--json', fields])
if (!res.ok) scriptError('gh pr view failed', { stderr: res.r.stderr || String(res.r.error || '') })

emit(0, {
  status: 'ok',
  headSha: res.data.headRefOid,
  mergeStateStatus: res.data.mergeStateStatus,
  state: res.data.state,
  mergeable: res.data.mergeable,
  isDraft: res.data.isDraft,
  number: res.data.number,
  prUrl: res.data.url,
})
