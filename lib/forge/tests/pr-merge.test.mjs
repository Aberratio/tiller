import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, writeStub, runScript, assertEq, assertTrue, report } from './helpers.mjs'

const bin = mkdtemp()
const mergeCalled = join(bin, 'merge-called')
writeStub(bin, 'gh', `
if [[ "$1 $2" == "pr view" ]]; then
  echo '{"headRefOid":"headsha","state":"OPEN"}'
  exit 0
fi
if [[ "$1 $2" == "pr merge" ]]; then
  touch "${mergeCalled}"
  exit 0
fi
exit 1
`)

const noAuthority = runScript('pr-merge.mjs', ['--repo', 'acme/widgets', '--pr', '5'], { binDir: bin })
assertEq(4, noAuthority.status, 'refuses (exit 4) with no --authority token')
assertEq('refused', noAuthority.json.status, 'status refused')
assertEq('policy', noAuthority.json.kind, 'kind policy')
assertTrue(!existsSync(mergeCalled), 'gh pr merge is never called without authority')

const wrongAuthority = runScript('pr-merge.mjs', ['--repo', 'acme/widgets', '--pr', '5', '--authority', 'human'], { binDir: bin })
assertEq(4, wrongAuthority.status, 'refuses a non-agent authority token too')
assertTrue(!existsSync(mergeCalled), 'still never merges')

const shaMismatch = runScript('pr-merge.mjs', ['--repo', 'acme/widgets', '--pr', '5', '--authority', 'agent', '--sha', 'stalesha'], { binDir: bin })
assertEq(3, shaMismatch.status, 'a moved head blocks the merge (exit 3)')
assertEq('conflict', shaMismatch.json.kind, 'kind conflict on a sha mismatch')
assertTrue(!existsSync(mergeCalled), 'never merges a head other than the one authorised')

const ok = runScript('pr-merge.mjs', ['--repo', 'acme/widgets', '--pr', '5', '--authority', 'agent', '--sha', 'headsha'], { binDir: bin })
assertEq(0, ok.status, 'merges once authority and sha both check out')
assertEq(true, ok.json.merged, 'reports merged')
assertTrue(existsSync(mergeCalled), 'gh pr merge was actually invoked')

// A relaunch after a crash between the merge click and its checkpoint: the PR is already merged.
const bin2 = mkdtemp()
const merged2 = join(bin2, 'merge-called')
writeStub(bin2, 'gh', `
if [[ "$1 $2" == "pr view" ]]; then
  echo '{"headRefOid":"headsha","state":"MERGED"}'
  exit 0
fi
if [[ "$1 $2" == "pr merge" ]]; then touch "${merged2}"; exit 0; fi
exit 1
`)
const already = runScript('pr-merge.mjs', ['--repo', 'acme/widgets', '--pr', '5', '--authority', 'agent', '--sha', 'headsha'], { binDir: bin2 })
assertEq(0, already.status, 'an already merged PR is a success')
assertEq(true, already.json.merged, 'reports merged')
assertEq(true, already.json.alreadyMerged, 'and says it was merged before this call')
assertEq(5, already.json.number, 'with the PR number')
assertTrue(!existsSync(merged2), 'gh pr merge is not called again')

const alreadyNoSha = runScript('pr-merge.mjs', ['--repo', 'acme/widgets', '--pr', '5', '--authority', 'agent'], { binDir: bin2 })
assertEq(0, alreadyNoSha.status, 'the merged state is checked even without --sha')
assertEq(true, alreadyNoSha.json.alreadyMerged, 'and reported')
assertTrue(!existsSync(merged2), 'still no second merge click')

const alreadyNoAuthority = runScript('pr-merge.mjs', ['--repo', 'acme/widgets', '--pr', '5'], { binDir: bin2 })
assertEq(4, alreadyNoAuthority.status, 'authority is still required before anything is looked up')

report()
