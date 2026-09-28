# io-throughput benchmark: accounting assertion ignores preempted tasks

**Status**: ✅ **FIXED** (2026-09-27) — Phase 1 accounting now sums the `task:preempted` counter.

**Discovered**: 2026-09-27 while running the full `npm run benchmark:all` locally after fixing the
Windows CI failure (see `CI-FAILURE-windows-broadcast-fanout.md`).
**Component**: `benchmarks/io-throughput.benchmark.js`

## Symptom

`npm run benchmark:all` exits 1 on a **pre-existing** failure, unrelated to the broadcast-fanout
fix. It surfaced at the end of the suite:

```
Total tasks dispatched: 50.000
Total completed:        23.977
Total failed:           31.010 (expected ~2500 from injection)
Total preempted:        14 (expected 1 from mid-stream runaway)
FAIL: expected 50000 total accounted in Phase 1, got 49987 (completed=22617, failed=27370)
  VERDICT: FAILED.
```

`50000 - 49987 = 13` unaccounted. Reproduced twice:

| Run | Completed | Failed | Preempted | Accounted | Missing |
| --- | --- | --- | --- | --- | --- |
| 1 (via `benchmark:all`) | 18,313 | 31,679 | 9 | 49,992 | 8 |
| 2 (isolated) | 22,617 | 27,370 | 14 | 49,987 | 13 |

In both runs the shortfall is one less than the preempted count, which is the signature of the
root cause below.

## Root cause

The benchmark registers three event listeners and three counters:

```js
runtime.on('task:completed', () => { taskCompletedCount++; });
runtime.on('task:failed',    () => { taskFailedCount++; });
runtime.on('task:preempted', () => { taskPreemptedCount++; });
```

but the Phase 1 assertion only summed the first two:

```js
if (phase1CompletedCount + phase1FailedCount !== TOTAL_TASKS) { throw ... }
```

The third counter was tracked and printed in the summary but never added to the assertion, so every
preempted task was an accounting hole.

Why a preempted task lands in neither bucket: in `src/worker-runtime.js` the `task_preempted`
handler does

```js
this.#supervisor.on('task_preempted', (data) => {
  this.#stats.preemptedTasksCount++;
  this.#stats.failedTasks++;                 // counter is incremented...
  this.emit('task_preempted', data);
  this.emit('task:preempted', data);
  this.#scheduleNext();
});
```

It increments `stats.failedTasks` but emits **only** `task:preempted` — never `task:failed`. So a
preempted task is counted by neither `task:completed` nor `task:failed`, and the benchmark's
two-counter sum can never reach `TOTAL_TASKS` once the watchdog fires.

That `preemptedCount` exceeds the expected 1 is a separate observation: the runaway-task injection
plus memory-driven recycling appears to produce extra preemptions on Windows. It does not affect
the accounting fix, and the benchmark only warns (`⚠`) when `preemptedCount < 1`, so it is not a
gate.

## Why the runtime was NOT changed

The gap is arguably a runtime observability decision — should a preempted task also emit
`task:failed`? Changing the event surface would affect every consumer, is not covered by a test
(`grep 'task:preempted' test/` returns nothing), and has no ADR or spec requirement mandating it.
Per the project's "verify before formalizing" rule, there is no evidence the omission is a defect
rather than a deliberate distinction between "the task failed" and "the worker was killed under the
task". The benchmark is where the knowledge lives (it already tracks the counter and prints it), so
the fix belongs there. If the omission *is* in fact a defect, that is a separate change needing an
ADR plus test coverage.

## Resolution

A first attempt simply added `phase1PreemptedCount` to the sum. That over-corrected and produced
`got 50001` — **one more** than `TOTAL_TASKS`, with `preempted=11`. So both failure modes are real:

- **Under-count**: most preempted tasks emit only `task:preempted`, landing in neither
  `completed` nor `failed` (shortfall 8, then 13).
- **Over-count**: at least one preempted task *also* got its handle rejected, so it emitted
  `task:preempted` **and** `task:failed` for the same `taskId`.

That means counter arithmetic is wrong in both directions and no fixed three-term sum can be
correct. The fix measures the authoritative quantity instead — the number of **distinct `taskId`s**
observed in any terminal event:

```js
const terminalTaskIds = new Set();
runtime.on('task:completed', (data) => { taskCompletedCount++; terminalTaskIds.add(data.taskId); });
runtime.on('task:failed',    (data) => { taskFailedCount++;    terminalTaskIds.add(data.taskId); });
runtime.on('task:preempted', (data) => { taskPreemptedCount++; terminalTaskIds.add(data.taskId); });

// ... at Phase 1 close:
const phase1TerminalIds = new Set(terminalTaskIds);   // snapshot, so Phase 3 can't contaminate it
if (phase1TerminalIds.size !== TOTAL_TASKS) { throw new Error(...); }
```

All three event payloads carry `taskId` (see `TaskPreemptedEvent` in `src/index.d.ts`), so the Set
is exact. The per-bucket counters are still reported in the log for readability, but the gate
itself no longer depends on them. Comments at both sites explain why, so a future reader does not
"simplify" the assertion back to counter arithmetic.

### The third cause: Phase 1 dispatches one more task than `TOTAL_TASKS`

With the distinct-id Set in place the assertion still failed, now reporting `got 50001` for
`TOTAL_TASKS = 50000` — one *extra* rather than one missing. Phase 1 does not dispatch only the
sustained load. Mid-stream it injects a runaway task to exercise the watchdog:

```js
setTimeout(() => {
  if (preemptTriggered) return;
  preemptTriggered = true;
  logLine('>>> Mid-stream preemption trigger ... — dispatching runaway task');
  dispatchRunawayTask(runtime, echo.port)...
}, TOTAL_TASKS * PREEMPTION_TRIGGER_AT_FRACTION / TARGET_RATE_PER_SEC * 1000);
```

`dispatchRunawayTask` issues a real `runtime.dispatch({ type: 'runaway', fn: () => { while (true) {} } })`,
so it is a genuine dispatched task that legitimately reaches a terminal state (it gets preempted).
The expected total is therefore `TOTAL_TASKS + 1`, and the assertion now reads:

```js
const phase1Expected = TOTAL_TASKS + 1;  // +1 for the injected runaway task
if (phase1TerminalIds.size !== phase1Expected) { throw new Error(...); }
```

This also explains why the original assertion was doubly wrong: it ignored both the terminal
events it was missing and the task it was over-counting by.

The Phase 3 recovery assertion (`recoveryDone + recoveryFailed !== RECOVERY_TASKS`) was left
unchanged: those tasks are dispatched after the watchdog phase and are not subject to preemption.

## Prevention

- When asserting "every dispatched task reached a terminal state", count **distinct task ids**,
  not event counts. Terminal events are not mutually exclusive on this runtime: a preempted task
  may emit `task:preempted` alone or `task:preempted` + `task:failed` depending on whether its
  handle is rejected, so summing counters is wrong in both directions.
- Count **every** task the phase dispatches, including helper tasks injected for a side
  experiment. A watchdog-probe task dispatched mid-stream is a real dispatched task and belongs in
  the accounting, even though it is not part of the nominal load.
- Enumerate the buckets from the benchmark's own `runtime.on(...)` list. The events it registers
  are the authoritative set of terminal states — a counter that is tracked and printed but omitted
  from the assertions is a silent time bomb that only fires once the rare path actually runs.
- When an assertion is off by exactly ±1, suspect an extra injected task before suspecting the
  accounting. Here the sign flip from `-8` to `+1` was the clue.
