import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, writeStub, runScript, assertEq, assertTrue, report } from './helpers.mjs'

const bin = mkdtemp()
const marker = join(bin, 'called-with-draft')
const listed = join(bin, 'listed-with')
writeStub(bin, 'gh', `
if [[ "$1 $2" == "pr list" ]]; then
  echo "$*" > "${listed}"
  echo '[]'
  exit 0
fi
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
assertTrue(existsSync(listed) && /--head feature/.test(readFileSync(listed, 'utf8')) && /--base main/.test(readFileSync(listed, 'utf8')), 'looks for an open PR of this head onto this base before creating one')
assertEq(undefined, r.json.existing, 'a freshly created PR is not reported as existing')

// A relaunch after a crash between `gh pr create` and its checkpoint: the PR is already there.
const bin2 = mkdtemp()
const created2 = join(bin2, 'create-called')
writeStub(bin2, 'gh', `
if [[ "$1 $2" == "pr list" ]]; then
  echo '[{"number":78,"url":"https://example.invalid/acme/widgets/pull/78","isDraft":true}]'
  exit 0
fi
if [[ "$1 $2" == "pr create" ]]; then touch "${created2}"; exit 0; fi
exit 1
`)
const again = runScript('pr-open.mjs', ['--repo', 'acme/widgets', '--base', 'main', '--head', 'feature', '--title', 't', '--body-file', body], { binDir: bin2 })
assertEq(0, again.status, 'an existing open PR for the head is ok')
assertEq('https://example.invalid/acme/widgets/pull/78', again.json.prUrl, 'returns the existing PR url')
assertEq(78, again.json.number, 'and its number')
assertEq(true, again.json.existing, 'says it was found, not created')
assertEq(true, again.json.draft, 'carries the existing PR\'s draft state')
assertTrue(!existsSync(created2), 'never opens a second PR for the same head')

// The lookup itself failing is not "no PR": creating blind could open a duplicate.
const bin3 = mkdtemp()
const created3 = join(bin3, 'create-called')
writeStub(bin3, 'gh', `
if [[ "$1 $2" == "pr list" ]]; then echo "boom" >&2; exit 1; fi
if [[ "$1 $2" == "pr create" ]]; then touch "${created3}"; exit 0; fi
exit 1
`)
const broken = runScript('pr-open.mjs', ['--repo', 'acme/widgets', '--base', 'main', '--head', 'feature', '--title', 't', '--body-file', body], { binDir: bin3 })
assertEq(1, broken.status, 'a failed lookup is a script error')
assertEq('script-error', broken.json.kind, 'kind script-error')
assertTrue(!existsSync(created3), 'and nothing is created')

report()
