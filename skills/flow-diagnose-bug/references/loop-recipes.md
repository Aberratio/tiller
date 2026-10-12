# Loop recipes

Ways to build the pass/fail signal, roughly in order of how often they are the right answer here.
Pick the cheapest one that can go red on *this* bug; tighten it afterwards.

## The general ladder

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright) — drives the UI, asserts on DOM, console, network.
5. **Replay a captured trace** — a real payload or recording, replayed through the code path in
   isolation. Often the most productive shape: a corpus of recorded inputs makes an
   unattended, deterministic loop essentially free.
6. **Throwaway harness** — a minimal subset of the system exercising the path in one call.
7. **Property / fuzz loop** — for "sometimes wrong output", run 1000 inputs and look for the mode.
8. **Bisection harness** — automate "boot at state X, check, repeat" so `git bisect run` works.
9. **Differential loop** — same input through two versions or two configs, diff the outputs.
10. **HITL script** — last resort, when a human must click; drive them from a script so the loop
    is still structured and its output still feeds back.

## Deployed-environment / artifact bugs

The bug is not in the code; the code never arrived. Symptom shape: works locally, fails on
staging, and the error names something structural ("ModuleFactory not set", "Unexpected token <").

The loop is a script that fetches the deployed artifacts and asserts on what came back:

```bash
for url in "$BASE/assets/foo.wasm" "$BASE/assets/foo.js"; do
  code=$(curl -s -o /tmp/body -w '%{http_code}' "$url")
  type=$(file -b --mime-type /tmp/body)
  head -c 64 /tmp/body | grep -qi '<!doctype html' && verdict=SPA-FALLBACK || verdict=ok
  printf '%-60s %s %s %s\n' "$url" "$code" "$type" "$verdict"
done
```

**Assert three things, not one:** status, content type, and a content marker. The failure class
that a bare status check misses is the **SPA 200-but-HTML fallback** — the router happily serves
`index.html` for a missing asset, so every URL is 200 and every asset is broken. Name it when you
see it; it is the single most common shape of this bug.

Then compare against the local build output (`ls dist/…`) to tell "the build never produced it"
from "the build produced it and the deploy dropped it". Those have different fixes.

The regression test for this class is a **CI assertion on the build artifact**, not a code test.
An e2e suite that uses a replay stub will stay green forever while production is broken.

## Config / tuning regressions (the bug is in data, not in a commit)

When the regression came from a tuned value pushed through an API — a reference JSON, a threshold,
a feature-flag payload — there are no two commits to bisect. The two states are two values of one
field.

Recipe: replay one recorded input through the shared engine twice, with exactly one field flipped,
and print a per-channel or per-stage verdict rather than a single boolean.

```
node probe.js --recording <id> --config current   # 0/401 setup frames pass
node probe.js --recording <id> --config pre-tune  # 321/401 pass
```

Two runs isolate the cause. The per-stage histogram is what names the culprit without any code
instrumentation — a single pass/fail number would have told you nothing.

Two consequences worth stating in the write-up:

- **The differential loop is the hypothesis test.** Don't manufacture a separate ranked list.
- **The fix may not be a patch.** Somebody moved that knob on purpose, for another input or
  another cohort. The deliverable is the trade-off with both measurements attached, and a ticket.

## Tightening, whatever the recipe

- Faster: cache setup, skip unrelated init, narrow scope.
- Sharper: assert the specific symptom, not "didn't crash".
- More deterministic: pin time, seed RNG, isolate the filesystem, freeze the network.
- Non-deterministic bugs: the goal is a *higher reproduction rate*, not a clean repro. 50% is
  debuggable; 1% is not. Loop the trigger, parallelise, add stress, narrow timing windows.

## Timing flakes: amplify the mechanism, not the environment

Imitating the environment is the obvious move and the weak one. Reproducing a CI-only test flake by
loading the CPU (concurrent runs plus burners, imitating a 2-vCPU runner) reached **6%** — 2 reds in
34 samples. Not enough to prove a fix: 0/36 green afterwards is nearly as likely with no fix at all.

Once you know *what* the slow machine does differently, drive that variable directly and the loop
goes deterministic. Here the mechanism was React's scheduler yielding mid-render because a work
slice exceeded its 5 ms budget, leaving the commit one macrotask later than the single tick
`waitFor`'s caller grants. The scheduler's only notion of "this CPU is slow" is elapsed time per
slice, read from `performance.now` — so skewing that clock *is* a slow CPU, faithfully, and it took
the same test to **9/10 red**, then 0/10 after the fix. Same idea elsewhere: skew the clock the code
reads, not the machine; force the retry, don't wait for the packet loss.

**The control is not optional.** An amplifier that reddens everything proves nothing. Run the whole
file and the whole suite under it: the sibling test in the same file stayed green (it drives time
inside `act()`, which flushes), and 83 files / 1073 tests passed. That is what promoted "the
amplifier reproduces the bug" to "the amplifier reproduces *this* bug and nothing else".

**Then the amplifier is also a sweep.** A knob that deterministically exposes one instance of a
pattern exposes every instance, so a single suite run under it answers "how many other tests have
this defect?" — here, none.

Before either: measure the margin. A probe that recorded, over 5 identical runs, that the asserted
text was absent from the DOM at every poll-pass and appeared after exactly 0 extra macrotasks
proved the green had *zero* slack. That number is what made the mechanism obvious, and it came
before any attempt to reproduce.
