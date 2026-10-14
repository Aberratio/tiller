import { writeFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdtemp, makeFixtureRepo, git, runScript, assertEq, assertTrue, report } from './helpers.mjs'

// macOS resolves /tmp through /private; git reports the resolved path while this file builds
// dir names from the unresolved one, so comparisons below match by basename, not full path.

const repo = mkdtemp()
makeFixtureRepo(repo)
const scratch = mkdtemp()
const branchExists = name => spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0

function branchWorktree(name, { merge = false, dirty = false, commit = true } = {}) {
  git(repo, ['branch', name, 'main'])
  const dir = join(scratch, name)
  git(repo, ['worktree', 'add', dir, name])
  if (commit) {
    writeFileSync(join(dir, `${name}.txt`), 'work\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', `${name} work`])
  }
  if (merge) git(repo, ['merge', '--no-ff', '-m', `merge ${name}`, name])
  if (dirty) writeFileSync(join(dir, 'uncommitted.txt'), 'oops\n')
  return dir
}

const landedDir = branchWorktree('landed', { merge: true })
const foreignDir = branchWorktree('foreign-landed', { merge: true })
const aheadDir = branchWorktree('ahead')
const dirtyDir = branchWorktree('dirty', { merge: true, dirty: true })
// Another run that has not committed yet: its branch is an ancestor of main by construction.
const freshDir = branchWorktree('fresh', { commit: false })

const bare = runScript('cleanup.mjs', ['--repo', repo, '--base', 'main'], {})
assertEq(4, bare.status, 'a cleanup with no --branch is refused: there is no repo-wide cleanup')
assertTrue(existsSync(landedDir) && existsSync(freshDir), 'a refused call removes nothing')

const r = runScript('cleanup.mjs', ['--repo', repo, '--base', 'main', '--branch', 'landed', '--worktree', landedDir], {})
assertEq(0, r.status, 'exits ok')
assertEq(['landed'], r.json.removed.map(p => basename(p)), 'removes exactly the worktree of the run\'s own landed branch')
assertTrue(!existsSync(landedDir), 'the landed worktree directory is actually gone')
assertTrue(!branchExists('landed'), 'the landed branch is deleted')
assertEq([], r.json.kept, 'nothing else is reported: other worktrees are not the run\'s to judge')
assertTrue(existsSync(foreignDir) && branchExists('foreign-landed'), 'another run\'s landed worktree and branch are untouched')
assertTrue(existsSync(freshDir) && branchExists('fresh'), 'another run\'s zero-commit branch (an ancestor of main) is untouched')
assertTrue(existsSync(aheadDir) && existsSync(dirtyDir), 'the other worktrees are untouched')

const again = runScript('cleanup.mjs', ['--repo', repo, '--base', 'main', '--branch', 'landed', '--worktree', landedDir], {})
assertEq(0, again.status, 'a second call after the removal is still ok')
assertEq(true, again.json.absent, 'and says the branch is already gone')
assertEq([], again.json.removed, 'with nothing removed')

const ahead = runScript('cleanup.mjs', ['--repo', repo, '--base', 'main', '--branch', 'ahead', '--worktree', aheadDir], {})
assertEq(0, ahead.status, 'an own branch still ahead of base exits ok')
assertEq([], ahead.json.removed, 'and removes nothing')
assertEq('not merged into main', ahead.json.kept[0] && ahead.json.kept[0].reason, 'names the reason as not merged')
assertTrue(existsSync(aheadDir) && branchExists('ahead'), 'the unmerged worktree and branch stay')

const dirty = runScript('cleanup.mjs', ['--repo', repo, '--base', 'main', '--branch', 'dirty', '--worktree', dirtyDir], {})
assertEq('uncommitted changes', dirty.json.kept[0] && dirty.json.kept[0].reason, 'keeps a dirty worktree even though its branch landed')
assertTrue(existsSync(dirtyDir), 'the dirty worktree is never removed')

const elsewhere = runScript('cleanup.mjs', ['--repo', repo, '--base', 'main', '--branch', 'foreign-landed', '--worktree', join(scratch, 'not-here')], {})
assertEq(0, elsewhere.status, 'a branch checked out somewhere other than the given worktree exits ok')
assertEq([], elsewhere.json.removed, 'and removes nothing')
assertTrue(/not at/.test(elsewhere.json.kept[0] && elsewhere.json.kept[0].reason), 'names the path mismatch')
assertTrue(existsSync(foreignDir) && branchExists('foreign-landed'), 'the worktree and branch stay')

const mainWt = runScript('cleanup.mjs', ['--repo', repo, '--base', 'main', '--branch', 'main', '--worktree', repo], {})
assertEq(0, mainWt.status, 'the main worktree exits ok')
assertEq([], mainWt.json.removed, 'and is never removed')
assertTrue(existsSync(join(repo, 'base.txt')), 'the main checkout is intact')

report()
