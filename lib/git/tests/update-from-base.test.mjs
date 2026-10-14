import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdtemp, git, runScript, assertEq, assertTrue, report } from './helpers.mjs'

// A bare `origin`, a ticket clone that pushed branch `T-1` with one commit, and a second clone that
// plays everyone else: it moves `main` and, in one case, pushes onto `T-1` itself.
function world({ conflict = false } = {}) {
  const origin = mkdtemp('ufb-origin-')
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  const clone = name => {
    const dir = join(mkdtemp('ufb-'), name)
    git(process.cwd(), ['clone', '-q', origin, dir])
    git(dir, ['config', 'user.email', 'test@test.invalid'])
    git(dir, ['config', 'user.name', 'test'])
    return dir
  }
  const other = clone('other')
  writeFileSync(join(other, 'shared.txt'), 'one\n')
  git(other, ['add', '-A']); git(other, ['commit', '-qm', 'base']); git(other, ['push', '-q', 'origin', 'main'])

  const wt = clone('wt')
  git(wt, ['checkout', '-qb', 'T-1'])
  writeFileSync(join(wt, conflict ? 'shared.txt' : 'ticket.txt'), 'ticket\n')
  git(wt, ['add', '-A']); git(wt, ['commit', '-qm', 'ticket work']); git(wt, ['push', '-q', '-u', 'origin', 'T-1'])

  git(other, ['pull', '-q'])
  writeFileSync(join(other, 'shared.txt'), 'main moved\n')
  git(other, ['add', '-A']); git(other, ['commit', '-qm', 'main moved']); git(other, ['push', '-q', 'origin', 'main'])
  const rev = (dir, ref) => git(dir, ['rev-parse', ref]).trim()
  const remote = ref => rev(origin, ref)
  const isAncestor = (dir, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir }).status === 0
  const worktrees = () => git(wt, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).length
  return { origin, other, wt, rev, remote, isAncestor, worktrees }
}

const run = (w, method, extra = []) => runScript('update-from-base.mjs', ['--repo', w.wt, '--base', 'main', '--branch', 'T-1', '--method', method, ...extra])

// Already contains the base: nothing to do, nothing pushed.
{
  const w = world()
  git(w.wt, ['fetch', '-q', 'origin']); git(w.wt, ['merge', '-q', '--no-edit', 'origin/main']); git(w.wt, ['push', '-q'])
  const before = w.remote('T-1')
  const r = run(w, 'merge')
  assertEq(0, r.status, 'up to date: exit 0')
  assertEq(false, r.json && r.json.updated, 'up to date: updated false')
  assertEq(before, w.remote('T-1'), 'up to date: origin branch untouched')
}

// Merge method, base moved, no conflict: a merge commit on top, pushed as a fast-forward.
{
  const w = world()
  const prev = w.rev(w.wt, 'HEAD')
  const r = run(w, 'merge')
  assertEq(0, r.status, 'clean merge: exit 0')
  assertEq(true, r.json.updated, 'clean merge: updated')
  assertEq(false, r.json.forced, 'clean merge: not a force-push')
  assertEq(r.json.headSha, w.remote('T-1'), 'clean merge: origin branch is the new head')
  assertEq(r.json.headSha, w.rev(w.wt, 'HEAD'), 'clean merge: the worktree moved with it')
  assertTrue(w.isAncestor(w.wt, w.remote('main'), r.json.headSha), 'clean merge: new head contains the base')
  assertTrue(w.isAncestor(w.wt, prev, r.json.headSha), 'clean merge: new head keeps the ticket commits')
  assertEq(prev, r.json.previousSha, 'clean merge: previousSha is the pre-update head')
}

// Rebase method on a pushed branch without --lease: the rewrite would need a force-push. Refused,
// nothing moved anywhere.
{
  const w = world()
  const prevLocal = w.rev(w.wt, 'HEAD'), prevRemote = w.remote('T-1'), wts = w.worktrees()
  const r = run(w, 'rebase')
  assertEq(4, r.status, 'rebase without lease: refused (exit 4)')
  assertEq('policy', r.json.kind, 'rebase without lease: kind policy')
  assertTrue(/force/.test(r.json.reason), 'rebase without lease: reason names the force-push')
  assertEq(prevRemote, w.remote('T-1'), 'rebase without lease: origin branch untouched')
  assertEq(prevLocal, w.rev(w.wt, 'HEAD'), 'rebase without lease: worktree untouched')
  assertEq(wts, w.worktrees(), 'rebase without lease: no scratch worktree left behind')
}

// Rebase method with --lease: pushed over our own commits only, pinned to the SHA observed.
{
  const w = world()
  const r = run(w, 'rebase', ['--lease'])
  assertEq(0, r.status, 'rebase with lease: exit 0')
  assertEq(true, r.json.updated, 'rebase with lease: updated')
  assertEq(true, r.json.forced, 'rebase with lease: reported as a lease push')
  assertEq(r.json.headSha, w.remote('T-1'), 'rebase with lease: origin branch is the new head')
  assertEq(r.json.headSha, w.rev(w.wt, 'HEAD'), 'rebase with lease: the worktree moved with it')
  assertEq(w.remote('main'), r.json.headSha && w.rev(w.wt, `${r.json.headSha}~1`),'rebase with lease: the ticket commit sits directly on the base')
}

// A real conflict, either method: blocked with the conflicting files, nothing moved, no rebase or
// merge left in progress.
for (const method of ['merge', 'rebase']) {
  const w = world({ conflict: true })
  const prevLocal = w.rev(w.wt, 'HEAD'), prevRemote = w.remote('T-1'), wts = w.worktrees()
  const r = run(w, method, ['--lease'])
  assertEq(3, r.status, `${method} conflict: blocked (exit 3)`)
  assertEq('conflict', r.json && r.json.kind, `${method} conflict: kind conflict`)
  assertEq(['shared.txt'], r.json.conflictingFiles, `${method} conflict: names the conflicting file`)
  assertEq(prevRemote, w.remote('T-1'), `${method} conflict: origin branch untouched`)
  assertEq(prevLocal, w.rev(w.wt, 'HEAD'), `${method} conflict: worktree untouched`)
  assertEq('', git(w.wt, ['status', '--porcelain']), `${method} conflict: worktree clean`)
  assertEq(wts, w.worktrees(), `${method} conflict: no scratch worktree left behind`)
}

// Someone else pushed onto the branch: never overwritten, whatever the method or lease.
for (const method of ['merge', 'rebase']) {
  const w = world()
  git(w.other, ['fetch', '-q', 'origin']); git(w.other, ['checkout', '-qb', 'T-1', 'origin/T-1'])
  writeFileSync(join(w.other, 'theirs.txt'), 'theirs\n')
  git(w.other, ['add', '-A']); git(w.other, ['commit', '-qm', 'theirs']); git(w.other, ['push', '-q', 'origin', 'T-1'])
  const theirs = w.remote('T-1')
  const r = run(w, method, ['--lease'])
  assertEq(4, r.status, `${method} foreign commit: refused`)
  assertTrue(/not in/.test(r.json.reason), `${method} foreign commit: reason says the remote has commits the branch lacks`)
  assertEq(theirs, w.remote('T-1'), `${method} foreign commit: their commit is still the branch head`)
}

// Uncommitted work in the worktree is never carried through an update.
{
  const w = world()
  writeFileSync(join(w.wt, 'ticket.txt'), 'dirty\n')
  const r = run(w, 'merge')
  assertEq(4, r.status, 'dirty worktree: refused')
  assertEq(w.rev(w.wt, 'HEAD'), w.rev(w.wt, 'origin/T-1'), 'dirty worktree: nothing pushed')
}

// A crash between the push and the move of the worktree: the remote already carries this branch
// integrated with the base, the worktree still sits on the old head. The next call recognises its
// own result (every commit on either side has its patch on the other, or is in the base) and
// moves the worktree instead of refusing.
for (const method of ['merge', 'rebase']) {
  const w = world()
  const prev = w.rev(w.wt, 'HEAD')
  const first = run(w, method, ['--lease'])
  assertEq(0, first.status, `${method} crash replay: first update ok`)
  git(w.wt, ['reset', '-q', '--keep', prev])
  assertEq(prev, w.rev(w.wt, 'HEAD'), `${method} crash replay: worktree back on the old head`)
  const r = run(w, method, ['--lease'])
  assertEq(0, r.status, `${method} crash replay: exit 0`)
  assertEq(prev, r.json.recoveredFrom, `${method} crash replay: says which head it recovered from`)
  assertEq(w.remote('T-1'), r.json.headSha, `${method} crash replay: reports the pushed head`)
  assertEq(w.remote('T-1'), w.rev(w.wt, 'HEAD'), `${method} crash replay: the worktree moved to the pushed head`)
  assertEq(first.json.headSha, w.remote('T-1'), `${method} crash replay: nothing was pushed again`)
  assertEq('', git(w.wt, ['status', '--porcelain']), `${method} crash replay: worktree clean`)
}

// A crash between the scratch worktree's creation and its removal leaves it registered; a later
// call removes what a dead process left (by the pid in its name) and ignores a live one's.
{
  const w = world()
  const wts = w.worktrees()
  const deadPid = 2 ** 22 - 7
  const dead = join(mkdtemp(`update-from-base-${deadPid}-`), 'wt')
  git(w.wt, ['worktree', 'add', '-q', '--detach', dead, 'HEAD'])
  const gone = join(mkdtemp(`update-from-base-${deadPid}-`), 'wt')
  git(w.wt, ['worktree', 'add', '-q', '--detach', gone, 'HEAD'])
  rmSync(gone, { recursive: true, force: true })
  const live = join(mkdtemp(`update-from-base-${process.pid}-`), 'wt')
  git(w.wt, ['worktree', 'add', '-q', '--detach', live, 'HEAD'])
  assertEq(wts + 3, w.worktrees(), 'leaked scratch: three extra worktrees registered')
  const r = run(w, 'merge')
  assertEq(0, r.status, 'leaked scratch: the update still succeeds')
  assertEq(wts + 1, w.worktrees(), 'leaked scratch: the dead process\'s worktrees are gone, the live one stays')
  assertTrue(!existsSync(dead), 'leaked scratch: the dead one\'s directory is removed')
  assertTrue(existsSync(live), 'leaked scratch: the live one\'s directory stays')
  git(w.wt, ['worktree', 'remove', '--force', live])
}

report()
