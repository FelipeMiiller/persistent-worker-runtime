# CI: `benchmark:all` fails on Node 22.x / windows-latest (broadcast-fanout unhandled rejection)

**Status**: ✅ **FIXED** (2026-09-27) — root cause was an unhandled `TaskHandle` rejection in `benchmarks/broadcast-fanout.benchmark.js`, not a platform quirk.

**Discovered**: 2026-09-27 while auditing CI state on `develop` (the failure had been sitting red since 2026-09-25).
**Run**: [`36178398974`](https://github.com/FelipeMiiller/persistent-worker-runtime/actions/runs/36178398974) — `develop` push, 2026-09-25T19:13:55Z.
**Component**: `benchmarks/broadcast-fanout.benchmark.js`

## Symptom

The `CI` job failed after 14 minutes. `Run Unit Tests` passed cleanly (**621/621, 0 fail**).
The failing step was `Run Full Concurrency & Performance Benchmarks`, and the process exited 1:

```
WorkerRuntimeError: Runtime is shutting down
  code: 'ERR_WORKER_RUNTIME'
    at runBenchmark (benchmarks/broadcast-fanout.benchmark.js:104:12)
##[error]Process completed with exit code 1.
```

## Why it looked platform-specific but wasn't

Only one matrix leg failed:

| Job | Conclusion |
| --- | --- |
| Test on Node 22.x (ubuntu-latest) | success |
| **Test on Node 22.x (windows-latest)** | **failure** |
| Test on Node 22.x (macos-latest) | success |
| Test on Node 24.x (windows-latest) | success |
| Test on Node 24.x (macos-latest) | success |
| Test on Node 24.x (ubuntu-latest) | success |

Node 24 on Windows passed and Node 22 on Windows failed, which strongly suggested a timing
sensitivity rather than a logic bug. It was — but the bug is real, and the timing merely decides
whether it reproduces.

## Root cause

`benchmarks/broadcast-fanout.benchmark.js` test 2 dispatches **2000 fire-and-forget tasks**
(500 cycles x 4 workers) into a pool of 4, and never retained the returned `TaskHandle`s:

```js
// before
for (let i = 0; i < dispatchIterations; i++) {
  for (let w = 0; w < 4; w++) {
    r2.dispatch({ type: 'invalidate', ... });   // handle discarded
  }
}
// ...
await new Promise((r) => setTimeout(r, 200));  // fixed sleep
await r2.shutdown();
```

Two defects compound:

1. **Unhandled rejections.** `dispatch()` returns a `TaskHandle`; its `.promise` is discarded, so
   nothing observes a rejection. When `shutdown()` runs, it calls
   `this.#queue.destroy(new WorkerRuntimeError('Runtime is shutting down'))`, which rejects every
   still-queued task. Those rejections are unhandled and Node terminates the process (exit 1).
2. **A fixed sleep is not a drain.** 200ms was assumed sufficient for 2000 tasks on 4 workers. The
   inline comment even claimed the tasks "settle immediately so shutdown drains cleanly" — they do
   not. On windows-latest / Node 22 the drain had not finished, so `shutdown()` raced the queue.
   The 200ms sleep also made the benchmark's own wall-clock cost non-deterministic.

The other benchmarks that fire many tasks are not affected: `priority-routing.benchmark.js`
collects handles and does `await Promise.all(allPromises)` before `shutdown()`, and
`adaptive-concurrency.benchmark.js` wraps shutdown in `try/finally`. `broadcast-fanout` was the
only one discarding handles behind a sleep.

## Resolution

```js
// after
const pending = [];
for (let i = 0; i < dispatchIterations; i++) {
  for (let w = 0; w < 4; w++) {
    pending.push(r2.dispatch({ type: 'invalidate', ... }).promise);
  }
}
const dispatchDuration = performance.now() - dispatchStart;   // timing loop unchanged
// ...
await Promise.allSettled(pending);   // real drain, not a sleep
await r2.shutdown();
```

- Handles are retained so no rejection can escape.
- `Promise.allSettled` waits for genuine completion, removing both the race and the
  non-deterministic sleep. It cannot reject, so it is safe where `Promise.all` was not.
- The measured dispatch loop is untouched, so the reported microsecond figures are unaffected.

Verified locally: `node benchmarks/broadcast-fanout.benchmark.js` exits 0.

## Prevention

- A benchmark that calls `runtime.dispatch()` in a hot loop must either retain the handles and
  await them, or attach `.catch()` immediately. Discarding a `TaskHandle` behind a `setTimeout`
  is the same class of bug as an unhandled promise rejection in application code.
- Never use a fixed `setTimeout` to "let tasks drain" before `shutdown()`. Await the tasks.
- When a matrix leg fails on exactly one OS+Node combination, read the failing step's log before
  assuming a platform bug. Here the 14-minute duration and the exit-1 tail were the tells; the
  `ERR_WORKER_RUNTIME` at the benchmark's own `shutdown()` line pointed straight at it.
