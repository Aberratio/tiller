# When the red is not the red you think it is

**The rule: a test's first red must fail on its assertion.** Read the failure message before believing it. A failure to mount, a missing browser API, or a stale artifact is a *false red* — it proves nothing about behaviour, and the green that follows proves nothing either. Sessions have spent four of six red→green iterations on harness work; recognising the class up front is what turns that into minutes.

Clear the harness first, then take the red.

## The instrument failed, and its silence read as a result

**Before believing what a run told you, confirm the run happened.** A red, a green and an empty output are
three different things, and a broken instrument produces the third while looking like one of the first two.
This is the same class as a false red, one level further out: not "the failure is not the ticket's failure"
but "there was no measurement at all".

Three shapes seen on this machine, all in one session:

- **A wrapper that does not exist.** `timeout 180 npx vitest …` exits **127** on macOS — there is no
  `timeout` binary. Every such run produced no test output, and the absence was read as "the baseline hangs
  too, so it is the environment", which moved blame off the change under test. Check `command -v` for any
  wrapper you have not used in this repo before, and prefer the harness's own backgrounding.
- **A probe whose output never arrives.** A `console.log`-based probe that prints nothing has not told you
  the condition is false. Assert something that fails loudly, or write to a file and read the file.
- **Stale workers from earlier runs.** Killed or abandoned test processes keep spinning and poison every
  later timing on the same machine (`pkill -f "vitest/dist/workers"` before measuring).

The tell that you are in this trap: **the conclusion happens to be the one that exonerates your own change.**
Re-run the same check a second way before writing it down.

## Waiting on the wrong effect, and the fix that hangs

When one action produces two observable effects in sequence — a side effect and then a state update —
waiting on the **earlier** one and asserting the **later** one synchronously is a race by construction.
Seen for real: `t.stop()` then `setStatus('camera error: …')` inside one `catch`; the test awaited the stop
and then read the rendered message, and lost that race once on CI, taking `main` red and skipping a deploy.

**The obvious repair is not to move the assertion into the retried callback.** Where the callback also
*triggers* the action (`dispatchEvent` inside `waitFor`), each poll re-enters the path and schedules another
render, and the wait never settles — measured as one fork worker spinning at 100 % CPU for seven minutes on
a file that otherwise runs in a second. Trigger once, then wait (`findByText`), and keep the trigger out of
the polled callback.

## Missing browser APIs (jsdom)

A UI library's components reach for platform APIs jsdom does not implement. Observed: `matchMedia` and `ResizeObserver` (segmented controls), `document.fonts` (autosize textareas). Stub them in the test setup file — once, for the whole suite — rather than per test.

## Animation hides the thing under test

An animated container never finishes animating in jsdom, because no `transitionend` fires. The symptom is a confusing half-visible state: the opened panel stays `display: none`, so `getByRole`/`getByLabelText` find nothing while `getByText` still matches. A test-mode provider flag alone does not fix it.

Fix it through the library's own default props, which leaves page code untouched:

```ts
createTheme({ components: { Collapse: { defaultProps: { transitionDuration: 0 } } } })
```

## Framework event pooling

Reading `e.currentTarget` lazily inside a `setState` updater reads it after the event object has been recycled. Capture the value at the top of the handler.

## A stale build artifact (e2e)

Playwright's `webServer` typically runs a preview server over a previously built `dist/`, so a brand-new e2e test can fail against **pre-change code** and the page snapshot shows the old UI. `npm run build` before trusting a local e2e red.

**A scripted mutation loop turns this trap into a false *green*.** A mutation map (`references/../SKILL.md` step 4) usually runs as a shell loop — mutate, build, test, restore — and the build is the line people quiet with `>/dev/null 2>&1`. When a mutation is what breaks the build, the loop tests the *previous* `dist/` and the mutation reads as **uncaught**, so the conclusion drawn is "this test does not hold that rule" when the truth is the opposite. Measured on ABC-220: removing a provider prop left its import unused, `tsc --noEmit` rejected it, the swallowed build failed, and Playwright re-ran the stale bundle — 5 passed, the mutation looked uncaught, and the test it was supposed to grade was in fact the strongest one in the file (it reddens 3 tests once the mutation actually compiles). Two rules follow: **check the build's exit code inside the loop and print "BUILD FAILED" instead of a test count**, and when a mutation cannot compile, fix the mutation so it does (delete the now-unused import, or pick a mutation of the same rule that typechecks) rather than recording a result for it. A mutation the toolchain rejects has produced no measurement at all — it is neither caught nor uncaught.

Same class, different tool: a stale `node_modules` makes lint and test lie in both directions. Before fixing any failure a verification command reports, prove it is yours — does it touch a file in your diff, and does it reproduce with the *declared* tool versions (`node -p "require('./node_modules/<pkg>/package.json').version"` against the lockfile)?

## Verifying the red was honest, at the end

Writing the test before the implementation is not evidence that the test can fail. At the end of the loop:

1. revert only the implementation file(s) — `git stash push <impl paths>`,
2. re-run the affected test files,
3. check that each test you believe is red goes red **for its stated reason**, not for a compile error caused by the revert,
4. restore.

Tests that stay green are pins. That is fine — but only once they are labelled as pins.

**The swap itself can lie.** Restoring the implementation and re-running immediately can hit a cached bytecode/build of the *broken* copy: Python invalidates a `.pyc` on (mtime, size), and a revert that lands within the same second on a file whose size did not change (a reordered block, a swapped pair of lines) matches the cache and the interpreter reuses the broken compile. The symptom is the honest red staying red *after* you restored the file — a false negative, and the tempting reading is "my implementation was wrong all along". Clear the cache (`rm -rf __pycache__ */__pycache__`, `rm -rf .pytest_cache`, the JS equivalent being a stale bundler cache) before you trust the run after a restore, or restore via `git stash pop` / `git checkout --` instead of copying a file back over itself.
