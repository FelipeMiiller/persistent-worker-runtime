# Gotchas Catalog — persistent-worker-runtime

18 gotchas documented here. Each entry was a real bug caught by a test, a real CI flake, or a real silent-no-op. When you add a new one, follow the format below.

**Format:** `### <short-name>` → symptom → root cause → fix pattern → citation.

---

## Memory & measurement

### 1. `process.memoryUsage().heapUsed` excludes off-heap allocations

**Symptom:** a benchmark dispatches 50,000 tasks that each call `randomBytes(10_000)`. The test asserts `heapUsed > X MB` after the run. **The assertion fails** even though memory clearly grew.

**Root cause:** V8 heap (`heapUsed`) excludes `external` and `arrayBuffers`. `Buffer` instances from `randomBytes()` are backed by ArrayBuffers — they live in `external`, not `heapUsed`. The runtime's recycling threshold checks `heapUsed`, so a benchmark with only Buffers triggers **zero recyclings**.

**Fix:** force allocations into `heapUsed` by using **unique-content strings** (V8 string-internalization dedups identical strings, so each task must have unique bytes) or **plain objects**:

```js
// ❌ WRONG — off-heap, doesn't grow heapUsed
const buf = require('node:crypto').randomBytes(10_000);
return { len: buf.length };

// ✅ RIGHT — unique-content string grows heapUsed
const unique = String.fromCharCode(...Array.from({ length: 200 }, (_, i) => i + seed));
return { len: unique.length };
```

If you need to assert off-heap growth, check `external` directly: `memoryUsage().external > X`.

**Citation:** benchmarks/io-throughput.benchmark.js doc-block (2026-09-20); lesson captured in agent memory.

---

### 2. V8 deduplicates identical strings via string-internalization table

**Symptom:** a benchmark dispatches 50,000 tasks, each of which stores `'a'.repeat(10_000)`. The test asserts `heapUsed > 50 MB` after the run. **The assertion fails** by orders of magnitude.

**Root cause:** V8 string-internalization (also called "string deduplication" in some writeups) keeps a single copy of identical strings. 50,000 tasks with the same string = 1 allocation.

**Fix:** make each task's payload unique. The simplest: prepend a per-task seed:

```js
const seed = taskId; // unique per dispatch
const s = String.fromCharCode(seed & 0xFFFF, (seed >> 16) & 0xFFFF) + 'x'.repeat(10_000);
```

For larger payloads, generate a deterministic but unique sequence: `crypto.createHash('sha256').update(String(seed)).digest('base64')` — different per task, cheap to compute.

**Citation:** agent memory entry "setImmediate chain saturates main thread..." (2026-09-19, context: T10-B + io-throughput rewrite).

---

## Async & lifecycle

### 3. Async activity after test end = CI flake (Node test runner + worker_threads)

**Symptom:** a test that returns synchronously after calling `runtime.execute(...)` (without `await`) passes on Linux CI but flakes on macOS with:

```
Test "..." generated asynchronous activity after the test ended.
This activity created the error "WorkerCrashError: Worker ... crashed
with exit code 1 while running task ..." and would have caused the
test to fail, but instead triggered an unhandledRejection event.
```

**Root cause:** `runtime.execute()` returns a Promise. The worker starts the task but doesn't finish before the test function returns. The next test (or `after` hook calling `runtime.shutdown()`) terminates the worker mid-task. WorkerCrashError rejects asynchronously, AFTER the test framework already marked the test as ended. macOS is slower than Linux, widening the window.

**Fix:** mark the test function `async` and `await` every `execute()`/worker-dispatch before any sync assertions or test return. Fire-and-forget is acceptable ONLY when the test deliberately relies on the after hook's shutdown to terminate the task — and even then it can flake.

```js
// ❌ BAD
it('measures latency', () => {
  runtime.execute({ fn: work });
  const t0 = Date.now();
  runtime.broadcast('ch', msg);
  assert.ok(Date.now() - t0 < 50);
});

// ✅ GOOD
it('measures latency', async () => {
  await runtime.execute({ fn: work });
  const t0 = Date.now();
  runtime.broadcast('ch', msg);
  assert.ok(Date.now() - t0 < 50);
});
```

**Citation:** agent memory entry "Async activity after test end = CI flake..." (2026-09-17, fix commit `7acdfe6`).

---

### 4. Watchdog requires `timeoutMs > 0` — default 0 is silent no-op

**Symptom:** a user creates a runtime with `forceKillOnTimeout: true` to kill runaway tasks. They dispatch a `while(true){}` task expecting `worker:preempted`. **The worker runs forever**, the event never fires, and the runtime never recovers.

**Root cause:** `task-handle.js` reads `options.timeoutMs || 0`. When `timeoutMs === 0`, the watchdog timer is **never armed** (the `setTimeout` block in `markStarted()` is gated by `if (this.timeoutMs > 0 && !this.forceKillOnTimeout)` — note the `&&` is wrong, it should be `||`, but even fixing that wouldn't help because the **default is 0**, not Infinity). With `timeoutMs: 0` the user is opting out of preemption entirely.

**Fix (post-ADR-0024, applied in T1):** default `timeoutMs` to `5000` when undefined. Preserve explicit `0` as opt-out. Add a one-shot warning when `forceKillOnTimeout && timeoutMs === 0`:

```js
// post-fix
this.timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
if (this.forceKillOnTimeout && this.timeoutMs === 0 && !__hardenTimeoutWarningEmitted) {
  console.warn('[hardening] TaskHandle created with forceKillOnTimeout=true but timeoutMs=0 — preemption will NOT fire. ...');
  __hardenTimeoutWarningEmitted = true;
}
```

**When writing tests** that exercise preemption, **always pass an explicit `timeoutMs`** — never rely on the default:

```js
// ✅
const handle = runtime.dispatch({ fn: runaway, timeoutMs: 1000, forceKillOnTimeout: true });

// ❌ — silently no-op if default is 0
const handle = runtime.dispatch({ fn: runaway, forceKillOnTimeout: true });
```

**Citation:** ADR-0024 A1 (HARDEN-01); fix planned for `src/task-handle.js` line 22.

---

### 5. `runtime.shutdown()` after pending watchdog → `unhandledRejection`

**Symptom:** a test calls `runtime.shutdown()` while a task is mid-execution with a watchdog armed. The test passes, but afterwards:

```
(node:12345) UnhandledPromiseRejection: TaskTimeoutError: Task ... exceeded execution timeout ...
```

**Root cause:** the watchdog `setTimeout` fires after `shutdown()` has settled the task with a different error (e.g. `WorkerRuntimeError`). The first rejection has no `.catch` handler attached.

**Fix:** tests that shutdown mid-watchdog must attach a `.catch` to the watchdog timer OR await `runtime.shutdown()` BEFORE the watchdog would fire. See test/preemption.test.js T8 (PREEMPT-08) for the regression test.

**Citation:** adaptive-concurrency completion-checklist — "PREEMPT-08 (hard-preemption) — shutdown during pending watchdog → no unhandledRejection. Code path structurally prevents it; needs dedicated test (~10 lines)."

---

### 6. `new Function(fnCode)` loses module scope (worker fn dispatch)

**Symptom:** a task function uses `const crypto = require('node:crypto')` at the top of its file. When dispatched to a worker, the task fails with `ReferenceError: crypto is not defined`.

**Root cause:** `worker-thread-entry.js` reconstructs the user fn via `new Function('payload', 'state', 'context', fnCode)`. The reconstructed fn has access to globals but **NOT** to module-level variables (`require`, `import`, closure over the calling module).

**Fix:** inside the fn, use `await import('node:crypto')` dynamically. This works because the worker's runtime is the same Node.js that has the module loader available. For built-in modules (`node:net`, `node:crypto`, etc.) this is reliable.

```js
// ❌ WRONG — module-level reference lost
const crypto = require('node:crypto');
async function fn() { return crypto.randomBytes(10); }

// ✅ RIGHT — dynamic import inside fn
async function fn() {
  const crypto = await import('node:crypto');
  return crypto.randomBytes(10);
}
```

**Future fix (ADR-0024 HARDEN-02):** the runtime will pass an `fnDeps` manifest from dispatch payload to worker, capturing built-in modules via closure. Until then, dynamic import is the workaround.

**Citation:** ADR-0024 A2 (HARDEN-02); bug first observed in benchmarks/io-throughput.benchmark.js doc-block.

---

## Sizing & configuration

### 7. `PersistentWorkerRuntimeDefaultSizing` warning fires on >4-core hosts

**Symptom:** every test that boots a runtime without `workers: N` emits a `process.emitWarning('PersistentWorkerRuntimeDefaultSizing: ...')`. CI runs with 28 cores → warning fires. `npm test` output is noisy.

**Root cause:** `resolveAdaptiveEnabled` returns `true` when no opt-out is set. The warning logic in `createWorkerRuntime` checks `isDefaultSizing()` and `availableParallelism() > 4`.

**Fix in tests:** pass any of: `workers: N`, `concurrency: 'auto'`, or set `WORKER_CONCURRENCY` env var. **Do NOT silence the warning** — it's a real diagnostic. Suppress noise with explicit sizing:

```js
// ✅
const runtime = createWorkerRuntime({ workers: 4 });
// or
const runtime = createWorkerRuntime({ concurrency: 'auto' });
// or (in CI setup)
process.env.WORKER_CONCURRENCY = '4';
```

**Citation:** ADR-0019; worker-pool-sizing.test.js shows the pattern.

---

### 8. `resolveWorkerCount()` order is `options.workers` → `WORKER_CONCURRENCY` → `concurrency: 'auto'` → `1`

**Symptom:** a user sets `WORKER_CONCURRENCY=auto` and `concurrency: 'auto'`, expecting both to apply. The runtime boots with `1` worker. The user thinks `WORKER_CONCURRENCY` is being ignored.

**Root cause:** the order is `options.workers` first (only set when numeric). Then `WORKER_CONCURRENCY` env (if set, including `'auto'`). Then `concurrency: 'auto'` if no env. Then `1` fallback. `concurrency: 'auto'` IS redundant when `WORKER_CONCURRENCY=auto` is set — env wins.

**Fix in tests:** when asserting sizing behavior, set ONE input at a time. Tests in `test/worker-pool-sizing.test.js` cover all 4 cases.

```js
// ✅
// Explicit `workers: N` wins over everything
delete process.env.WORKER_CONCURRENCY;
const r1 = createWorkerRuntime({ workers: 2 });
assert.equal(r1.stats.totalWorkers, 2);

// Env wins over `concurrency: 'auto'`
process.env.WORKER_CONCURRENCY = '4';
const r2 = createWorkerRuntime({ concurrency: 'auto' });
assert.equal(r2.stats.totalWorkers, 4);
```

**Citation:** ADR-0023.

---

## Stats & telemetry

### 9. `runtime.stats.X` is a live reference, not a snapshot

**Symptom:** a test reads `runtime.stats.adaptive.effectiveWorkers`, awaits some setup, then asserts. The assertion sometimes sees a value from a tick that fired during the await.

**Root cause:** `runtime.stats` is a getter that returns the same underlying object the controller mutates. Ticks advance `effectiveWorkers`, `ticksSinceResize`, etc. **even while your test is awaiting**.

**Fix:** destructure into local vars **synchronously** after the read:

```js
// ❌ BAD
const stats = runtime.stats;
await sleep(100);
assert.equal(stats.adaptive.effectiveWorkers, 5);  // could be 4, 5, or 6

// ✅ GOOD
const { effectiveWorkers } = runtime.stats.adaptive;
await sleep(100);
assert.equal(effectiveWorkers, 5);  // number was captured into local var
```

For deeper inspection, snapshot all fields at once:

```js
const snap = { ...runtime.stats.adaptive };
await sleep(100);
// inspect `snap` — fields are copies
```

**Citation:** T10-E lesson captured in agent memory (2026-09-20); fix in T10-E commit `3f28bf8`.

---

### 10. Units in telemetry matter — `latencyP99Ms` was returning nanoseconds

**Symptom:** the controller compares `stats.adaptive.latencyP99Ms > 50` (50 ms threshold). The comparison never fires because the value is **50,000,000** (50 seconds in ns).

**Root cause:** `SignalMonitor.sample()` returned the raw hrtime value in nanoseconds. The contract was "milliseconds" but the implementation didn't convert.

**Fix:** always write a test that **explicitly fails** if the unit changes. The pattern:

```js
// ✅
it('latencyP99Ms is in milliseconds, not nanoseconds', () => {
  const sample = monitor.sample();
  // A typical p99 in ms is < 1000. If we ever return ns, this is > 1e6.
  assert.ok(sample.latencyP99 < 1000, `latencyP99=${sample.latencyP99} likely in ns, not ms`);
});
```

**Citation:** fix commit `c829bb1` (SignalMonitor.sample() returns ms not ns); lesson captured in agent memory.

---

### 11. Controller can be stuck in `'noop'` — pair shape with action

**Symptom:** a test asserts `effectiveWorkers === 8` after a grow burst. The test passes. But the controller never actually fired — `effectiveWorkers` was 8 from a previous resize that the controller didn't undo.

**Root cause:** `effectiveWorkers` reflects the LAST resize, not whether a resize happened during the test window. A controller stuck in `'noop'` (e.g. due to an off-by-one threshold bug) leaves it at the previous value.

**Fix:** always pair the size assertion with the action + timestamp:

```js
const startTime = Date.now();
await growBurst();
const { effectiveWorkers, lastResizeReason, lastResizeAt } = runtime.stats.adaptive;
assert.equal(effectiveWorkers, 8);
assert.equal(lastResizeReason, 'grow');
assert.ok(lastResizeAt >= startTime, 'lastResizeAt must reflect a resize during this test');
```

**Citation:** agent memory entry "Asserting `effectiveWorkers === N` alone doesn't catch..."

---

### 12. Two-snapshot pattern for "is counter alive"

**Symptom:** `assert.ok(ticksSinceResize > 0)` passes after a resize. But the counter might be stuck at the post-resize value, never incrementing. A follow-up tick test fails mysteriously.

**Root cause:** `> 0` proves the field exists and was incremented **at least once** (during the resize). It doesn't prove the counter is monotonically incrementing on tick.

**Fix:** two snapshots, separated by a known interval, with `second > first`:

```js
const before = runtime.stats.adaptive.ticksSinceResize;
await sleep(200);  // longer than tick cadence (default 1000ms? check! samplingCadenceMs)
const after = runtime.stats.adaptive.ticksSinceResize;
assert.ok(after > before, `expected ticksSinceResize to increment; before=${before} after=${after}`);
```

**Citation:** T10-E fix (2026-09-20, commit `3f28bf8`).

---

## Controller signal sampling

### 13. `setImmediate` chain saturates main thread — controller sees wrong signal

**Symptom:** a test wants the controller to fire `grow` (main thread idle, workers busy). The test uses `setImmediate(recurse)` to keep dispatching work. Controller fires `shrink` instead.

**Root cause:** `setImmediate` callbacks fire back-to-back with no I/O blocking. The main thread is ~95% busy in dispatch overhead. `performance.eventLoopUtilization` reports high ELU. The controller interprets this as "main thread busy" → fires `shrink`.

**Fix:** synchronous burst + idle wait:

```js
// ❌ BAD
function dispatchTick() {
  if (!running) return;
  for (let i = 0; i < 5; i++) runtime.dispatch({ fn: work });
  setImmediate(dispatchTick);
}
setImmediate(dispatchTick);

// ✅ GOOD
for (let i = 0; i < 2000; i++) runtime.dispatch({ fn: work });
await sleep(7000);  // main thread idle, controller samples real "idle" signal
```

For a continuous workload that doesn't saturate, use `setTimeout(fn, 1500)` + small batch.

**Citation:** agent memory entry "setImmediate chain saturates main thread..." (2026-09-19, T10-B commit `2b88635`).

---

## Streaming edge cases

### 14. Empty generator with return value → zero chunks + MSG_STREAM_END

**Symptom:** `runtime.stream({ fn: function*() { return 'done'; } })` — test expects one chunk with `'done'`. The stream ends without emitting anything.

**Root cause:** a generator function with no `yield` and only a `return` value emits zero chunks. The return value is propagated via `MSG_STREAM_END.returnValue`, NOT as a chunk.

**Fix in tests:** assert both behaviors:

```js
// ✅
const stream = runtime.stream({ fn: function*() { return 'done'; } });
const chunks = [];
for await (const chunk of stream) chunks.push(chunk);
assert.equal(chunks.length, 0);
assert.equal(stream.stats.returnValue, 'done');
```

**Citation:** streaming-edge-cases.test.js.

---

### 15. Consumer break + external abort at same time → only one wins

**Symptom:** a test calls `for (const chunk of stream) { break; }` and `stream.signal.abort()` simultaneously. The test expects `done` once but the stream stays open.

**Root cause:** the stream's `return()` (from break) and the abort signal both call `pushEnd` / `abortStream`. Whichever fires first wins; the second is a no-op. Tests that await "both" forever hang.

**Fix in tests:** use `Promise.race([onReturn, onAbort])` or test each path separately:

```js
// ✅ — test break only
const stream = runtime.stream({ fn: longGenerator });
const it = stream[Symbol.asyncIterator]();
await it.next();
await it.return();  // explicit return, not break
assert.equal(stream.stats.endReceived, true);

// ✅ — test abort only
const ac = new AbortController();
const stream = runtime.stream({ fn: longGenerator, signal: ac.signal });
ac.abort();
assert.equal(stream.stats.aborted, true);
```

**Citation:** streaming-edge-cases.test.js (cancellation races).

---

## Recycling & memory pressure

### 16. Worker at maxTasksPerWorker → recycling fires

**Symptom:** test boots runtime with `maxTasksPerWorker: 10`, dispatches 100 tasks. Only 80 complete; 20 never finish. Test fails.

**Root cause:** the supervisor recycles each worker after `maxTasksPerWorker` tasks. Recycling takes ~100 ms. Tasks dispatched while the worker is recycling wait in the queue. The test's `await Promise.all` resolves only when all tasks complete — but the queue is **bounded**.

**Fix in tests:**

- Use `runtime.executeAllSettled([...])` instead of `Promise.all` — it returns one entry per task, including rejections.
- Increase the queue size: `runtime.dispatch({ ..., maxQueueSize: 1000 })`.
- Reduce `maxTasksPerWorker` for tests where you want recycling to fire mid-flight (assert it fires, not assert all tasks complete).

```js
// ✅
const results = await runtime.executeAllSettled(
  Array.from({ length: 100 }, (_, i) => ({ fn: work, payload: i, maxQueueSize: 1000 })),
);
assert.equal(results.length, 100);
assert.ok(results.every((r) => r.status === 'fulfilled' || r.status === 'rejected'));
```

**Citation:** recycling.test.js (T4 stress test).

---

### 17. Shutdown while tasks in flight → no `unhandledRejection`

**Symptom:** test calls `runtime.shutdown()` mid-stream. `process.on('unhandledRejection', ...)` fires for in-flight tasks.

**Root cause:** tasks in flight when shutdown is called get rejected with `WorkerRuntimeError`. If the test doesn't attach `.catch` to each task handle, the rejection is unhandled.

**Fix in tests:** attach `.catch(() => {})` to each in-flight handle before shutdown, OR await `runtime.shutdown()` and check that it completes without unhandled rejections:

```js
// ✅
const handles = Array.from({ length: 10 }, () => runtime.dispatch({ fn: longWork }));
// Attach no-op catch to all handles BEFORE shutdown
handles.forEach((h) => h.promise.catch(() => {}));
await runtime.shutdown();
// No unhandled rejections expected
```

Alternatively, install a one-time unhandledRejection listener at the top of the test:

```js
const unhandled = [];
process.once('unhandledRejection', (r) => unhandled.push(r));
// ... test body
assert.equal(unhandled.length, 0, `unhandled rejections: ${unhandled.map((e) => e.message).join(', ')}`);
```

**Citation:** streaming-edge-cases.test.js (shutdown semantics).

---

## Event-driven tests

### 18. Ad-hoc counter misses "event fired twice" bugs

**Symptom:** a test asserts `counter === 1` after dispatching a task. The test passes. In production, the same code path emits `task:completed` twice — once from the worker's success branch and once from a cleanup hook. The duplicate emission causes memory accumulation in production listeners.

**Root cause:** ad-hoc counters (`let counter = 0; event.on(() => counter++); assert.equal(counter, 1)`) read the counter at the moment the assertion runs. If the event fires again 5 ms later — after the assert — the counter increments but no one notices. The test passes. Production fails.

A second root cause: `if (counter > 0) assert.ok(...)` style — passes even when counter is 0 if the line is never reached, and doesn't distinguish 1 from 2.

**Fix:** use `common.mustCall(fn, exact=N)` from `test/common.js` (Node-pattern lifted from `nodejs/node`). The wrapped callback tracks its call count and asserts on `process.exit`. If `exact !== actual` at exit, the test FAILS.

```js
// ❌ WRONG — counter can be off by one if event fires again post-assert
let completedCount = 0;
runtime.on('task:completed', () => { completedCount++; });
await runtime.dispatch({ fn: work });
await sleep(50);
assert.equal(completedCount, 1);  // passes even if a late event fires 10ms later

// ✅ RIGHT — mustCall(1) asserts exactly 1 call at process.exit
runtime.on('task:completed', common.mustCall((event) => {
  assert.equal(event.taskId, 'task-1');
}, 1));
await runtime.dispatch({ fn: work, taskId: 'task-1' });
// process.exit will fail if task:completed fires 0 OR 2+ times.
```

**For "at least N" cases** (e.g., retry loops, multi-worker recycling), use `common.mustCallAtLeast(fn, min=1)`.

**For "should NEVER fire" cases** (lifecycle post-shutdown), use `common.mustNotCall(msg)`.

**When to adopt:**
- Any test that wraps an event handler with `() => { counter++; }` — replace with `common.mustCall(fn, N)`.
- Any test that uses `assert.ok(counter > 0)` — replace with `common.mustCallAtLeast(fn, 1)`.
- Any test for "should not happen" — use `common.mustNotCall(msg)`.

**Adoption priority:** HIGH. This pattern catches a class of bugs that ad-hoc counters never will.

**Citation:** Node-pattern lesson #1 (2026-09-20); helper in `test/common.js`.

---

## Adding new gotchas

When you discover a new one:

1. **Write the regression test first** — must fail without the fix.
2. **Add the entry here** with: symptom, root cause, fix pattern, citation (commit hash / issue ID).
3. **Update `SKILL.md`** if the pattern generalizes to other Node projects with `worker_threads`.

Resist speculative entries. Wait for empirical evidence.
