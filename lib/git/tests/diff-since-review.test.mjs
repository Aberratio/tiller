import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, makeFixtureRepo, git, runScript, assertEq, report } from './helpers.mjs'

const repo = mkdtemp()
const fixture = makeFixtureRepo(repo)
const pin = fixture.rev('HEAD')

writeFileSync(join(repo, 'base.txt'), 'base\nchanged\n')
writeFileSync(join(repo, 'new.txt'), 'new file\n')
git(repo, ['add', '-A'])
git(repo, ['commit', '-qm', 'review round 1'])

const out = join(mkdtemp(), 'delta.diff')
const r = runScript('diff-since-review.mjs', ['--repo', repo, '--pin', pin, '--out', out], {})
assertEq(0, r.status, 'produces the delta')
assertEq(out, r.json.artifact, 'names the artifact path')

const expected = git(repo, ['diff', `${pin}..HEAD`])
const actual = readFileSync(out, 'utf8')
assertEq(expected, actual, 'the artifact content equals git diff <pin>..HEAD exactly')
assertEq(['base.txt', 'new.txt'].sort(), [...r.json.changedFiles].sort(), 'lists both changed files')

// A fresh STATE_ROOT has no `diffs/` directory yet — the first review round (or the
// unconditional changed-files diff at gate time) writes into it before anything else creates it.
// The script must create its own output directory rather than crash with ENOENT and print
// nothing, which the harness layer then reports as "no script-result line from
// diff-since-review.mjs" (bin/harness.mjs `run()`), indistinguishable from a real crash.
const freshRoot = join(mkdtemp(), 'diffs', 'nested')
const out2 = join(freshRoot, 'full.diff')
const r2 = runScript('diff-since-review.mjs', ['--repo', repo, '--pin', pin, '--out', out2], {})
assertEq(0, r2.status, 'creates its own output directory instead of crashing')
assertEq(out2, r2.json && r2.json.artifact, 'still names the artifact path')

report()
