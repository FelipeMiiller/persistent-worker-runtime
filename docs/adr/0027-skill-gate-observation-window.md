# ADR-0027: The Skill Gate's Observation Contract — A Bounded Window of Deferred Work

- **Date**: 2026-10-27
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: skill-gate, ci, validation, coverage, observation-window, zero-dependency

## Context and Problem Statement

The skill gate (`scripts/validate-skill.js`) validates the shipped skill
(`skills/persistent-worker-runtime/`). The skill ships INSIDE the npm tarball and is
loaded by AI agents, which treat it as authoritative — a stale example there is
reproduced verbatim in someone else's production code.

The gate executes every JavaScript block in an isolated child process and classifies
the outcome. The defect of issue 009 — the outbox pattern's completion handler
reading `p.outboxId`, where `p` is the **worker-side** payload parameter of the task
function — reached the published package, and the gate reported the block as `OK`.

Two **independent** masks produced that, and either one alone hides the defect.

### Mask 1 — the import mask

ESM resolves and evaluates every static import **before any of the module body
runs**. Pattern 1 began with `import express from 'express'`, a package this
zero-dependency repository cannot install (ADR-0005). The child died at the import,
the body never executed, and the block was classified `EXTERNAL-DEPENDENCY` — a
label that reads like *"the only problem is a missing package"*, as if the rest of
the block had been checked. It had not.

### Mask 2 — the observation mask

The harness epilogue waited one tick (50 ms) and then called `process.exit(0)`. A
defect inside work the block **defers** — a timer callback, a promise chain, an
event handler — fires after that tick and was never observed. The outbox pattern's
drain runs on a 1000 ms timer, so the defect lived exactly there.

The two masks are independent, and the measurement makes that plain. With three
fixtures carrying the exact defect of issue 009:

| Fixture | Gate before this ADR | Gate with a 2500 ms observation window |
| ------- | -------------------- | --------------------------------------- |
| Buggy, no external import | `[OK]` — **the defect passed** | `[FRAGMENT]` — undefined identifier `"p"` |
| Fixed (`row.id`), no external import | `[OK]` | `[OK]` |
| Buggy, with `import express` | `[EXTERNAL-DEPENDENCY]` — body never ran | `[EXTERNAL-DEPENDENCY]` — body never ran |

The first row is the point: **the defect passes the old gate even when the import
mask is removed.** Fixing only the import mask would have been a vacuously green
fix — the gate would report a new, honest label for a block it still never ran.

### Why this needs an ADR

The gate is the repository's only defence against a broken snippet shipping to
npm, and its failure mode is silent: a block it does not observe is indistinguishable
from a block it validated. The observation contract — what the gate does and does
not see — is a design decision with a cost (wall-clock) and a limit (work deferred
beyond the window), and it needs a record rather than a constant in a script.

## Decision Drivers

- **A defect the gate cannot see is a defect that ships.** The skill is loaded by
  agents that treat it as authoritative.
- **The gate's wall-clock cost must not grow for the blocks that have nothing to
  defer.** The gate executes 39 JavaScript blocks; charging every one of them a
  2500 ms window would multiply its cost for no coverage gain.
- **A report must never read as a validation.** The reader has to be able to tell,
  per block and in the summary, whether the gate executed the body.
- **The existing category names must survive.** A new category would break the
  skill's own documentation of the gate's vocabulary for no gain.
- **Zero external dependencies, pure vanilla JS** (ADR-0005). The detection
  mechanism must be a Node built-in.

## Considered Options

- **Option A — observe a bounded window of deferred work** (this ADR). The harness
  detects whether the block left pending timer work and, when it did, keeps the
  event loop open for 2500 ms before exiting. Blocks with nothing to defer keep the
  50 ms fast path.
- **Option B — report the mask honestly and stop there.** Keep the 50 ms epilogue;
  make the `EXTERNAL-DEPENDENCY` label say the body was not executed. Honest, zero
  risk, and it leaves the observation mask in place.
- **Option C — stub the external imports so the body runs.** A loader hook, or
  rewriting the import lines before execution.
- **Option D — a static scope check** reporting identifiers that are read but never
  bound.

## Decision Outcome

Chosen option: **Option A — observe a bounded window of deferred work**, together
with Option B's honest reporting.

### The observation contract

The gate observes:

1. the block's **synchronous body** — every statement that runs before the module
   body suspends or completes; and
2. a **bounded window of deferred work** — 2500 ms of event-loop time, granted only
   to a block that left pending timer work behind.

Work deferred **beyond** the window is **not observed**. The limit is inherent to a
bounded harness: a harness that waited forever would hang the gate, and a harness
that waited long enough to cover every case would cost the same for every block.
The limit is recorded here rather than hidden.

### The detection mechanism

`process.getActiveResourcesInfo()` — a Node built-in, stable since Node 17.3, and
the repository already requires Node >= 22.13.0. It reports the resources that are
currently **keeping the event loop alive**, which answers exactly the question the
epilogue asks: *did this block leave a pending timer behind?*

Measured on Node v24.16.0, in the child process:

```
baseline            : []
with setInterval    : ["PipeWrap","PipeWrap","Timeout"]
with worker runtime : ["MessagePort","PipeWrap","PipeWrap"]
after a dispatch    : ["MessagePort","PipeWrap","PipeWrap"]
after shutdown      : ["PipeWrap","PipeWrap"]
```

Two consequences drive the design:

- **A worker runtime is not a `Timeout`.** It shows up as a `MessagePort`. The
  ten-odd skill blocks that merely create a runtime therefore keep the fast path.
  A gate that counted *any* active resource would charge the window to every block
  in the skill.
- **`PipeWrap` is always present** — it is the child's own stdout. It is not
  deferred work and is never counted.

The gate counts `'Timeout'` only. An `'Immediate'` is deliberately not counted: it
fires in the event loop's check phase, i.e. **before** the harness's own wait
resolves, so the fast path already observes it and charging the window would buy
no coverage.

### Why the check must run before the harness schedules its own wait

The harness's wait is itself a `Timeout`. If the check ran after the harness
scheduled its timer, every block in the skill would look like it had deferred work
and every block would pay the 2500 ms window. The epilogue therefore computes the
delay **first** and schedules its wait afterwards:

```js
const __pwrWindowMs = 2500;
const __pwrHasPendingTimer =
  __pwrWindowMs > 0 && process.getActiveResourcesInfo().includes('Timeout');
const __pwrDelayMs = __pwrHasPendingTimer ? __pwrWindowMs : 50;
await new Promise((resolve) => setTimeout(resolve, __pwrDelayMs));
```

### Why 2500 ms

The window is a measured value, not a round guess. The shipped outbox pattern's
timer fires at **1000 ms**, and a worker dispatch plus its failure path adds
roughly **100 ms** on top of that. 2500 ms covers the pattern with margin, and the
fixture probe confirms it is enough to surface the issue-009 defect class.

### The window must not shield the child

An error inside a deferred callback has to **terminate** the child, or the
classifier never sees it. The harness does not trap anything: an uncaught exception
inside a timer callback and an unhandled rejection from an async callback both take
the child down, and `classifyBlockFailure` reads the failure off the child's
stderr. That is what makes the shipped outbox pattern's completion handler — an
`async` callback whose rejection nobody handles — a reportable finding.

### Observing vs. not observing

The gate now records, per block, whether it **observed** the body. The child writes
an observation record: the preamble writes `body-started` as the first statement of
the module body, and the epilogue writes the delay it chose. A block that dies on
an unresolvable import never reaches the preamble — ESM resolved the import before
the body ran — so its record is absent, and the gate knows the body never executed.

That fact drives the report:

- the `EXTERNAL-DEPENDENCY` reason says **"the block body was NOT executed, so a
  defect inside it is invisible to the gate"** — or, for a dynamic import that fails
  *inside* the body, **"the block body ran up to the failure"**;
- the summary counts the blocks the gate **observed** against the blocks it did
  **not**, breaks the not-observed ones down by reason, and lists them;
- the summary reports how many blocks paid the observation window and how many
  kept the fast path, so the gate's cost is observable rather than implicit.

The category names are unchanged. `FRAGMENT`, `EXTERNAL-DEPENDENCY`,
`RUNTIME-ERROR` and `TIMEOUT` keep their meaning and their non-fatal status; what
changed is the wording and the summary, not the vocabulary.

### The shipped outbox pattern

A pattern the gate does not execute is a pattern the gate does not validate.
Pattern 1 is therefore split into a **dependency-free core** — the drain loop that
dispatches the job and registers the completion and failure handlers — and the
**external wiring** (Express, Postgres). The gate executes the core and
syntax-checks the wiring, which it reports honestly as not executed.

The core's stand-in `db` **resolves one row**. A stand-in that resolved none would
leave the loop body unexecuted and the gate blind again — exactly the failure this
ADR exists to remove.

## Pros and Cons of the Options

### Option A ✅ Chosen

- ✅ A defect inside deferred work is observable, and the issue-009 defect class is
  covered by execution instead of by a skip label.
- ✅ The gate's cost stays flat for the blocks that have nothing to defer: only a
  block with a pending timer pays the window. The summary reports the split.
- ✅ The contract is stated: what the gate observes, and what it does not.
- ✅ No new dependency, no new category, no change to `src/`.
- ✅ Provably non-vacuous: the regression suite runs the same fixture with the
  window disabled and asserts the defect is **not** reported.
- ❌ Work deferred beyond 2500 ms is still not observed. A block that defers for
  five seconds keeps its blind spot.
- ❌ A block with a pending timer costs 2500 ms of wall clock. Today that is one
  block in the skill; the number is reported in the summary so it stays visible.
- ❌ The observation window is a heuristic, not a proof. A block that defers work
  without a timer (a bare promise chain, for example) is not detected.

### Option B

- ✅ Honest, zero risk, and it makes the blind spot legible.
- ❌ It closes the import mask only. The measurement shows the defect still passes
  the gate with the import mask removed — a vacuously green fix.
- ❌ The defect class itself stays uncovered.

### Option C

- ✅ Would let the body of a block with an unresolvable import run.
- ❌ A permissive stub cannot produce the data shape a pattern needs — a
  `db.query()` that resolves one row — so the defect stays behind the stub's own
  failure, and the stub manufactures findings of its own. The shape belongs to the
  snippet, not to the harness.
- ❌ A loader hook is a loader hook: the harness would need to intercept module
  resolution for every snippet it runs, and a stub that returns the wrong shape
  turns a true finding into a false one.

### Option D

- ✅ Would catch the defect without executing anything.
- ❌ **It would not have caught this instance.** `p` *is* bound in the snippet: it
  is the parameter of the task function. The defect is a **cross-scope** reference
  — a binding of one function read from a sibling function's body — which a "read
  but never bound" check cannot see.
- ❌ Real scope analysis needs a JavaScript parser, and this repository has none
  (ADR-0005). Node exposes no built-in parser API, and adding one is forbidden by
  the zero-dependency rule. A general static scope gate is a design decision, not
  a patch.

## Verification

The contract is asserted by two suites:

- `test/skill-gate-observation-window.test.js` (7 tests) — the window is charged
  only to a block with pending timer work; a block that merely creates a worker
  runtime keeps the 50 ms fast path; the harness's own timer is not counted as the
  block's deferred work; the summary reports the cost of the window; an
  external-dependency block says its body was not executed; and a dynamic import
  that fails inside the body does **not** get that claim.
- `test/skill-gate-defect-class.test.js` (5 tests) — the issue-009 defect class is
  reported as a fragment naming the identifier, in the plain deferred form and in
  the dispatched form the shipped pattern uses.

**Non-vacuity was verified by disabling the window.** The same fixtures are run a
second time with `observationWindowMs: 0` — the pre-fix harness, which waits one
tick and exits. The defect is **not** reported there: the block passes. The suite
therefore fails if the window ever stops being load-bearing.

The shipped outbox pattern's core was verified by reintroducing the defect
(`p.outboxId` in the completion handler): the gate reports
`[FRAGMENT] references/patterns.md:18 — undefined identifier "p"`.

## Follow-ups

1. A block that defers work without a timer — a bare promise chain — is not
   detected by `getActiveResourcesInfo()`. The gate observes the synchronous body
   plus timer work; a promise chain that settles after the window is still not
   observed.
2. The pattern split (core vs. wiring) was applied to Pattern 1 only, because it is
   the one that carries the defect class of issue 009. The other patterns keep
   their (correct) `EXTERNAL-DEPENDENCY` label.

## Links

- Issue: `.agents/issues/009-skill-outbox-pattern-undefined-variable.md` (the
  defect, its two masks, and the corrected root cause).
- Spec: `.specs/features/skill-gate-coverage/spec.md`.
- Implementation: `scripts/validate-skill.js` — `buildEpilogue()`,
  `readObservationRecord()`, `runSkillGate()`.
- Tests: `test/skill-gate-observation-window.test.js`,
  `test/skill-gate-defect-class.test.js`.
- Related ADRs:
  - [ADR-0005](0005-native-javascript-esm-with-zero-external-dependencies.md) —
    pure vanilla JS, zero external dependencies; the reason a static scope check
    and an import stub are out of reach.
  - [ADR-0025](0025-fire-and-forget-dispatch-promise-contract.md) — the
    `dispatch()` promise contract the shipped outbox pattern depends on.
