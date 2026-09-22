# ADR-0015: Promise Rejection Contract for TaskQueue Waiters

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: correctness, task-queue, contracts, async-resource, unhandled-rejection

## Context and Problem Statement

The `TaskQueue` class exposes a public `enqueue(task)` method that returns a Promise. The Promise is expected to resolve when the task is admitted to the bounded queue (or space frees up), and reject when the queue cannot accommodate the task in time (timeout) or when the runtime is shutting down.

Internally, when the queue is full, `enqueue()` parks the task in a `waiters` array and arms a timeout timer. Each entry holds a `resolve` callback that promotes the task into the queue. When the queue is destroyed or when `drainWaiters()` skips a settled task, the runtime must settle every waiter's Promise — otherwise callers awaiting `enqueue()` are left hanging, and the eventual timer firing produces an `unhandledRejection` event.

Two contract violations surfaced when dedicated unit tests were added for the queue:

1. **`destroy(reason)` rejected the task via `task.reject(reason)` but never rejected the waiter's enqueue Promise.** Callers awaiting `enqueue()` on a waiter parked at destroy time would hang forever, and the timer would eventually fire and produce an `unhandledRejection`.
2. **`#drainWaiters()` skipped settled tasks (via `shift()` + continue) without clearing their timer or rejecting their enqueue Promise.** The orphaned timer kept running and ultimately produced an `unhandledRejection` on a Promise nobody was listening to.

Both violations were silent — they did not produce test failures because the integration test suite did not exercise "destroy with waiters parked" or "settle a waiter mid-wait" directly.

## Decision Drivers

- The Promise returned by `enqueue()` must always settle — success (admitted), timeout (`TaskQueueTimeoutError`), or destroy (caller-supplied reason). Callers must never see a hung Promise or an `unhandledRejection`.
- Settled tasks whose waiters were skipped during drain must be cleaned up deterministically — their timers cleared and their Promises rejected with a descriptive error.
- The `TaskQueue` class must remain pure JavaScript ESM with zero external dependencies; no third-party Promise wrappers.
- The fix must be detectable by tests at the unit level (no flaky integration-only paths).

## Considered Options

- **Option 1: Leave the existing behavior; document that `enqueue()` may hang and recommend callers attach `.catch()` defensively.** Punt the contract to the caller. Pushes complexity outward and is silently violated by every internal call site that does not attach `.catch()` (the test harness itself caught it only because `node --test` aborts on unhandled rejections).

- **Option 2: Reject the enqueue Promise via a new `waitEntry.reject(err)` callback stored alongside `resolve`, and call it from `destroy()` and from the `isSettled` branch in `#drainWaiters()`.** Augment the waiter entry with the reject handle so the runtime can settle the Promise in every code path that disposes of the waiter.

- **Option 3: Replace the manually-managed waiters array with a third-party Promise queue library (e.g. `p-queue`).** Adds an external dependency; violates the zero-dependency principle and ADR-0001.

## Decision Outcome

Chosen option: **"Option 2: Reject the enqueue Promise via a new `waitEntry.reject(err)` callback"**, because it enforces the contract at the source, requires zero new dependencies, and is verifiable by deterministic unit tests.

### Contract (now enforced)

Every `enqueue(task)` Promise MUST settle exactly once, in one of:

| Outcome | When | Rejection Reason |
|---|---|---|
| Resolve | Task admitted to queue, or a slot freed via `dequeue()` | — |
| Timeout | `queueTimeoutMs` (queue default or per-task override) elapses | `TaskQueueTimeoutError` with `taskId`, `waitedMs`, `queueDepth` |
| Destroy | `destroy(reason)` called | The supplied `reason` (defaults to `Error('TaskQueue was destroyed')`) |
| Abandoned | `drainWaiters()` skips because task settled upstream (e.g. `AbortSignal` cancelled) | `Error('Task was settled before queue capacity was available')` |

### Mechanic

```js
// src/task-queue.js
return new Promise((resolve, reject) => {
  const waitEntry = {
    task,
    timer: null,
    resolve: () => {
      if (waitEntry.timer) clearTimeout(waitEntry.timer);
      this.#insert(task);
      resolve();
    },
    reject: (err) => {
      if (waitEntry.timer) clearTimeout(waitEntry.timer);
      reject(err);
    },
  };

  waitEntry.timer = setTimeout(() => { /* ... */ }, timeoutMs);
  this.#waiters.push(waitEntry);
});
```

`destroy()` and `#drainWaiters()` now both call `waiter.reject(reason)` (in addition to `waiter.task.reject(reason)`), ensuring the enqueue Promise settles deterministically.

### Positive Consequences

- No `unhandledRejection` events from the queue, even when the runtime is shut down while many tasks are in flight.
- Callers may `await enqueue()` and rely on the Promise settling — no need for defensive `.catch()` everywhere.
- The contract is testable at the unit level (`test/task-queue.test.js` exercises all four settle paths).
- TaskQueue coverage rose from 65% to 100% as a side effect of writing the dedicated tests that surfaced the violations.

### Negative Consequences

- The waiter entry now stores two callbacks instead of one (a few extra bytes per waiter; negligible).
- Existing integration tests that relied on the implicit abandonment behavior (none in this repo) would need to be updated to expect the rejection.
- The "abandoned waiter" error message is intentionally generic; future debugging may need to correlate the rejection timestamp with `task.id` to find the source.

## Pros and Cons of the Options

### Option 2 ✅ Chosen

- ✅ Enforces the contract at the source.
- ✅ Zero new dependencies.
- ✅ Fully covered by deterministic unit tests.
- ❌ Adds one callback per waiter entry.

### Option 1

- ✅ Smallest patch.
- ❌ Pushes correctness burden onto every caller.
- ❌ The `node --test` runner aborts on unhandled rejections, so the contract violation was already a CI hazard.

### Option 3

- ✅ Battle-tested third-party implementation.
- ❌ Violates the zero-dependency principle (ADR-0001).
- ❌ Hides the contract behind an external API the team must learn.

## Verification

- 19 dedicated unit tests in `test/task-queue.test.js`, covering: enqueue happy path, waiters path, timeout path, settled-task no-op; dequeue priority ordering, affinity match, affinity mismatch fallback, dedicated-worker filter, settled-task skip, affinity-index cleanup; waiter drain one-promotion-per-slot and skip-settled semantics; destroy with custom reason, default reason, and waiter cleanup.
- `npm run test:coverage` reports `task-queue.js` at **100% line / 100% branch / 100% function** coverage.
- `npm test` passes 149/149; no `unhandledRejection` warnings emitted by the suite.

## Links

- Related: [ADR-0001: Zero External Dependencies](0001-zero-external-runtime-dependencies.md)
- Related: [ADR-0002: Event Loop Coordination Model](0002-event-loop-coordination-model.md)
- Implementation: `src/task-queue.js` (lines 39–73 for `waitEntry`, 144–167 for `destroy`, 169–188 for `#drainWaiters`)
- Tests: `test/task-queue.test.js`
