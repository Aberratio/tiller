import { join } from 'node:path'
import { mkdtemp, writeStub, runScript, assertEq, report } from './helpers.mjs'

// A stub that answers `gh pr ready` unconditionally ok, and `gh pr view --json isDraft,...`
// with isDraft flipping to false after `flips` prior "pr ready" calls have been recorded. Mirrors
// A real incident: `gh pr ready` exiting 0 is not proof the PR left draft state, so the script
// must re-read before it ever claims ok.
function stubGh(bin, { flips = 0, viewFails = false } = {}) {
  const readyLog = join(bin, 'ready-log')
  writeStub(bin, 'gh', `
if [[ "$1 $2" == "pr ready" ]]; then
  echo x >> "${readyLog}"
  exit 0
fi
if [[ "$1 $2" == "pr view" ]]; then
  ${viewFails ? 'exit 1' : ''}
  n=$(wc -l < "${readyLog}" 2>/dev/null | tr -d ' ')
  n=\${n:-0}
  if [[ "$n" -gt ${flips} ]]; then
    echo '{"isDraft":false,"number":9}'
  else
    echo '{"isDraft":true,"number":9}'
  fi
  exit 0
fi
exit 1
`)
  return readyLog
}

// 1. `gh pr ready` succeeds and the very next read already shows isDraft:false.
{
  const bin = mkdtemp()
  stubGh(bin, { flips: 0 })
  const r = runScript('pr-ready.mjs', ['--repo', 'acme/widgets', '--pr', '9'], { binDir: bin })
  assertEq(0, r.status, 'exits ok once the re-read confirms isDraft is false')
  assertEq('ok', r.json.status, 'status ok')
  assertEq(false, r.json.draft, 'reports the PR as no longer draft')
}

// 2. First read still shows isDraft:true; one retry of `gh pr ready` flips it, second read is false.
{
  const bin = mkdtemp()
  stubGh(bin, { flips: 1 })
  const r = runScript('pr-ready.mjs', ['--repo', 'acme/widgets', '--pr', '9'], { binDir: bin })
  assertEq(0, r.status, 'the one retry succeeds')
  assertEq('ok', r.json.status, 'status ok after the retry')
  assertEq(false, r.json.draft, 'reports not-draft once the retry took')
}

// 3. Still draft after the retry: never ok, a non-ok status the runner can treat as a blocked
// gate condition, carrying the evidence.
{
  const bin = mkdtemp()
  stubGh(bin, { flips: 99 })
  const r = runScript('pr-ready.mjs', ['--repo', 'acme/widgets', '--pr', '9'], { binDir: bin })
  assertEq(3, r.status, 'exits blocked (3), never ok, when the PR is still draft after one retry')
  assertEq('blocked', r.json.status, 'status blocked')
  assertEq(true, r.json.draft, 'still reports draft:true')
  assertEq('string', typeof r.json.reason, 'carries evidence for the gate')
}

// 4. The re-read itself fails (`gh pr view` errors): an error detail must never map to ok.
{
  const bin = mkdtemp()
  stubGh(bin, { viewFails: true })
  const r = runScript('pr-ready.mjs', ['--repo', 'acme/widgets', '--pr', '9'], { binDir: bin })
  assertEq(1, r.status, 'exits error, not ok, when the confirming read fails')
  assertEq('error', r.json.status, 'status error')
}

// 5. `gh pr ready` itself fails on the first call: unchanged pre-existing behaviour.
{
  const bin = mkdtemp()
  writeStub(bin, 'gh', `
[[ "$1 $2" == "pr ready" ]] && exit 1
exit 1
`)
  const r = runScript('pr-ready.mjs', ['--repo', 'acme/widgets', '--pr', '9'], { binDir: bin })
  assertEq(1, r.status, 'exits error when gh pr ready itself fails')
  assertEq('error', r.json.status, 'status error')
}

report()
