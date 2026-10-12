import { mkdtemp, writeStub, runScript, assertEq, assertTrue, report } from './helpers.mjs'

const bin = mkdtemp()
// gh api repos/<repo>/commits/<sha>/check-runs — one string argument carries the SHA, so the
// stub answers per exact SHA, proving the script never settles on the wrong commit.
writeStub(bin, 'gh', `
path="$2"
case "$path" in
  *commits/greensha/check-runs*) echo '{"check_runs":[{"name":"build","status":"completed","conclusion":"success"}]}' ;;
  *commits/redsha/check-runs*)   echo '{"check_runs":[{"name":"build","status":"completed","conclusion":"failure"},{"name":"lint","status":"completed","conclusion":"success"}]}' ;;
  *commits/pendingsha/check-runs*) echo '{"check_runs":[{"name":"build","status":"in_progress","conclusion":null}]}' ;;
  *commits/skippedsha/check-runs*) echo '{"check_runs":[{"name":"build","status":"completed","conclusion":"skipped"},{"name":"lint","status":"completed","conclusion":"skipped"}]}' ;;
  *commits/mixedsha/check-runs*) echo '{"check_runs":[{"name":"build","status":"completed","conclusion":"success"},{"name":"deploy","status":"completed","conclusion":"skipped"}]}' ;;
  *) echo '{"check_runs":[]}' ;;
esac
`)

const green = runScript('wait-ci.mjs', ['--repo', 'acme/widgets', '--sha', 'greensha', '--timeout', '2', '--interval', '1'], { binDir: bin })
assertEq(0, green.status, 'settled green exits ok')
assertEq('green', green.json.state, 'reports green when every check run succeeded')
assertEq('greensha', green.json.sha, 'echoes back the requested sha')

const red = runScript('wait-ci.mjs', ['--repo', 'acme/widgets', '--sha', 'redsha', '--timeout', '2', '--interval', '1'], { binDir: bin })
assertEq(0, red.status, 'settled red still exits ok (a measurement, not a script failure)')
assertEq('red', red.json.state, 'one failing check run makes the sha red')

const skipped = runScript('wait-ci.mjs', ['--repo', 'acme/widgets', '--sha', 'skippedsha', '--timeout', '2', '--interval', '1'], { binDir: bin })
assertEq(0, skipped.status, 'settled all-skipped exits ok')
assertEq('blocked', skipped.json.state, 'every check skipped proves nothing: blocked, never green')

const mixed = runScript('wait-ci.mjs', ['--repo', 'acme/widgets', '--sha', 'mixedsha', '--timeout', '2', '--interval', '1'], { binDir: bin })
assertEq('green', mixed.json.state, 'a skipped check next to a passing one stays green')

const pending = runScript('wait-ci.mjs', ['--repo', 'acme/widgets', '--sha', 'pendingsha', '--timeout', '1', '--interval', '1'], { binDir: bin })
assertEq(2, pending.status, 'never settling within the timeout exits pending (2)')
assertEq('pending', pending.json.status, 'payload status is pending')
assertTrue(!pending.json.kind, 'pending carries no kind')

report()
