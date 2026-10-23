# ADR-0025: Fire-and-Forget `dispatch()` Promise Contract — Keep-Alive Handler on the Task Handle

- **Date**: 2026-10-23
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: async-correctness, promise-contract, dispatch, fire-and-forget, unhandled-rejection, runtime-api

## Context and Problem Statement

`runtime.dispatch()` is the runtime's explicit fire-and-forget API: it returns a
`TaskHandle` immediately and the caller is not expected to await anything. The
JSDoc on `dispatch()` promised that the handle's promise was *already* handled:

> - `.promise` (already `.catch()`-handled internally by the handle, so
>   unhandled-rejection warnings do not fire on legitimate cleanup)

`docs/adr/0018-fire-and-forget-hazard-with-execute-and-post-shutdown-flakes.md`
(§Architectural Mechanics) made the same claim and **built its accepted
decision on it**:

> - If you intentionally want fire-and-forget semantics, use `dispatch()` …
>   `.promise` (which has `.catch()` attached internally by the handle).

and stated that *"the hazard is already eliminated by `dispatch()` existing"*.

**The promise was false.** `src/task-handle.js` contains zero `.catch(`
occurrences — the promise is created in the constructor and handed to the
caller untouched. The only `.catch()` inside `dispatch()` was on the
*enqueue* promise, not on the handle's promise.

The consequence is not academic. `runtime.shutdown()` calls
`this.#queue.destroy(new WorkerRuntimeError('Runtime is shutting down'))`, and
`TaskQueue.destroy()` rejects every task still sitting in the queue
(`src/task-queue.js`: `task.reject(reason)` for each waiter and each queued
task). The rejected `handle.promise` has no handler, so Node raises an
unhandled rejection and **the user's process exits 1**. A user who follows the
shipped documentation ("safe, no unhandled-rejection warnings") and calls
`shutdown()` gets a crashed process.

The skill's own recommended outbox pattern does not save you either: `onError`
registers a *callback*, and a callback is not a rejection handler. The shipped
`references/observability.md` called `onComplete`/`onError` "the recommended
way to implement transactional outbox" without mentioning the promise at all.

### Where the hazard actually lives

The runtime already performs `worker.executeTask(dequeued).catch(…)`
(`src/worker-runtime.js`), and `WorkerHandle.executeTask` is `async` and
returns `task.promise`. The async adoption attaches a rejection handler to
`task.promise` **as soon as the task reaches a worker**. Consequently:

- a task that **fails inside the worker** is already protected by the runtime's
  own wiring — the keep-alive changes nothing for it;
- a task that is **rejected while still queued** has nobody holding its
  promise — this is the genuinely unhandled window, and it is exactly the
  issue-008 failure (`shutdown()` → `queue.destroy()`).

The same shape applies to a task aborted before it ever reached a worker: the
`TaskHandle` constructor rejects it synchronously, while it is still queued.

### Why this needs an ADR

Fixing the contract by attaching an internal handler is a **behaviour change**
on a published API: a rejection that currently surfaces as an unhandled
rejection would stop doing so. ADR-0018 explicitly rejected that shape for
`execute()` (its Option 1: *"masks genuine bugs"*) — but it said nothing about
`dispatch()`, whose entire purpose is fire-and-forget. The repo's rule is that
every lifecycle or concurrency-pattern change gets a MADR record.

## Decision Drivers

- **`dispatch()` must be genuinely fire-and-forget.** The API's headline
  ergonomics is that the caller may discard the handle. A footgun that kills
  the process on `shutdown()` makes the API a lie.
- **`execute()`'s hazard must stay visible.** ADR-0018 (Option 3) chose to
  *document* the `execute()` hazard rather than absorb it, because a worker
  crash during a legitimately-awaited `execute()` is a fatal condition the
  caller should observe. This ADR must not undo that decision by accident.
- **The failure must stay observable.** The keep-alive must not swallow the
  error: `await handle.promise` must still throw, and `onError` must still
  fire. ADR-0018's rejection of Option 1 applies with full force.
- **No API surface growth.** No new method, no new option, no new exported
  symbol (ADR-0003 and ADR-0018 both declined aliases).
- **Zero external dependencies, pure vanilla JS** (ADR-0005).

## Considered Options

- **Option A — attach a keep-alive handler inside `dispatch()`** (this ADR).
  The handle's promise gets a no-op `.catch()` so a discarded handle cannot
  raise an unhandled rejection. The promise still rejects; `onError` still
  fires. `execute()` is explicitly excluded.
- **Option B — make the documentation tell the truth.** Correct the JSDoc,
  amend ADR-0018, and require the caller to handle `handle.promise` — including
  in the outbox pattern. No behaviour change.
- **Option C — no-op the rejection entirely** (swallow it). Never let the
  promise reject. This is ADR-0018's rejected Option 1.
- **Option D — attach the keep-alive inside `TaskHandle` itself**, so every
  handle is protected regardless of who created it.

## Decision Outcome

Chosen option: **Option A — attach a keep-alive handler inside `dispatch()`**.

The keep-alive is attached in the runtime, not in `TaskHandle`, and it is
attached **only** on the `dispatch()` path. `execute()` keeps the ADR-0018
hazard exactly as it was.

### Why not Option B

Option B is honest but leaves every user of the runtime's headline
fire-and-forget API one unhandled rejection away from a crashed process, for a
failure mode (`shutdown()` rejecting queued tasks) that is **normal
operation**, not a bug in the user's code. The runtime knows a task was
dispatched and is not awaited; absorbing that specific case is not "masking a
genuine bug" — it is completing the API's contract. The documentation fix is
still made (the JSDoc and ADR-0018 are corrected by this ADR), but it is not
the whole fix.

### Why not Option C

Option C is ADR-0018's rejected Option 1: it removes the error from the
promise as well as from the unhandled-rejection report, so `await
handle.promise` would resolve with `undefined` on failure. A caller who
awaits a dispatched task and gets a silent `undefined` has no way to
distinguish success from failure. Option A keeps the rejection reachable.

### Why not Option D

`TaskHandle` is a public export, and it is also created by paths that are not
`dispatch()` — `WorkerHandle.executeDirectTask` creates handles for internal
protocol tasks (`__ping__`, `__clear_state__`), and the SQLite queue backend
keeps its own `Map<task_id, TaskHandle>`. Making the constructor responsible
for the contract would silently change the promise semantics of every one of
those handles, including handles that no user ever sees. The contract in
question is `dispatch()`'s, so the runtime attaches the handler where the
contract is published.

### Architectural Mechanics

#### 1. `execute()` and `dispatch()` split over a shared private method

Both public methods now delegate to a private
`#dispatchTask(taskDefinition, { keepAlive })`:

```js
async execute(taskDefinition) {
  const handle = this.#dispatchTask(taskDefinition, { keepAlive: false });
  return handle.promise;
}

dispatch(taskDefinition) {
  return this.#dispatchTask(taskDefinition, { keepAlive: true });
}
```

The `keepAlive` flag is the whole decision: it decides **who owns the
rejection**.

- `keepAlive: true` (`dispatch()`) — a no-op rejection handler is attached to
  the handle's promise:

  ```js
  if (keepAlive) {
    task.promise.catch(() => {
      // Intentionally empty: the rejection stays reachable through the
      // promise itself and through the handle's `onError` callbacks.
    });
  }
  ```

- `keepAlive: false` (`execute()`) — no handler is attached. The caller owns
  the promise and must await it or attach `.catch()`, exactly as ADR-0018
  requires.

Note that `execute()` is `async` and returns `handle.promise`, so the async
wrapper *adopts* the promise. The rejection is therefore re-surfaced by the
wrapper — which is a **different** promise object — and it is the wrapper that
goes unhandled when the caller ignores it. This was verified empirically
rather than by reading: an async function returning a promise that already has
a `.catch()` attached still produces an unhandled rejection, because the
wrapper's promise is the one left unhandled.

The distinction is nevertheless made explicit in code rather than left to a
promise-adoption side effect, so that `execute()`'s rejection path is
byte-identical to its pre-ADR behaviour and the intent is readable.

#### 2. What the keep-alive does and does not do

| | before ADR-0025 | after ADR-0025 |
| --- | --- | --- |
| `dispatch()` — promise rejects | yes | yes (unchanged) |
| `dispatch()` — `await handle.promise` throws | yes | yes (unchanged) |
| `dispatch()` — `onError` fires | yes | yes (unchanged) |
| `dispatch()` — discarded handle raises an unhandled rejection | **yes** | **no** |
| `execute()` — discarded promise raises an unhandled rejection | yes | yes (unchanged, by design) |

The keep-alive marks the rejection as *observed*. It does not swallow it: the
promise still rejects, and the error is still delivered to `onError`. For
fire-and-forget users, **`onError` is the failure channel**.

#### 3. `dispatchAll()`

`dispatchAll()` maps over `dispatch()`, so every handle it returns inherits the
protection. No change was needed there.

## Pros and Cons of the Options

### Option A ✅ Chosen

- ✅ The published contract becomes true — code and documentation agree.
- ✅ `dispatch()` is genuinely fire-and-forget: a discarded handle cannot kill
  the process.
- ✅ Nothing is masked: the promise still rejects and `onError` still fires.
- ✅ ADR-0018's `execute()` decision is preserved by construction, not by
  accident.
- ✅ No API surface growth; no new exported symbol; no new dependency.
- ✅ The contract is now covered by executable tests, not by a paragraph.
- ❌ It is a behaviour change: a rejection that used to surface as an unhandled
  rejection no longer does. Users who relied on the process dying to notice a
  failed background task must move to `onError` (or `await handle.promise`).
  This is the price of the contract being true, and it is documented in the
  shipped skill.
- ❌ `execute()` and `dispatch()` now behave differently w.r.t. unhandled
  rejections. That asymmetry is intentional and is now documented on both
  methods.

### Option B

- ✅ No behaviour change at all.
- ✅ The documentation stops lying.
- ❌ Every user of the runtime's headline fire-and-forget API keeps the
  footgun for a failure that is normal operation (`shutdown()`).
- ❌ The outbox pattern in the shipped skill would have to grow a `.catch()` on
  every handle — the opposite of "fire-and-forget".

### Option C

- ✅ Callers can never trigger an unhandled rejection.
- ❌ **Silently swallows real worker crashes** — ADR-0018's rejected Option 1.
- ❌ `await handle.promise` would resolve with `undefined` on failure.
- ❌ Violates the promise-rejection contract of ADR-0015.

### Option D

- ✅ One place to reason about the contract.
- ❌ Changes the promise semantics of every `TaskHandle`, including internal
  ones the user never sees.
- ❌ `TaskHandle` is a public export; the constructor's behaviour would become
  part of the contract for a class that is also used outside `dispatch()`.

## Verification

The contract is asserted by `test/dispatch-promise-contract.test.js` (7 tests,
2 suites):

1. a fire-and-forget `dispatch()` rejected **while queued** raises **no**
   unhandled rejection (in-process, `process.on('unhandledRejection')`);
2. `await handle.promise` still rejects with the **same error instance** that
   `onError` received;
3. `onError` still fires, exactly once, with the task error;
4. a task that fails **inside the worker** still reports through `onError` and
   `handle.promise`;
5. `dispatchAll()` inherits the protection;
6. a **child process** that dispatches a task and then calls `shutdown()` exits
   with code **0** (the issue-008 scenario, verbatim);
7. a **child process** that calls `execute()` without `await`/`.catch()` exits
   with a **non-zero** code — the ADR-0018 hazard is preserved.

The `execute()` hazard (test 7) and the `dispatch()` protection (test 6) are
asserted in child processes on purpose: in-process, the test runner's own
`unhandledRejection` listener would turn the hazard into a test failure.

**Non-vacuity was verified by removing the keep-alive.** With
`if (keepAlive)` temporarily forced to `if (keepAlive && false)`, tests 1, 3, 5
and 6 fail (the in-process test observes the unhandled rejection; the child
process exits 1 with `WorkerRuntimeError: Runtime is shutting down`). The
keep-alive was restored afterwards.

Full suite at acceptance: **631/631 tests pass, 0 fail** — the 624-test baseline
plus this ADR's 7 new tests (171 suites → 173).
`npm run lint` and `npm run format:check` report 0 errors (105 files), and
`npm run skill:validate` passes with **35 JavaScript blocks, 0 syntax-error,
0 runtime-error, 0 timeout**.

## Follow-ups

1. Consider extending the skill gate (`scripts/validate-skill.js`) with a case
   that asserts a fire-and-forget `dispatch()` **does not** produce an
   unhandled rejection — the gate currently only catches the symptom (a
   crashing snippet), not the contract.
2. Consider a grep-based audit for `runtime.execute(` without a following
   `await`/`.catch()` in the repo's own sources — the follow-up ADR-0018
   proposed but never implemented.
3. `src/index.d.ts` declares `TaskHandle.promise` as `Promise<any>`; it
   carries no note about the rejection contract. The TypeScript definitions
   have no compile gate at all (issue 005), so this is deferred to that issue.

## Links

- Issue: `.agents/issues/008-taskhandle-promise-contract-mismatch.md` (the
  original evidence and the Option A / Option B analysis).
- Amended: [ADR-0018](0018-fire-and-forget-hazard-with-execute-and-post-shutdown-flakes.md)
  — the fire-and-forget hazard analysis this ADR completes.
- Related ADRs:
  - [ADR-0003](0003-dual-execution-model-execute-and-dispatch.md) — defines
    `execute` vs `dispatch` and why both exist.
  - [ADR-0015](0015-promise-rejection-contract-for-task-queue-waiters.md) —
    defines the rejection contract this ADR preserves.
  - [ADR-0005](0005-native-javascript-esm-with-zero-external-dependencies.md) —
    pure vanilla JS, zero external dependencies.
- Implementation: `src/worker-runtime.js` — `execute()`, `dispatch()` and the
  new private `#dispatchTask(taskDefinition, { keepAlive })`.
- Tests: `test/dispatch-promise-contract.test.js`.
