import { mkdtemp, writeStub, runScript, assertEq, report } from './helpers.mjs'

const bin = mkdtemp()
writeStub(bin, 'gh', `
if [[ "$1 $2" == "pr view" ]]; then
  echo '{"headRefOid":"abc1234","mergeStateStatus":"CLEAN","state":"OPEN","mergeable":"MERGEABLE","isDraft":false,"number":42,"url":"https://example.invalid/pr/42"}'
  exit 0
fi
exit 1
`)

const r = runScript('pr-state.mjs', ['--repo', 'acme/widgets', '--pr', '42'], { binDir: bin })
assertEq(0, r.status, 'exits 0 on a clean read')
assertEq('ok', r.json.status, 'status ok')
assertEq('abc1234', r.json.headSha, 'passes through headRefOid as headSha')
assertEq('CLEAN', r.json.mergeStateStatus, 'passes through mergeStateStatus verbatim')

report()
