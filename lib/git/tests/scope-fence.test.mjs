import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, makeFixtureRepo, git, runScript, assertEq, report } from './helpers.mjs'

const repo = mkdtemp()
const fixture = makeFixtureRepo(repo)
const pin = fixture.rev('HEAD')

mkdirSync(join(repo, 'client-new', 'theme'), { recursive: true })
writeFileSync(join(repo, 'client-new', 'theme', 'colors.ts'), 'x\n')
writeFileSync(join(repo, 'server-new.rb'), 'x\n')
git(repo, ['add', '-A'])
git(repo, ['commit', '-qm', 'fix round'])

const inScope = runScript('scope-fence.mjs', ['--repo', repo, '--pin', pin, '--authorised', 'client-new/'], {})
assertEq(0, inScope.status, 'exits ok even when out of scope (a measurement, not a refusal)')
assertEq(false, inScope.json.inScope, 'server-new.rb was not authorised')
assertEq(['server-new.rb'], inScope.json.extra, 'names the exact unauthorised file')

const fullyAuthorised = runScript('scope-fence.mjs', ['--repo', repo, '--pin', pin, '--authorised', 'client-new/', '--authorised', 'server-new.rb'], {})
assertEq(true, fullyAuthorised.json.inScope, 'in scope once every changed file is authorised')
assertEq([], fullyAuthorised.json.extra, 'no extra files')

// Runners pass the plan's list as one flag followed by every path.
const listed = runScript('scope-fence.mjs', ['--repo', repo, '--pin', pin, '--authorised', 'client-new/', 'server-new.rb'], {})
assertEq([], listed.json.extra, 'every path after one --authorised is authorised')

// After the branch takes in newer base commits, the fence measures from the merge-base with the
// base ref, so upstream files never count as the branch's own changes.
const up = mkdtemp()
const upFixture = makeFixtureRepo(up)
const forkPoint = upFixture.rev('HEAD')
git(up, ['checkout', '-qb', 'feature'])
writeFileSync(join(up, 'client-new', 'mine.ts'), 'x\n')
git(up, ['add', '-A'])
git(up, ['commit', '-qm', 'mine'])
git(up, ['checkout', '-q', 'main'])
writeFileSync(join(up, 'upstream.txt'), 'x\n')
git(up, ['add', '-A'])
git(up, ['commit', '-qm', 'upstream'])
git(up, ['checkout', '-q', 'feature'])
git(up, ['merge', '-q', '--no-edit', 'main'])

const fromPin = runScript('scope-fence.mjs', ['--repo', up, '--pin', forkPoint, '--authorised', 'client-new/'], {})
assertEq(['upstream.txt'], fromPin.json.extra, 'a stale pin counts the upstream file')
const fromBase = runScript('scope-fence.mjs', ['--repo', up, '--pin', forkPoint, '--base-ref', 'main', '--authorised', 'client-new/'], {})
assertEq(0, fromBase.status, 'base-ref run exits ok')
assertEq([], fromBase.json.extra, 'merge-base with the base ref leaves only the branch changes')
assertEq(['client-new/mine.ts'], fromBase.json.changedFiles, 'the branch change is still measured')
const noRef = runScript('scope-fence.mjs', ['--repo', up, '--pin', forkPoint, '--base-ref', 'origin/nope', '--authorised', 'client-new/'], {})
assertEq(1, noRef.status, 'an unresolvable base ref is a script error, never an empty diff')
assertEq('error', noRef.json && noRef.json.status, 'and says so on stdout')
const badPin = runScript('scope-fence.mjs', ['--repo', up, '--pin', 'deadbeef', '--authorised', 'client-new/'], {})
assertEq(1, badPin.status, 'an unknown pin is a script error')

report()
