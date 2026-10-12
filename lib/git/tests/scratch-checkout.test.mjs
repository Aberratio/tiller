import { mkdtemp, makeFixtureRepo, git, runScript, assertEq, report } from './helpers.mjs'

const repo = mkdtemp()
const fixture = makeFixtureRepo(repo)
const sha = fixture.rev('HEAD')
const root = mkdtemp()

const first = runScript('scratch-checkout.mjs', ['--repo', repo, '--sha', sha, '--root', root], {})
assertEq(0, first.status, 'creates the scratch checkout')
assertEq(true, first.json.created, 'created: true the first time')

const countAfterFirst = git(repo, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).length

const second = runScript('scratch-checkout.mjs', ['--repo', repo, '--sha', sha, '--root', root], {})
assertEq(0, second.status, 'calling it again for the same sha succeeds')
assertEq(false, second.json.created, 'created: false the second time (memoized)')
assertEq(first.json.path, second.json.path, 'same path both times')

const countAfterSecond = git(repo, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).length
assertEq(countAfterFirst, countAfterSecond, 'the second call adds no new worktree')

report()
