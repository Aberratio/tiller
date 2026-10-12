#!/usr/bin/env node
// Refuses a new run when the ticket already has an open or merged PR, or a remote branch, from
// another run: an unattended relaunch otherwise redoes delivered work (a relaunch once duplicated
// an already merged PR). A branch whose only PRs were closed unmerged is an
// abandoned attempt and does not block; a branch with no PR at all does. Read-only; fails closed
// when it cannot look.
//
//   duplicate-guard.mjs --repo <owner/repo> --repo-path <path> --key <KEY> [--own-branch <name>]
//
// stdout: one script-result line; `refused` (kind `duplicate`) names every PR and branch found.
import { parseArgs, emit, refuse, scriptError, ghJson, git } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
for (const k of ['repo', 'repo-path', 'key']) {
  if (!args[k]) refuse('usage: --repo <owner/repo> --repo-path <path> --key <KEY> [--own-branch <name>]')
}
const key = args.key
const own = args['own-branch'] || null

// `gh --search` is full-text, so a PR that only mentions the key in its body is filtered out here;
// the boundaries keep ABC-864 from matching ABC-8640.
const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mentions = s => new RegExp(`(^|[^A-Za-z0-9])${esc}($|[^0-9])`, 'i').test(String(s || ''))

const res = ghJson(['pr', 'list', '--repo', args.repo, '--search', key, '--state', 'all', '--json', 'number,state,headRefName,title,url'])
if (!res.ok) scriptError('gh pr list failed', { stderr: res.r.stderr || String(res.r.error || res.parseError || '') })

const all = Array.isArray(res.data) ? res.data : []
const prs = all
  .filter(p => p.state === 'OPEN' || p.state === 'MERGED')
  .filter(p => p.headRefName !== own)
  .filter(p => mentions(p.headRefName) || mentions(p.title))
  .map(p => ({ number: p.number, state: p.state, headRefName: p.headRefName, url: p.url }))

const ls = git(['-C', args['repo-path'], 'ls-remote', '--heads', 'origin', `${key}*`, `${key.toLowerCase()}*`])
if (ls.error || ls.status !== 0) scriptError('git ls-remote failed', { stderr: ls.stderr || String(ls.error || '') })

const prHeads = new Set(prs.map(p => p.headRefName))
const closedHeads = new Set(all.filter(p => p.state === 'CLOSED').map(p => p.headRefName))
const branches = [...new Set(ls.stdout.split('\n')
  .map(l => l.split('\t')[1])
  .filter(Boolean)
  .map(ref => ref.replace(/^refs\/heads\//, '')))]
  .filter(b => b !== own && !prHeads.has(b) && !closedHeads.has(b) && mentions(b))

if (!prs.length && !branches.length) emit(0, { status: 'ok', key, prs, branches })

const found = [
  ...prs.map(p => `${p.state === 'MERGED' ? 'merged' : 'open'} PR #${p.number} (${p.url}, branch ${p.headRefName})`),
  ...branches.map(b => `remote branch ${b}`),
]
emit(4, { status: 'refused', kind: 'duplicate', reason: `duplicate: ${key} already has ${found.join('; ')} from another run`, key, prs, branches })
