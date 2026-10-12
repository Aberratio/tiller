import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, writeStub, runScript, assertEq, assertTrue, report } from './helpers.mjs'

const bin = mkdtemp()
const marker = join(bin, 'called-with-draft')
writeStub(bin, 'gh', `
if [[ "$1 $2" == "pr create" ]]; then
  [[ "$*" == *"--draft"* ]] && touch "${marker}"
  echo "https://example.invalid/acme/widgets/pull/77"
  exit 0
fi
exit 1
`)

const body = join(bin, 'body.md')
writeFileSync(body, 'body')

const r = runScript('pr-open.mjs', ['--repo', 'acme/widgets', '--base', 'main', '--head', 'feature', '--title', 't', '--body-file', body], { binDir: bin })
assertEq(0, r.status, 'exits ok')
assertEq('https://example.invalid/acme/widgets/pull/77', r.json.prUrl, 'returns the created PR url')
assertEq(77, r.json.number, 'parses the PR number from the url')
assertEq(true, r.json.draft, 'always opens as draft')
assertTrue(existsSync(marker), 'always passes --draft to gh pr create')

report()
