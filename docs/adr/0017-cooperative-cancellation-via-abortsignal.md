# ADR-0017: Cooperative Cancellation via Standard `AbortSignal`

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: cancellation, abort-signal, web-standards, cooperative, http

## Context and Problem Statement

Long-running tasks (LLM token generation, image processing, multi-step workflows) must be cancellable from outside the worker thread without forking the runtime or writing custom IPC plumbing. Common call sites that need to cancel work:

- HTTP request cancelled by the client (browser tab close, navigation, request abort).
- User-initiated cancel in a UI ("Stop" button on a long export).
- Watchdog timeout via `AbortSignal.timeout(ms)` for slow downstream calls.
- Cascade cancellation when a parent request aborts (e.g. gRPC deadline propagation).

In all cases, the cancellation MUST be:
1. **Cooperative** — the user code inside the worker chooses when to honor it (no surprise kills mid-allocation).
2. **Standard** — uses the web-standard `AbortSignal` API so callers do not learn a new contract.
3. **Late-bound** — works whether the signal fires before or during execution.
4. **Observable** — surfaces as a typed error (`TaskAbortedError`) carrying the signal's reason.

The runtime already supports cooperative timeout (ADR-0011 §P2 grace window) and hard preemption for runaway loops. Neither covers general-purpose cancellation from arbitrary call sites.

## Decision Drivers

- Reuse the web-standard `AbortSignal` API; do not invent a new cancellation contract.
- Cancellation MUST be cooperative — the worker function decides when to check the signal — never a forced thread kill (that's ADR-0011).
- A signal that fires before dispatch MUST reject the task immediately, without entering the queue or consuming a worker slot.
- A signal that fires during execution MUST propagate to the worker via `signal.dispatchEvent(new Event('abort'))` so user code can `await` async resources that observe the signal.
- Surface as a typed `TaskAbortedError` carrying the `reason` from the abort event.
- Zero new dependencies.

## Considered Options

- **Option 1: Custom `cancelToken` API** — invents a new contract; breaks interop with existing HTTP/UI code that already uses `AbortSignal`.
- **Option 2: Forcefully terminate the worker thread on cancel** — wastes CPU, kills unrelated work in the same worker, violates the "cooperative" principle; that is ADR-0011 territory.
- **Option 3: Standard `AbortSignal` propagation through the task options, surfaced as `TaskAbortedError`** — reuses the web platform, propagates abort events into the worker via the existing IPC channel, distinguishes from timeout/preempt errors.

## Decision Outcome

Chosen option: **"Option 3: Standard `AbortSignal` propagation, surfaced as `TaskAbortedError`"**, because the web-standard API is already in every browser, every Node.js HTTP library, and every UI framework. Callers can wire HTTP request cancellation through directly with zero translation.

### Architectural Mechanics

1. **Signal Attachment**
   - Every `TaskHandle` accepts an optional `signal` field at construction: `new TaskHandle({ signal: controller.signal, ... })`.
   - The signal is stored on the handle (`src/task-handle.js:24`).
   - When supplied, an `abort` listener is attached (`src/task-handle.js:68`) that rejects the task with `TaskAbortedError` if the signal fires before/during execution.

2. **Pre-Dispatch Cancellation**
   - When a task is dequeued for execution, the runtime checks `task.signal?.aborted` (`src/task-handle.js:60-66`).
   - If already aborted, the task rejects with `TaskAbortedError` without ever invoking the worker function. No worker slot is consumed.

3. **In-Flight Propagation**
   - The existing worker IPC already carries the signal in the task payload.
   - When the supervisor-side signal listener fires while a task is running, the runtime dispatches a synthetic `abort` event into the worker thread via the message port (`src/task-handle.js:253-255`).
   - User code can observe via `signal.addEventListener('abort', ...)` or by passing the signal to fetch/AbortSignal-aware APIs.

4. **Listener Cleanup**
   - The abort listener is detached when the task settles (success, error, timeout, preempt, or aborted) (`src/task-handle.js:183-184`) to prevent leaks.

5. **Distinction from Other Errors**
   - `TaskAbortedError` carries the signal's `reason` and is a sibling of `TaskTimeoutError` (ADR-0011), `TaskQueueTimeoutError` (ADR-0004), and `WorkerRuntimeError`.
   - Callers can branch on `err instanceof TaskAbortedError` to distinguish user-initiated cancel from system-initiated timeout.

### Positive Consequences

- Zero new API surface — callers use the standard `AbortSignal` they already know.
- HTTP request cancellation flows directly: `fetch(req, { signal })` aborts in the same call site as `runtime.execute({ signal })`.
- Watchdog timeouts use `AbortSignal.timeout(ms)` — no new `timeoutSignal` constructor.
- UI cancel buttons just call `controller.abort()` — no integration glue.
- Clean separation from hard preemption (ADR-0011) — cooperative cancellation never terminates a worker thread.

### Negative Consequences

- Cooperative cancellation cannot stop a runaway sync loop (`while(true) {}`); that case still requires ADR-0011 hard preemption. Documented in the example `examples/cancel-on-disconnect.js`.
- If user code never checks the signal, an in-flight cancellation request is silently ignored — caller responsibility to integrate `signal` into long-running loops.
- Aborting a task in the waiter pool rejects the queue admission promise (per ADR-0015 contract) with `Error('Task was settled before queue capacity was available')`.

## Pros and Cons of the Options

### Option 3 ✅ Chosen

- ✅ Web-standard API, zero learning curve.
- ✅ Late-bound — works pre-dispatch and in-flight.
- ✅ Clean distinction from timeout/preempt errors.
- ❌ Cooperative only — cannot stop runaway sync loops (delegated to ADR-0011).
- ❌ Requires user code to integrate `signal` for in-flight cancel to be observable.

### Option 1

- ✅ Custom contract can be tailored to runtime semantics.
- ❌ Every HTTP/UI integration needs a translation layer.
- ❌ Long-term maintenance burden — diverges from web standards.

### Option 2

- ✅ Guaranteed to stop any task regardless of user code.
- ❌ Wastes CPU and kills unrelated work sharing the worker.
- ❌ Cannot be used for selective cancellation (e.g. "cancel this request but keep the worker alive").

## Verification

- Unit tests at `test/cancel-signal.test.js` covering: pre-dispatch abort, in-flight abort, AbortSignal.timeout watchdog, signal listener cleanup on success/error/timeout, idempotent abort.
- Benchmark `benchmarks/abort-cancellation.benchmark.js` measures 1,064 cancels/sec bulk throughput and end-to-end cancellation latency.
- Example `examples/cancel-on-disconnect.js` demonstrates manual abort, timeout abort, and listener cleanup in 95 lines.
- README §8 documents the pattern with a fetch-style snippet.

## Links

- Related: [ADR-0011: Hard Preemption and Thread Termination](0011-hard-preemption-and-timeout-termination-for-runaway-tasks.md) — the hard-kill sibling for runaway sync loops that ignore cancellation.
- Related: [ADR-0004: Asynchronous Queue Backpressure with Timeout](0004-asynchronous-queue-backpressure-with-timeout.md) — provides the queue contract that settled-on-abort tasks interact with.
- Related: [ADR-0015: Promise Rejection Contract for TaskQueue Waiters](0015-promise-rejection-contract-for-task-queue-waiters.md) — explains why aborted tasks still settle their waiter Promises.
- Implementation: `src/task-handle.js` (signal storage at line 24, listener at line 68, pre-dispatch check at lines 60-66, in-flight dispatch at lines 253-255, cleanup at lines 183-184).
- Tests: `test/cancel-signal.test.js`; benchmark `benchmarks/abort-cancellation.benchmark.js`; example `examples/cancel-on-disconnect.js`.
