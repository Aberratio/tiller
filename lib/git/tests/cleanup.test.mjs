import { writeFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { mkdtemp, makeFixtureRepo, git, runScript, assertEq, assertTrue, report } from './helpers.mjs'

// macOS resolves /tmp through /private; git reports the resolved path while this file builds
// dir names from the unresolved one, so comparisons below match by basename, not full path.

const repo = mkdtemp()
makeFixtureRepo(repo)
const scratch = mkdtemp()

function branchWorktree(name, { merge = false, dirty = false } = {}) {
  git(repo, ['branch', name, 'main'])
  const dir = join(scratch, name)
  git(repo, ['worktree', 'add', dir, name])
  writeFileSync(join(dir, `${name}.txt`), 'work\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', `${name} work`])
  if (merge) git(repo, ['merge', '--no-ff', '-m', `merge ${name}`, name])
  if (dirty) writeFileSync(join(dir, 'uncommitted.txt'), 'oops\n')
  return dir
}

const landedDir = branchWorktree('landed', { merge: true })
const aheadDir = branchWorktree('ahead')
const dirtyDir = branchWorktree('dirty', { merge: true, dirty: true })

const r = runScript('cleanup.mjs', ['--repo', repo, '--base', 'main'], {})
assertEq(0, r.status, 'exits ok')
assertTrue(r.json.removed.some(p => basename(p) === 'landed'), 'removes the worktree whose branch landed on main')
assertTrue(!existsSync(landedDir), 'the landed worktree directory is actually gone')

const aheadKept = r.json.kept.find(k => basename(k.path) === 'ahead')
assertTrue(Boolean(aheadKept), 'keeps the worktree whose branch has not landed')
assertEq('not merged into main', aheadKept.reason, 'names the reason as not merged')

const dirtyKept = r.json.kept.find(k => basename(k.path) === 'dirty')
assertTrue(Boolean(dirtyKept), 'keeps a dirty worktree even though its branch landed')
assertEq('uncommitted changes', dirtyKept.reason, 'names the reason as uncommitted changes')
assertTrue(existsSync(dirtyDir), 'the dirty worktree is never removed')

report()
