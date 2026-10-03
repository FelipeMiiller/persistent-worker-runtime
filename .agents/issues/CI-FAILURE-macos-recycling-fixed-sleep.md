# CI: recycling test flakes on Node 24 / macos-latest (fixed sleeps)

**Status**: ✅ **FIXED** (2026-10-03) — fixed sleeps replaced with deadline-based polling.

**Discovered**: 2026-10-03, CI run [`37069227658`](https://github.com/FelipeMiiller/persistent-worker-runtime/actions/runs/37069227658).
**Component**: `test/recycling.test.js`, `test/recycle-backoff.test.js`

## Symptom

`Run Unit Tests` failed on one matrix leg only:

```
✖ recycles worker when maxTasksPerWorker is reached and preserves pool capacity (358ms)
  AssertionError [ERR_ASSERTION]: At least one worker must be recycled
    at test/recycling.test.js:401
ℹ tests 622   ℹ pass 621   ℹ fail 1
```

`Run Unit Tests` passing everywhere else, and the benchmarks step never ran.

## Root cause: a fixed sleep standing in for an event

The test dispatched 4 tasks to exhaust `maxTasksPerWorker: 2`, then slept a hard-coded 200 ms
and asserted:

```js
await new Promise((resolve) => setTimeout(resolve, 200));
assert.ok(recycledEvents.length >= 1, 'At least one worker must be recycled');
```

`worker_recycling` (the trigger) fires synchronously with task completion and had already
arrived. `worker_recycled` is emitted only after the **replacement thread has spawned and
booted**, and that is routinely slower than 200 ms on a loaded macOS runner. The assertion was
therefore a statement about the runner's speed, not about the recycling behaviour.

`test/recycle-backoff.test.js` carried the same anti-pattern with the history written into its
comments — the constants had already been raised once:

```
// Bump to 200 ms to absorb CI timer noise on Windows Node 22
// (slower worker startup than Linux/macOS — the 50 ms window was
// too tight and caused Windows Node 22 to flake on this test).
```

Raising the number again would only move the cliff to a slower machine.

## Fix

Poll for the settled state with a deadline, returning as soon as it holds:

```js
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}
```

Applied to five sites: the `maxTasksPerWorker` recycle, the `maxMemoryMb` recycle, and the three
mid-backoff observations in `recycle-backoff.test.js`.

### The first attempt polled a partial condition and broke three tests

Worth recording, because it is the easy mistake:

```js
await waitFor(() => runtime.getWorkers().length === 2);   // ← too early
```

The replacement worker is in status `starting` the moment the pool reaches 2, not `idle`. The
test then asserted `one of the workers should be in idle status` and raced its own setup —
3 failures, reproducibly, on all three runs. The predicate must express the **complete**
condition the assertions will check:

```js
await waitFor(() => {
  const ws = runtime.getWorkers();
  return ws.length === 2 && ws.some((w) => w.status === 'recycling') && ws.some((w) => w.status === 'idle');
});
```

### And the second attempt reintroduced it in a subtler shape

Waiting on `recycledEvents` and then asserting `runtime.stats.totalWorkers === 2` still raced:
`worker_recycled` is emitted when the **replacement spawns**, and the **old worker is removed
afterwards**. Between the two the pool transiently holds N+1. CI run `37114512380` (Coverage
workflow) caught it as `3 !== 2`.

The lesson generalises past this file: **the wait must cover every condition the assertions
touch, including ones that become true slightly after the event.** A worker replacement is a
two-phase transition, and a predicate that only watches the first phase will hand the assertion
a transient state.

```js
while (
  (recycledEvents.length === 0 || runtime.stats.totalWorkers !== 2) &&
  Date.now() < deadline
) { /* poll */ }
```

Applied to both recycling tests that assert on pool size.

## Verification

- `recycling.test.js` + `recycle-backoff.test.js`: 42/42 across **six** consecutive runs.
- Full suite: 622/622, 0 fail, 0 skipped.

## Prevention

- **Never assert on an event that a fixed sleep is standing in for.** Poll the condition, with a
  deadline that expresses the real requirement ("this must happen within 5 s"), not a guess
  about the slowest machine.
- **Poll the same predicate the assertions will use, and cover every condition they touch.** A
  worker replacement is a two-phase transition (spawn, then remove); watching only the first
  phase hands the assertion a transient N+1 pool. Both partial-predicate failures above came
  from this.
- When a test's sleep constant has been raised before, that is evidence the design is wrong, not
  that the constant is too small. Two such comments existed in this file already.
- Negative waits ("wait long enough that no spurious event fires") are a different shape and are
  fine as fixed sleeps — they assert the *absence* of an event over a window, which has no
  completion signal to poll on. `recycling.test.js:506` is intentionally left as a fixed 500 ms.
