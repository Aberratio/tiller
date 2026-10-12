import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, writeStub, runScript, assertEq, assertTrue, report } from './helpers.mjs'

const bin = mkdtemp()
const mergeCalled = join(bin, 'merge-called')
writeStub(bin, 'gh', `
if [[ "$1 $2" == "pr view" ]]; then
  echo '{"headRefOid":"headsha"}'
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

report()
