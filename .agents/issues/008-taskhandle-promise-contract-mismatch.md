# `TaskHandle.promise` is documented as internally `.catch()`-handled — and it is not

**Status**: ✅ **FIXED** 2026-10-23 — Option A implemented (ADR-0025). The published
contract is now true for `dispatch()`; `execute()`'s ADR-0018 hazard is deliberately
preserved.

**Discovered**: 2026-10-23, during the audit of the Node 26 / execution-gate work
(issue 004 and issue 006), surfaced by the D3 failure of the skill gate.
**Component**: `src/worker-runtime.js`, `src/task-handle.js`, `docs/adr/0018-*.md`,
`skills/persistent-worker-runtime/references/observability.md`

## The claim

`src/worker-runtime.js:942-943` — the `dispatch()` JSDoc:

> - `.promise` (already `.catch()`-handled internally by the handle, so
>   unhandled-rejection warnings do not fire on legitimate cleanup)

and `src/worker-runtime.js:924`:

> with `onComplete` / `onError` and an internally-captured `.promise.catch()`.

`docs/adr/0018-fire-and-forget-hazard-with-execute-and-post-shutdown-flakes.md` (§Architectural
Mechanics, L122-124) makes the same claim and **builds the accepted decision on it**:

> - If you intentionally want fire-and-forget semantics, use `dispatch()` ...
>   `.promise` (which has `.catch()` attached internally by the handle).

ADR-0018 chose **Option 3** (L62): *"Document the hazard + harden the existing API surface"* — no
runtime change — and states at L74 that *"the hazard is already eliminated by `dispatch()` existing"*.
Both halves of that reasoning assume the internal catch exists.

## The reality

1. `src/task-handle.js` contains **zero** `.catch(` occurrences. The promise is created at
   `src/task-handle.js:115` and returned to the caller untouched:

   ```js
   this.promise = new Promise((resolve, reject) => {
     this._resolve = resolve;
     this._reject = reject;
   });
   ```

2. The only `.catch()` in `dispatch()` is on the **enqueue** promise, not on the handle's promise
   (`src/worker-runtime.js:995-1002`):

   ```js
   this.#queue.enqueue(task).then(() => { this.#scheduleNext(); })
                 .catch((_err) => { /* Handled via task.reject() inside queue */ });
   ```

3. The same file **contradicts itself** 30 lines earlier, in `execute()`'s JSDoc
   (`src/worker-runtime.js:912-914`):

   > **Important**: the returned Promise MUST be awaited, `.then()`/`.catch()`-handled, ... without
   > `await` (or without attaching `.catch()`) leaves the worker vulnerable

## Why it is not academic

The failure is observable and it kills the user's process. The new skill gate caught it on its
first run (`references/quickstart.md:129`, the D3 defect):

- a `dispatch()`ed task is still queued when `shutdown()` runs;
- `runtime.shutdown()` calls `this.#queue.destroy(new WorkerRuntimeError('Runtime is shutting down'))`
  (`src/worker-runtime.js:1327`), and `queue.destroy()` **rejects** every queued task
  (`src/task-queue.js`: `task.reject(reason)` for each waiter and each queued task);
- the rejected `handle.promise` has no handler → **unhandled rejection → the process exits 1**.

A user who follows the shipped documentation ("safe, no unhandled-rejection warnings") and calls
`shutdown()` gets a crashed process. The documentation does not merely fail to warn — it actively
promises the opposite of the truth, and following it breaks the app.

The skill's own recommended outbox pattern does not save you either: `onError` registers a
**callback**, but it does not mark the promise as handled
(`skills/persistent-worker-runtime/references/observability.md:58-64`).

## The two options (this is the decision)

### Option A — implement the internal catch (restore the ADR's premise)

Attach a no-op handler to the handle's promise inside `dispatch()` (or in `TaskHandle`), so
fire-and-forget is genuinely safe, exactly as the JSDoc and ADR-0018 already describe.

- **Pro**: makes the implementation match the published contract; no user code changes; the ADR's
  reasoning ("the hazard is already eliminated by `dispatch()`") becomes true.
- **Con**: it is a **behaviour change** on a documented API — rejections that currently surface as
  unhandled rejections would be silently swallowed. ADR-0018 explicitly rejected that shape for
  `execute()` (Option 1, L60: *"masks genuine bugs"*), but said nothing about `dispatch()`, whose
  entire purpose is fire-and-forget.
- **Cost**: small code change + tests, but it needs an ADR (the repo's rule: every lifecycle or
  concurrency-pattern change gets a MADR record).

### Option B — make the documentation tell the truth

Correct the `dispatch()` JSDoc, amend ADR-0018's §Architectural Mechanics (and the L74 premise),
and make the shipped skill say that the caller must handle `handle.promise` — including in the
outbox pattern.

- **Pro**: no behaviour change; the docs stop lying.
- **Con**: `dispatch()` stops being "fire-and-forget safe" in practice, which weakens the API's
  headline ergonomics; every user hits the footgun the runtime could have absorbed.

### Recommendation

**Option A**, with the swallowing made *observable* rather than silent: attach the internal handler
but keep the rejection reachable through `onError` (which already exists) and document that
fire-and-forget tasks report failures through `onError`, not through the promise. That satisfies
ADR-0018's rejection of Option 1 (no masking) while making the published contract true. It still
needs an ADR, because it changes what a rejected fire-and-forget task does.

Option B is the honest fallback if the project prefers zero behaviour change — but then the
`dispatch()` JSDoc, ADR-0018 and the shipped skill must all be corrected together, and the skill
gate must gain a case that asserts a fire-and-forget `dispatch()` **does** produce an unhandled
rejection.

## Prevention

- **A documented contract is a testable claim.** "`.promise` is already `.catch()`-handled
  internally" is a behavioural promise; it needed a test, not a paragraph. The skill gate now
  catches the *symptom* (a crashing snippet); the *contract* is asserted by
  `test/dispatch-promise-contract.test.js` (ADR-0025).
- **An ADR that justifies a decision with an implementation claim inherits that claim's fate.**
  ADR-0018 reasoned from "dispatch() is safe" without the code doing it. When an ADR's premise is
  an implementation detail, the premise needs its own test.
- **`onError` is not `.catch()`.** A callback and a rejection handler are different things; the
  outbox pattern in the skill conflates them.

## What was implemented (Option A)

ADR-0025 (`docs/adr/0025-fire-and-forget-dispatch-promise-contract.md`).

`execute()` and `dispatch()` now share a private
`#dispatchTask(taskDefinition, { keepAlive })` in `src/worker-runtime.js`:

- **`dispatch()`** (and `dispatchAll()`, which maps it) attaches a no-op
  `.catch()` to the handle's promise. The promise still rejects —
  `await handle.promise` throws the same error — and `onError` still fires.
  A discarded handle can no longer raise an unhandled rejection.
- **`execute()`** attaches **nothing**. The caller owns the promise and must
  await it or `.catch()` it. The ADR-0018 hazard stays visible, exactly as
  Option 3 of that ADR decided.

`src/task-handle.js` was **not** touched — the contract is `dispatch()`'s, and
`TaskHandle` is also created by internal paths (`WorkerHandle.executeDirectTask`,
the SQLite queue backend's handle map) whose promise semantics must not change.

ADR-0018 was **amended** (not rewritten): the false claim in §Architectural
Mechanics and the false premise in §Decision Outcome → "Why not Option 2" are
now marked as corrected, and the "Amendment — 2026-10-23" section states what
was wrong, why it mattered, and what ADR-0025 changed. The decision ADR-0018
recorded (document the `execute()` hazard) is reaffirmed.

### A finding that changed the shape of the fix

While implementing it, the location of the hazard turned out to be narrower
than the issue assumed, and that matters for anyone reading this issue later:

`src/worker-runtime.js` already does `worker.executeTask(dequeued).catch(…)`,
and `WorkerHandle.executeTask` is `async` and returns `task.promise`. The async
adoption therefore attaches a rejection handler to `task.promise` **as soon as
the task reaches a worker**. So:

- a task that **fails inside the worker** was already protected — the keep-alive
  changes nothing for it;
- a task **rejected while still queued** is the genuinely unhandled case, and
  it is the issue-008 scenario: `shutdown()` → `queue.destroy()` →
  `task.reject(reason)` for every queued task, with nobody holding the promise.

The same shape applies to a task aborted before it reached a worker.

The tests therefore target the **queued** rejection, not the in-worker failure.
This is also why the first draft of the test suite was vacuous — it asserted on
an in-worker failure, which was protected before and after the fix. See
"Non-vacuity" below.

## Verification

All numbers are measured, not estimated.

| Check | Result |
| --- | --- |
| `npm test` (suite attributable to this change) | **631 pass / 0 fail**, 173 suites — the 624-test baseline plus the 7 new tests (171 → 173 suites) |
| `npm test` (whole tree, including a parallel unrelated test file from another change) | **641 pass / 0 fail**, 175 suites |
| `npm run lint` | 0 errors, 105 files |
| `npm run format:check` | 0 errors, 105 files |
| `npm run skill:validate` | **PASSED** — 35 JavaScript blocks, **0 syntax-error**, **0 runtime-error**, 0 timeout; executed 5, skipped 4, fragment 22, external-dependency 4 |
| `npm run benchmark:hot-path` / `npm run validate` | **not run** — deliberately skipped (another agent was running the suite in parallel; the hot-path benchmark has a CPU-load-sensitive p99 budget). The central agent runs the full `validate` alone at the end. |

### New test file

`test/dispatch-promise-contract.test.js` — 7 tests, 2 suites:

1. a fire-and-forget `dispatch()` rejected **while queued** raises **no**
   unhandled rejection (in-process, `process.on('unhandledRejection')`);
2. `await handle.promise` still rejects with the **same error instance** that
   `onError` received;
3. `onError` still fires, exactly once, with the task error;
4. a task that fails **inside the worker** still reports through `onError` and
   `handle.promise`;
5. `dispatchAll()` inherits the fire-and-forget protection;
6. a **child process** that dispatches a task and then calls `shutdown()` exits
   with code **0** — the issue-008 scenario, verbatim;
7. a **child process** that calls `execute()` without `await`/`.catch()` exits
   with a **non-zero** code — the ADR-0018 hazard is preserved.

Tests 6 and 7 are child processes on purpose: in-process, the test runner's own
`unhandledRejection` listener would turn the hazard into a test failure instead
of an assertion.

### Non-vacuity (the tests fail when the fix is removed)

With `if (keepAlive)` temporarily forced to `if (keepAlive && false)`, the
suite was re-run and **4 of the 7 tests failed**:

- the in-process test observed the unhandled rejection
  (`UNHANDLED_COUNT 1 — ["Task aborted before execution"]`);
- the `dispatchAll()` test failed;
- the child process exited **1** with
  `WorkerRuntimeError: Runtime is shutting down` instead of 0.

The keep-alive was restored afterwards. The three tests that still passed are
the ones that assert the *unchanged* behaviour (the promise still rejects,
`onError` still fires, `execute()` still crashes) — they are supposed to pass
in both states.

### Measured exit codes of the child scripts (manual run, outside the suite)

| Script | Keep-alive ON | Keep-alive OFF |
| --- | --- | --- |
| `dispatch()` + `shutdown()` (queued rejection) | exit **0** | exit **1** (`WorkerRuntimeError: Runtime is shutting down`) |
| `execute()` without `await`/`.catch()` | exit **1** (`Error: pwr-child-boom`) | exit **1** (unchanged — by design) |
| `dispatch()` whose task fails **inside** the worker | exit **0** | exit **0** (unchanged — already protected by `executeTask`'s adoption) |
