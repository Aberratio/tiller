import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, writeStub, runScript, assertEq, assertTrue, report, FORGE_DIR } from './helpers.mjs'

const { check } = await import(join(FORGE_DIR, '..', 'contract', 'validate.mjs'))

// gh and git answer from files, so each case only rewrites the answers. Both stubs log their argv.
function stubs({ prs = [], heads = [], ghFails = false, gitFails = false } = {}) {
  const bin = mkdtemp()
  writeFileSync(join(bin, 'prs.json'), JSON.stringify(prs))
  writeFileSync(join(bin, 'heads.txt'), heads.map((h, i) => `${String(i).padStart(40, '0')}\trefs/heads/${h}\n`).join(''))
  writeStub(bin, 'gh', `
echo "$@" >> "${bin}/gh.log"
${ghFails ? 'echo "HTTP 502" >&2; exit 1' : ''}
if [[ "$1 $2" == "pr list" ]]; then cat "${bin}/prs.json"; exit 0; fi
exit 1
`)
  writeStub(bin, 'git', `
echo "$@" >> "${bin}/git.log"
${gitFails ? 'echo "fatal: could not read from remote" >&2; exit 128' : ''}
if [[ "$*" == *"ls-remote"* ]]; then cat "${bin}/heads.txt"; exit 0; fi
exit 1
`)
  return bin
}

const pr = (number, state, headRefName, title) => ({ number, state, headRefName, title, url: `https://example.invalid/pull/${number}` })
const guard = (bin, extra = []) => runScript('duplicate-guard.mjs', ['--repo', 'acme/widgets', '--repo-path', '/repo', '--key', 'ABC-8640', ...extra], { binDir: bin })

// Nothing prior: ok, and the queries are the ones the guard claims to make.
{
  const bin = stubs()
  const r = guard(bin, ['--own-branch', 'ABC-8640-run-aaaa1111'])
  assertEq(0, r.status, 'clean ticket exits 0')
  assertEq('ok', r.json.status, 'clean ticket is ok')
  assertEq([], r.json.prs, 'no prs reported')
  assertEq([], r.json.branches, 'no branches reported')
  assertEq([], check('script-result', r.json, r.status), 'ok satisfies the script-result contract')
  const ghLog = readFileSync(join(bin, 'gh.log'), 'utf8')
  assertTrue(/pr list --repo acme\/widgets --search ABC-8640 --state all --json/.test(ghLog), `gh searches every state for the key: ${ghLog}`)
  const gitLog = readFileSync(join(bin, 'git.log'), 'utf8')
  assertTrue(/-C \/repo ls-remote --heads origin/.test(gitLog), `git lists origin heads in the repo: ${gitLog}`)
}

// A PR was once opened while another had already merged.
{
  const bin = stubs({ prs: [pr(502, 'MERGED', 'ABC-8640-run-38dcd7cc', '[ABC-8640] Pin the last-rep readout')] })
  const r = guard(bin, ['--own-branch', 'ABC-8640-run-4a1547d2'])
  assertEq(4, r.status, 'a merged PR refuses with exit 4')
  assertEq('refused', r.json.status, 'merged PR: refused')
  assertEq('duplicate', r.json.kind, 'merged PR: kind duplicate')
  assertTrue(/#502/.test(r.json.reason) && /merged/i.test(r.json.reason) && /pull\/502/.test(r.json.reason), `reason names the merged PR: ${r.json.reason}`)
  assertEq([502], r.json.prs.map(p => p.number), 'the merged PR is listed')
  assertEq([], check('script-result', r.json, r.status), 'the refusal satisfies the script-result contract')
}

{
  const bin = stubs({ prs: [pr(505, 'OPEN', 'ABC-8640-run-1', '[ABC-8640] x')] })
  const r = guard(bin)
  assertEq('refused', r.json.status, 'an open PR refuses')
  assertTrue(/#505/.test(r.json.reason) && /open/i.test(r.json.reason), `reason names the open PR: ${r.json.reason}`)
}

// An abandoned (closed, unmerged) attempt delivered nothing and does not block a new run.
{
  const bin = stubs({ prs: [pr(504, 'CLOSED', 'ABC-8640-run-4a1547d2', '[ABC-8640] x')] })
  assertEq('ok', guard(bin).json.status, 'a closed unmerged PR does not refuse')
}

// Its branch usually outlives it on the remote; a branch whose only PRs are closed unmerged is the
// same abandoned attempt, not a second one.
{
  const bin = stubs({ prs: [pr(504, 'CLOSED', 'ABC-8640-run-4a1547d2', '[ABC-8640] x'), pr(506, 'CLOSED', 'ABC-8640-run-4a1547d2', '[ABC-8640] retry')], heads: ['ABC-8640-run-4a1547d2'] })
  const r = guard(bin, ['--own-branch', 'ABC-8640-run-aaaa1111'])
  assertEq('ok', r.json.status, 'a branch whose only PRs are closed unmerged does not refuse')
  assertEq([], r.json.branches, 'the closed-PR branch is not reported')
}

// A closed PR does not launder a branch that also carries an open or merged one.
{
  const bin = stubs({ prs: [pr(504, 'CLOSED', 'ABC-8640-run-1', '[ABC-8640] x'), pr(502, 'MERGED', 'ABC-8640-run-1', '[ABC-8640] y')], heads: ['ABC-8640-run-1'] })
  const r = guard(bin)
  assertEq('refused', r.json.status, 'closed plus merged on one branch refuses')
  assertEq('duplicate', r.json.kind, 'closed plus merged: kind duplicate')
  assertEq([502], r.json.prs.map(p => p.number), 'only the merged PR is listed')
}

// A closed PR on one branch says nothing about another branch of the same key.
{
  const bin = stubs({ prs: [pr(504, 'CLOSED', 'ABC-8640-run-1', '[ABC-8640] x')], heads: ['ABC-8640-run-1', 'ABC-8640-run-2'] })
  const r = guard(bin)
  assertEq('refused', r.json.status, 'a branch with no PR at all still refuses')
  assertEq(['ABC-8640-run-2'], r.json.branches, 'only the PR-less branch is listed')
  assertEq([], check('script-result', r.json, r.status), 'the duplicate refusal satisfies the script-result contract')
}

// gh's --search is full-text: a PR that only mentions the key in its body, or carries a longer key, is not this ticket's.
{
  const bin = stubs({ prs: [pr(300, 'MERGED', 'ABC-9000-run-1', '[ABC-9000] follow-up'), pr(301, 'OPEN', 'ABC-86401-run-1', '[ABC-86401] y')] })
  assertEq('ok', guard(bin).json.status, 'body-only mention and a longer key do not refuse')
}

// The key in the title alone still counts: a branch named by hand need not carry it.
{
  const bin = stubs({ prs: [pr(302, 'OPEN', 'fix-readout', 'abc-8640: fix readout')] })
  assertEq('refused', guard(bin).json.status, 'the key in the title refuses, case-insensitively')
}

// This run's own PR on resume is not a duplicate of itself.
{
  const bin = stubs({ prs: [pr(310, 'OPEN', 'ABC-8640-run-aaaa1111', '[ABC-8640] x')], heads: ['ABC-8640-run-aaaa1111'] })
  const r = guard(bin, ['--own-branch', 'ABC-8640-run-aaaa1111'])
  assertEq('ok', r.json.status, 'own branch and own PR are excluded')
}

{
  const bin = stubs({ heads: ['ABC-8640-run-bbbb2222', 'feature/ABC-8640-other', 'ABC-86401-run-1', 'main'] })
  const r = guard(bin, ['--own-branch', 'ABC-8640-run-aaaa1111'])
  assertEq('refused', r.json.status, 'a remote branch from another run refuses')
  assertEq(['ABC-8640-run-bbbb2222', 'feature/ABC-8640-other'], r.json.branches, 'only this key\'s branches are listed')
  assertTrue(/ABC-8640-run-bbbb2222/.test(r.json.reason), `reason names the branch: ${r.json.reason}`)
}

// A PR's own head branch is reported once, as the PR, not again as a bare branch.
{
  const bin = stubs({ prs: [pr(505, 'OPEN', 'ABC-8640-run-1', '[ABC-8640] x')], heads: ['ABC-8640-run-1'] })
  const r = guard(bin)
  assertEq([], r.json.branches, 'a PR head is not repeated as a branch')
}

// Fail closed: a guard that cannot look never says ok.
{
  const r = guard(stubs({ ghFails: true }))
  assertEq(1, r.status, 'gh failure exits 1')
  assertEq('error', r.json.status, 'gh failure is an error, not ok')
}
{
  const r = guard(stubs({ gitFails: true }))
  assertEq(1, r.status, 'git failure exits 1')
  assertEq('error', r.json.status, 'git failure is an error, not ok')
}
{
  const r = runScript('duplicate-guard.mjs', ['--repo', 'acme/widgets'], { binDir: stubs() })
  assertEq('refused', r.json.status, 'missing args refuse with usage')
  assertEq('policy', r.json.kind, 'a usage refusal stays policy, not duplicate')
}

report()
