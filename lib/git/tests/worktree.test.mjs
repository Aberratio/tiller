import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, makeFixtureRepo, git, runScript, assertEq, assertTrue, report } from './helpers.mjs'

const repo = mkdtemp()
makeFixtureRepo(repo)
const wtDir = join(mkdtemp(), 'ticket-1')

const created = runScript('worktree.mjs', ['new', '--repo', repo, '--branch', 'ticket-1', '--base', 'main', '--dir', wtDir], {})
assertEq(0, created.status, 'creates a new worktree')
assertEq(true, created.json.created, 'reports created: true the first time')
assertEq('ticket-1', created.json.branch, 'echoes back the branch name')

const again = runScript('worktree.mjs', ['new', '--repo', repo, '--branch', 'ticket-1', '--base', 'main', '--dir', wtDir], {})
assertEq(0, again.status, 'calling new again on the same dir is not an error')
assertEq(false, again.json.created, 'reports created: false the second time (idempotent)')
assertEq(created.json.headSha, again.json.headSha, 'same head both times')

const list = runScript('worktree.mjs', ['list', '--repo', repo], {})
assertEq(0, list.status, 'lists worktrees')
assertTrue(list.json.worktrees.some(w => w.branch === 'ticket-1'), 'the new worktree shows up in the list')

// --command: the repo's own worktree script decides where the worktree lives; worktree.mjs runs it
// from the repo checkout and finds the result by branch, never by the --dir it was not given.
const nrepo = mkdtemp()
makeFixtureRepo(nrepo)
const elsewhere = mkdtemp('native-wt-')
mkdirSync(join(nrepo, 'bin'))
writeFileSync(join(nrepo, 'bin', 'worktree'), [
  '#!/bin/sh',
  'set -e',
  '[ -d .git ] || { echo "run this from the main checkout" >&2; exit 1; }',
  'echo "$1 $2 $3" >> "$NATIVE_LOG"',
  'echo "Fetching origin ..."',
  'git worktree add -q "$NATIVE_ROOT/$2" -b "$2" "$3"',
  'echo "COMPOSE_PROJECT_NAME=x" > "$NATIVE_ROOT/$2/.env.worktree"',
  'echo "Worktree ready: $NATIVE_ROOT/$2"',
].join('\n'))
chmodSync(join(nrepo, 'bin', 'worktree'), 0o755)
const nlog = join(elsewhere, 'calls.log')
const cmd = `NATIVE_LOG='${nlog}' NATIVE_ROOT='${elsewhere}' bin/worktree new <branch> <base>`

const native = runScript('worktree.mjs', ['new', '--repo', nrepo, '--branch', 'ABC-1-fix-it', '--base', 'main', '--command', cmd], {})
assertEq(0, native.status, `the repo command creates the worktree: ${native.stdout}`)
assertEq(realpathSync(join(elsewhere, 'ABC-1-fix-it')), realpathSync(native.json.path), 'the path is where the command put it, read back from git')
assertEq(true, native.json.created, 'created: true the first time')
assertEq('ABC-1-fix-it', native.json.branch, 'echoes back the branch')
assertEq(git(nrepo, ['rev-parse', 'main']).trim(), native.json.headSha, 'headSha of the new worktree')
assertTrue(existsSync(join(elsewhere, 'ABC-1-fix-it', '.env.worktree')), 'what the repo command scaffolds is there')
assertEq('new ABC-1-fix-it main\n', readFileSync(nlog, 'utf8'), '<branch> and <base> substituted, run once from the checkout')

const nativeAgain = runScript('worktree.mjs', ['new', '--repo', nrepo, '--branch', 'ABC-1-fix-it', '--base', 'main', '--command', cmd], {})
assertEq(0, nativeAgain.status, 'a second call is not an error')
assertEq(false, nativeAgain.json.created, 'created: false when the branch already has a worktree')
assertEq(native.json.path, nativeAgain.json.path, 'same path the second time')
assertEq('new ABC-1-fix-it main\n', readFileSync(nlog, 'utf8'), 'the repo command is not run again for a branch that has its worktree')

const failing = runScript('worktree.mjs', ['new', '--repo', nrepo, '--branch', 'ABC-2-x', '--base', 'main',
  '--command', 'echo noise <branch>; echo "git fetch origin failed - the base would be stale" >&2; exit 3'], {})
assertTrue(failing.status !== 0, 'a failing repo command fails the script')
assertEq('error', failing.json && failing.json.status, 'reported as an error')
assertTrue(/exit 3/.test(failing.json.reason) && /git fetch origin failed/.test(failing.json.reason), `the reason names the exit and the last stderr line: ${failing.json && failing.json.reason}`)

const silent = runScript('worktree.mjs', ['new', '--repo', nrepo, '--branch', 'ABC-3-y', '--base', 'main', '--command', 'echo <branch>'], {})
assertEq('error', silent.json && silent.json.status, 'a command that exits 0 without a worktree for the branch is an error')

const noBranch = runScript('worktree.mjs', ['new', '--repo', nrepo, '--branch', 'ABC-4-z', '--base', 'main', '--command', 'bin/worktree new'], {})
assertEq('refused', noBranch.json && noBranch.json.status, 'a command without <branch> is refused before it runs')

report()
