# Issue 001: supervisor.start() is not idempotent (pool duplicates)

**Severity:** medium
**Found by:** exploratory `test/_bug-hunt.test.js` (Phase 2 — bug-hunt)
**Date:** 2026-09-21
**Component:** `src/supervisor.js`

## Symptom

Calling `supervisor.start()` twice on the same instance spawns a
second batch of workers, doubling the pool size. Observed: `2 → 4`.

## Repro

```js
import { Supervisor } from './src/index.js';

const s = new Supervisor({ workers: 2 });
await s.start();
console.log(s.totalWorkers); // 2
await s.start();
console.log(s.totalWorkers); // 4 (!)
await s.shutdown();
```

## Root cause

`src/supervisor.js:111`:

```js
async start() {
  this.#isShuttingDown = false;
  const spawnPromises = [];
  for (let i = 0; i < this.#targetWorkers; i++) {
    spawnPromises.push(this.#spawnWorker());
  }
  await Promise.all(spawnPromises);
}
```

No guard against double-start. `#isShuttingDown` is reset (so
re-starting after shutdown works — that's intentional), but there's
no `#isStarted` flag to short-circuit a redundant start.

## Impact

- Tests that call `start()` defensively (or that accidentally double-call)
  silently double the pool. Worker count grows unboundedly.
- `WorkerRuntime.constructor()` calls `supervisor.start()` once. Safe
  today because `createWorkerRuntime` is the only public path. But
  direct `Supervisor` consumers can hit this.
- The existing `supervisor-units.test.js` covers basic start/shutdown
  but not double-start — gap in coverage.

## Proposed fix

Add `#isStarted = false` to the Supervisor state. Short-circuit at the
top of `start()`:

```js
async start() {
  if (this.#isStarted) return;
  if (this.#isShuttingDown) {
    throw new Error('Cannot start: supervisor is shutting down');
  }
  this.#isStarted = true;
  // ... rest of start logic
}
```

Reset `#isStarted = false` in `shutdown()` so post-shutdown restart
works again (consistent with current `#isShuttingDown` reset in
`start()`).

## Test plan

- Add `supervisor.start() called twice is idempotent` to
  `test/supervisor-units.test.js`.
- Should pass after fix (current behavior: pool doubles — FAILS).

## Tracking

- ID: `PWR-001` (or assign in project tracker)
- Spec impact: none — fix is to existing behavior
- Backward compat: if any consumer depends on double-start
  (unlikely), they need to handle the new throw/return.
- **Status: ✅ FIXED** in the bug-hunt commit. Added `#isStarted`
  flag + early-return guard in `start()`. Reset in `shutdown()` so
  post-shutdown restart still works. Regression test added in
  `test/supervisor-units.test.js` — passes after fix.
