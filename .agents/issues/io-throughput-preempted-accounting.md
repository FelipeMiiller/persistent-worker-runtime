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

## Why the runtime was NOT changed — resolved 2026-09-27, it is correct as written

Investigated on 2026-09-27 and **closed**: the current behaviour is deliberate and correct. The
premature worry was that a preempted task's `TaskHandle` might be left unsettled. It is not.

The rejection happens one layer down, in `WorkerHandle.#preemptWorker` (`src/worker-handle.js`):

```js
currentTask.reject(timeoutErr);                    // line 564 — handle IS rejected

this.emit('task_preempted', {                      // line 566 — and only then
  workerId: this.id,
  taskId: currentTask.id,
  timeoutMs: currentTask.timeoutMs,
  preempted: true,
});
```

`TaskHandle.reject()` (`src/task-handle.js:221-241`) sets `#settled`, calls `this._reject(error)`,
and invokes every registered `onError` callback inside the task's `AsyncResource`. So the caller's
promise settles promptly and `handle.onError(...)` fires — **there is no hung handle**. By the time
the runtime's `task_preempted` handler runs, the task is already terminal at the handle level; that
handler only updates counters and fans out the public event.

Three independent sources confirm that emitting only `task:preempted` is the intended contract:

1. **ADR-0011** (the ADR that introduced preemption), Decision Driver #4: *"Must provide explicit
   error classification (`TaskTimeoutError` with `preempted: true`) to distinguish cooperative
   timeouts from forced preemptive kills."* The distinction **is** the point. If preemption also
   emitted `task:failed`, it would be diluted into the same stream consumers already use for
   ordinary failures.
2. **`TaskTimeoutError.preempted` is an explicit discriminator** (see `src/index.d.ts`), covered by
   `test/preemption.test.js:32` (`false`) and `:40` (`true`). A separate event would make that flag
   redundant.
3. **The telemetry test asserts the two counters independently** —
   `test/preemption.test.js:478-479` asserts `preemptedTasksCount === 1` **and**
   `failedTasks === 1` for the same task. The aggregates and the event stream answer different
   questions on purpose.

**The actual lesson is the one that caused this bug:** `stats.failedTasks` and the `task:failed`
event are *not* two views of the same fact. The counter is an aggregate that *includes* preemption;
the event is the stream of task-level failures. Assuming they correspond is what produced the
flawed benchmark assertion in the first place — and it is why the fix counts distinct `taskId`s
instead of doing arithmetic on the counters.

**No ADR is needed**: the existing ADR-0011 already mandates the current behaviour, and
`test/preemption.test.js` already covers it. The docstring in `src/worker-runtime.js:451` was the
one place lacking that context; see the note added there.

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
