import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, makeFixtureRepo, git, runScript, assertEq, report } from './helpers.mjs'

const repo = mkdtemp()
const fixture = makeFixtureRepo(repo)
const base = fixture.rev('HEAD')
writeFileSync(join(repo, 'client-new', 'a.ts'), 'x\n')
git(repo, ['add', '-A'])
git(repo, ['commit', '-qm', 'work'])
const head = fixture.rev('HEAD')

const ok = runScript('head-truth.mjs', ['--repo', repo, '--expect', head, '--base', base], {})
assertEq(0, ok.status, 'a clean worktree on the expected head exits ok')
assertEq(head, ok.json.headSha, 'the head is measured, not echoed')
assertEq(true, ok.json.clean, 'clean')
assertEq(true, ok.json.matchesExpect, 'matches the claim')
assertEq(true, ok.json.descendsFromBase, 'descends from the base')

const short = runScript('head-truth.mjs', ['--repo', repo, '--expect', head.slice(0, 7)], {})
assertEq(true, short.json.matchesExpect, 'a short SHA of the head matches')

const wrong = runScript('head-truth.mjs', ['--repo', repo, '--expect', base], {})
assertEq(0, wrong.status, 'a mismatch is a measurement, not an error')
assertEq(false, wrong.json.matchesExpect, 'a claim of another commit does not match')
assertEq(head, wrong.json.headSha, 'and the measured head is still reported')

const tiny = runScript('head-truth.mjs', ['--repo', repo, '--expect', head.slice(0, 4)], {})
assertEq(false, tiny.json.matchesExpect, 'fewer than 7 characters prove nothing')

git(repo, ['checkout', '-q', '--orphan', 'elsewhere'])
git(repo, ['commit', '-qm', 'unrelated'])
const orphan = runScript('head-truth.mjs', ['--repo', repo, '--base', base], {})
assertEq(false, orphan.json.descendsFromBase, 'a head that does not contain the base is reported')
git(repo, ['checkout', '-q', '-f', 'main'])

writeFileSync(join(repo, 'untracked.txt'), 'x\n')
const dirty = runScript('head-truth.mjs', ['--repo', repo], {})
assertEq(false, dirty.json.clean, 'an untracked file makes the tree dirty')
assertEq(['untracked.txt'], dirty.json.dirty, 'and is named')

const missing = runScript('head-truth.mjs', ['--repo', join(repo, 'nope')], {})
assertEq(1, missing.status, 'an unreadable worktree is a script error')
assertEq('error', missing.json && missing.json.status, 'and says so on stdout')

report()
