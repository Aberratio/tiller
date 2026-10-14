# Browser evidence — what makes an agent's observation citable

Read before the first browser step. The instrument, its evidence directory, its profile directory and
the origins it is scoped to are in the profile's `## environments`.

## Before the first step

**Confirm the bundle from the browser too.** `curl -I` on the origin and the page a real profile loads
can disagree — a service worker, a CDN edge, a cached HTML shell. Load the page, read the asset names it
references, and match them against what the origin serves. The cheapest Step 0 check, and the one an
agent with the page already open is most likely to skip.

**The config file is not the instrument — read the running process's argv.** Once the MCP
config carried a staging host in `--allowed-origins` and navigation still returned
`ERR_BLOCKED_BY_CLIENT`: the server process had started before the edit and enforced the old list. An
`--allowed-origins` change is inert until the server restarts; the file records an intention, the argv
records what is enforced:

```
ps aux | grep playwright-mcp | tr ';' '\n'
```

A block the origin filter fully explains has been written down three times as something more exotic —
a hostile server, a keychain problem, a harness refusal — and each time the next session inherited the
wrong cause. **Before recording *why* a browser step could not run, read the argv and the console log.**

## Writing the artefact

- **Verify it exists on disk and is not empty.** Measured: a snapshot with a `filename` wrote
  a **0-byte** file while reporting success, and a screenshot with a *relative* filename ignored
  `--output-dir` and landed in the session's cwd. Pass absolute paths, prefer screenshots over
  snapshot-to-file, and run `scripts/check-artefacts.mjs` on the result before citing it (SKILL.md
  Step 6); the relative-filename case recurs.
- **Subtract your own requests from the console log before attributing anything to the product.** Probes,
  guessed URL shapes and second tabs leave their failures in the same log. Example: three `404`s on a
  guessed endpoint shape were the agent's, and an early draft of the record attributed them to the wrong
  tab. State the error **classes** with counts, name which are yours, and say how "zero errors from
  application code" was established — the grep, and what it left.
- **Read the value at the boundary the code under test reads, not at the transport.** A response can be
  transformed or re-keyed between the wire and the consumer. Once a precondition was read off the
  prop handed to the running component instead of the response body — the same effort, a strictly
  stronger claim.

## Failure modes that looked like product defects

- **A blocked sub-resource looks exactly like a hostile server.** Once a sign-in page was denied
  its own JavaScript by the origin list, `ERR_BLOCKED_BY_CLIENT` sat in the log both days, and two wrong
  diagnoses and a config change aimed at neither came first.
- **A blocked navigation is not a harness refusal.** Once a register row said the harness
  refused the navigation; the call had executed and the MCP server's own origin filter blocked it. A
  harness refusal parks with the rule named; an origin-filter block clears on a reconnect. Read the argv
  before writing either.
- **A click that times out on "waiting for element to be visible, enabled and stable"** is not yet a
  broken control. Ask the DOM: `opacity`, `pointer-events`, `elementFromPoint` at the box centre, the same
  id and bounding box sampled ten times over two seconds. Once all said clickable; the Chrome
  window attached over CDP was **occluded behind the terminal**, so no frames were produced and the
  actionability check, which waits on `requestAnimationFrame`, never settled. Two false leads came first:
  two tabs on one URL reordering between calls, and a render loop the ten samples refuted.
- **Falling back to `element.click()` without writing the fallback into the record.** A synthetic event
  is legitimate — it is Step 2's "manufacture the state" — but it verifies the persistence path, the
  server write and the rendered text, and says **nothing about whether a real pointer reaches the
  control**. Name it, and name the one click a human still owes.
