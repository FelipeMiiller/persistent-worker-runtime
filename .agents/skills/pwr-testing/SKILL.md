---
name: pwr-testing
description: Write robust unit + integration tests for persistent-worker-runtime that catch regressions in obscure behaviors — live-reference stats, off-heap memory measurement, watchdog preemption, async-activity-after-test-end CI flakes, setImmediate chain traps, and silent no-op controllers. Use after every task completion (mandatory) and when designing new test suites. Triggers on "write tests", "add a test for", "test the watchdog", "measure memory", "test preemption", "validate stats", "live-mirror", "burst-then-idle", "P5/P1/P2 ordering", "new benchmark", "perf-test". For creating `examples/*.js` (not tests), load `.agents/skills/pwr-examples/SKILL.md` instead. Do NOT use for non-runtime Node projects. Test infrastructure (mustCall, mustNotCall, expectWarning) lives in test/common.js, lifted from nodejs/node test/common/. Always-on companion rule: `.agents/rules/perf-first-authoring.md` (examples/benchmarks/perf-tests must demonstrate the perf win with a measurable number — never trust "the API runs" alone).
license: MIT
metadata:
  author: Felipe Miiller
  version: 2.0.0
  applies-to: persistent-worker-runtime
---

# pwr-testing — Robust Test Authoring for Persistent Worker Runtime

Write tests for `persistent-worker-runtime` that **catch failures in obscure behaviors**, not just the happy path. Every gotcha documented below was discovered through a real CI flake, a real production regression, or a real silent-no-op bug. Treat the catalog as a checklist that grows over time — when a new gotcha is found, **add it to `references/gotchas.md` in the same commit that adds the regression test**.

This skill is **mandatory after every task**. The rule from `.agents/rules/end-of-spec-hardening.md` step 1 ("re-read the spec / ADR acceptance criteria") and step 2 ("predictive edge-case tests") are non-negotiable. The 4 mandatory commands below are the floor.

## When to load this skill

- Adding tests for a new public API (TDD red phase, or post-implementation green phase).
- Investigating a CI flake on macOS or Windows runners — async-activity-after-test-end is the most common cause.
- Designing benchmarks that need to drive the runtime into specific states (idle, busy, runaway).
- Debugging a "the test passes locally but fails in CI" symptom.
- Reviewing an existing test for hidden flakes.
- Replacing ad-hoc event counters with `common.mustCall(fn, exact)` to catch "fired twice" bugs.
- Asserting runtime warnings (e.g. `PersistentWorkerRuntimeDefaultSizing`) with `common.expectWarning`.
- **Creating a new example** — load `perf-first-authoring.md` companion to make sure the example justifies the perf feature it motivates.
- **Creating a new benchmark** — same as above; benchmarks exist to measure the perf win, not to time an empty loop.

## The 4 mandatory commands — run after every task

```bash
# 1. Lint (Biome) — must be 0 errors, 0 warnings
npm run lint

# 2. Full test suite — must pass with --test-concurrency=1
npm test

# 3. Full benchmark suite — must run without crashing
# (only mandatory if the task touched src/ or benchmarks/)
npm run benchmark:all

# 4. Spec structural gate (only if a tasks.md/spec.md was touched)
py .agents/skills/tlc-spec-driven/scripts/validate_tasks.py .specs/features/<feature>/tasks.md
py .agents/skills/tlc-spec-driven/scripts/validate_spec.py .specs/features/<feature>/spec.md
```

**Husky pre-commit hook runs (1) + (2) automatically. Do not bypass with `--no-verify`.** If (1) or (2) fails, fix the source — never weaken, skip, or delete tests.

## The 5 always-apply test patterns

Every test you write for this runtime must respect these patterns. Skipping one = CI flake.

### 1. Await every `runtime.execute(...)` / `dispatch(...)` before sync assertions

The runtime is backed by `worker_threads`. A fire-and-forget dispatch returns a Promise that completes asynchronously. If the test function returns before the worker finishes, the Node test runner reports:

```
Test "..." generated asynchronous activity after the test ended.
This activity created the error "WorkerCrashError: Worker ... crashed
with exit code 1 while running task ..." and would have caused the
test to fail, but instead triggered an unhandledRejection event.
```

This is **especially bad on macOS GitHub Actions** (slower than Linux). Linux runners pass; macOS flakes.

```js
// ❌ WRONG — fire-and-forget + sync test exit
it('measures latency', () => {
  runtime.execute({ fn: work });
  const t0 = Date.now();
  runtime.broadcast('ch', msg);
  assert.ok(Date.now() - t0 < 50);  // test returns sync, worker still busy
});

// ✅ RIGHT — wait for worker to settle before measuring
it('measures latency', async () => {
  await runtime.execute({ fn: work });  // worker done, idle
  const t0 = Date.now();
  runtime.broadcast('ch', msg);
  assert.ok(Date.now() - t0 < 50);
});
```

### 2. `runtime.stats` is a live reference, not a snapshot — capture before any await

`runtime.stats.X` returns an object whose fields are updated as the controller ticks. If you `await` between reading the field and asserting, a tick can mutate the value mid-assertion. **Always capture fields into local vars immediately after reading.**

```js
// ❌ WRONG — race between read and assert
const stats = runtime.stats;
await sleep(100);
assert.equal(stats.adaptive.ticksSinceResize, 5);  // tick fired between read + assert

// ✅ RIGHT — capture-then-await
const { ticksSinceResize } = runtime.stats.adaptive;  // captured synchronously
await sleep(100);  // OK to await now, local var is a copy of the number
assert.equal(ticksSinceResize, 5);
```

### 3. Prove a counter is "alive" with two snapshots, not just `> 0`

A field can be `0` either because the counter doesn't increment or because no tick has fired yet. Asserting `ticksSinceResize > 0` after a resize proves **existence**, not **increment**.

**Two-snapshot pattern** — capture the counter, wait a known interval, capture again, assert monotonic increment:

```js
// ✅ RIGHT — proves the counter is alive AND monotonically increments
const before = runtime.stats.adaptive.ticksSinceResize;
await sleep(200);  // known interval, longer than tick cadence
const after = runtime.stats.adaptive.ticksSinceResize;
assert.ok(after > before, `expected ticksSinceResize to increment; before=${before} after=${after}`);
```

This pattern caught more bugs than the `> 0` pattern. Use it whenever the field is a counter that should advance over time.

### 4. "Controller never fired" is silent — pair shape assertions with action assertions

Asserting `effectiveWorkers === N` after a grow burst is **necessary but insufficient**. A controller stuck in `'noop'` (e.g. because of an off-by-one threshold bug) can leave `effectiveWorkers` at the value from a previous resize and pass the shape assertion.

**Always pair the size assertion with the action assertion:**

```js
// ❌ WRONG — shape only, controller could be stuck in 'noop'
assert.equal(runtime.stats.adaptive.effectiveWorkers, 8);

// ✅ RIGHT — also asserts the controller actually fired grow
assert.equal(runtime.stats.adaptive.effectiveWorkers, 8);
assert.equal(runtime.stats.adaptive.lastResizeReason, 'grow');
assert.ok(runtime.stats.adaptive.lastResizeAt > startTime);
```

### 5. Burst-then-idle, not `setImmediate` chain, when driving the controller

When you need the controller to fire `grow`/`shrink` based on ELU / p99, the main thread must be **idle long enough** for the signal monitor to sample. A `setImmediate` chain fires back-to-back with no I/O blocking, saturating the main thread at ~95% busy — the controller sees `grow` even when you intend `shrink` (and vice-versa).

**Burst-then-idle pattern:**

```js
// ❌ WRONG — setImmediate chain saturates the main thread
function dispatchTick() {
  if (!running) return;
  for (let i = 0; i < 5; i++) runtime.dispatch({ fn: work });
  setImmediate(dispatchTick);
}
setImmediate(dispatchTick);  // main thread ~95% busy, controller sees wrong signal

// ✅ RIGHT — synchronous burst then idle settle window
for (let i = 0; i < 2000; i++) runtime.dispatch({ fn: work });
await sleep(7000);  // main thread idle, controller samples real "idle" signal
```

If you need a continuous workload without saturating, use `setTimeout(fn, 1500)` with a small batch — `setTimeout` has real delay, and a 50-dispatch batch is ~0.07% main-thread CPU.

## The 6 Node.js patterns to adopt

The Node.js core test suite (`nodejs/node` `test/parallel/`) has evolved a set of helpers over 10+ years that catch a class of bugs ad-hoc counter assertions miss. We adopted 6 of them — helpers live in `test/common.js` (translated from `nodejs/node` `test/common/index.js` to ESM, zero-deps). Use them in every test you write.

The bigger lesson: **test infrastructure is first-class**. Node invests years in `mustCall`, `expectWarning`, `leakedGlobals` because tests are the first defense against regression. Treat `test/common.js` with the same care as `src/index.js`.

### 1. `common.mustCall(fn, exact=N)` — replaces ad-hoc counters

`mustCall` wraps a callback so that on `process.exit`, an assertion fires if the callback was called ≠ exact times. Replaces `let counter = 0; event.on(() => counter++)` — which silently passes when the event fires 2x instead of 1x after the assert.

```js
import * as common from './common.js';

// ❌ WRONG — ad-hoc counter misses "fired twice" bugs
let counter = 0;
runtime.on('worker:recycled', () => { counter++; });
await growBurst();
assert.equal(counter, 1);  // passes even if recycling fires 2x after this

// ✅ RIGHT — mustCall catches "fired more than expected" on process.exit
runtime.on('worker:recycled', common.mustCall((event) => {
  assert.equal(event.workerId, expectedWorkerId);
}, 1));
await growBurst();
// process.exit will fail if 'worker:recycled' fires 0 OR 2+ times
```

Use `mustCallAtLeast(fn, min=1)` when "at least one" is the contract (e.g., retry loops).

### 2. `common.mustNotCall(msg)` — tests "should not happen" paths

Asserts the wrapped callback is **never** called. Use for lifecycle paths: "after `runtime.shutdown()`, `task:completed` should NOT fire". Without this, a worker that emits late events after shutdown leaks memory in production without any test catching it.

```js
runtime.on('task:completed', common.mustNotCall('task completed after shutdown'));
await runtime.shutdown();
await sleep(100);  // wait long enough for any rogue late event
// If task:completed fired, the test FAILS immediately with the message.
```

### 3. `common.expectWarning(name, message, code)` — process warnings are API

Every `process.emit('warning', ...)` is a public contract. Node tests assert the warning name, message regex, and code with `expectWarning`. We have `PersistentWorkerRuntimeDefaultSizing` but **no test asserts its shape** — renaming the message is currently silent.

```js
common.expectWarning(
  'PersistentWorkerRuntimeDefaultSizing',
  /started with default workers/,
  'ERR_PERSISTENT_WORKER_DEFAULT_SIZING',
);
const runtime = createWorkerRuntime();  // should emit the warning
// If the warning doesn't fire, OR fires with different message/code, the test FAILS.
```

### 4. `common.getArrayBufferViews(buf)` — tests ALL views, not one

When transferring an `ArrayBuffer`, every typed-array view pointing into it (`Uint8Array`, `Int32Array`, `DataView`, `BigInt64Array`, …) must be detached. The old test asserted `buf.byteLength === 0` (single view). A regression that detached only `Uint8Array` would slip through. The fix: pre-capture all views before transfer, then assert each view's `buffer.byteLength === 0` after.

```js
const buf = new ArrayBuffer(1024);
// Pre-capture views BEFORE runtime.execute() detaches buf.
const viewsBefore = common.getArrayBufferViews(buf);
for (const v of viewsBefore) {
  assert.equal(v.buffer.byteLength, 1024, 'pre-transfer view should be full');
}

await runtime.execute({ payload: { buffer: buf }, transferList: [buf] });

assert.equal(buf.byteLength, 0, 'sender buffer must be detached');
for (const v of viewsBefore) {
  // v.buffer.byteLength === 0 when detached; v.byteLength throws.
  assert.equal(v.buffer.byteLength, 0, `${v.constructor.name}'s ArrayBuffer must be detached`);
}
```

### 5. `common.platformTimeout(ms)` — slow-CI multiplier

Replaces fixed `await sleep(1500)` with `await sleep(common.platformTimeout(1500))`. Multiplies by 2 on debug builds, 4 on RISC-V 64, 2 on AIX/IBMi. Default CI (Linux + macOS + Windows x86) is unchanged.

The fix `daedaf6` bumped a Phase 2 wait from 1500→2500ms because Windows CI flaked. `platformTimeout` is the generalized version — every long-running test should use it.

```js
// ❌ WRONG — fixed timeout flakes on slow CI
await sleep(2500);

// ✅ RIGHT — scales with platform
await sleep(common.platformTimeout(1500));
```

### 6. `common.getLeakedGlobals()` + `common.allowGlobals(...)` — test isolation

Tests must not pollute `globalThis`. Workers, channels, `process.on('exit')` listeners can leak between tests if not cleaned up. Currently `--test-concurrency=1` masks this; switching to parallel tests would expose leaks. `getLeakedGlobals()` returns the unexpected globals at exit time.

Adopt as `process.on('exit', () => assert.equal(getLeakedGlobals().length, 0))` in a base test setup file. See **[references/node-patterns.md](references/node-patterns.md)** for full helper signatures + adoption roadmap.

## Quick checklist — paste into commit message or spec completion-checklist

```markdown
## Test coverage for <Task Tn>

**Always-apply patterns (5):**
- [ ] Each new public API has at least one happy-path test
- [ ] Each error path has a test (TypeError / RangeError / WorkerRuntimeError / etc.)
- [ ] `await`-before-sync-assertion pattern respected (no fire-and-forget)
- [ ] `runtime.stats` fields captured into local vars before any await
- [ ] Counter fields use two-snapshot, not `> 0` alone
- [ ] Controller fires proven via `lastResizeReason` + `lastResizeAt`, not just `effectiveWorkers`
- [ ] Burst-then-idle used when driving the controller

**Memory + sizing (3):**
- [ ] Off-heap allocations forced into `heapUsed` via unique-content strings (not Buffers)
- [ ] Watchdog default tested (no `timeoutMs: 0` silent no-op)
- [ ] Default sizing warning gated (`isDefaultSizing()` + env var or explicit `workers`)

**Node-pattern (6) — `test/common.js`:**
- [ ] Event handlers use `common.mustCall(fn, exact=N)`, not ad-hoc counters
- [ ] "Should not happen" paths use `common.mustNotCall(msg)`
- [ ] Process warnings asserted via `common.expectWarning(name, message, code)`
- [ ] ArrayBuffer transfers check ALL typed-array views via `common.getArrayBufferViews`
- [ ] Long-running tests use `common.platformTimeout(ms)` (not fixed values)
- [ ] Test isolation: no globals leaked (run `getLeakedGlobals()` if a test fails unexpectedly)

**Gates (mandatory):**
- [ ] `npm run lint` clean
- [ ] `npm test` clean (--test-concurrency=1)
- [ ] `py .agents/skills/tlc-spec-driven/scripts/validate_tasks.py` clean (if tasks.md touched)
- [ ] `py .agents/skills/tlc-spec-driven/scripts/validate_spec.py` clean (if spec.md touched)
- [ ] Cross-platform: at least one path validated on Windows + Linux + macOS (CI matrix)

**Perf-first (companion rule `.agents/rules/perf-first-authoring.md`):**
- [ ] Example / benchmark / perf-relevant test demonstrates the perf win with a measurable number
- [ ] Baseline present (sequential, with-copy, no-priority, no-cache, etc.) OR the artifact is explicitly marked `[correctness]` / `[api-surface]` in its header
- [ ] Numbers are in user units (ms saved, ops/sec, MB transferred cheaply) with hardware/config notes (workers / concurrency / HWM)
- [ ] `console.table` used for side-by-side comparisons when more than one configuration runs
```

## References

- **[references/gotchas.md](references/gotchas.md)** — full catalog of 18 known gotchas with code examples. Read this before writing a test for a behavior you haven't tested before.
- **[references/test-templates.md](references/test-templates.md)** — reusable test snippets: memory measurement, watchdog preemption, live-mirror, burst-then-idle, async-activity-after-test-end reproduction + **Node-pattern templates** (mustCall, mustNotCall, expectWarning, getArrayBufferViews, platformTimeout).
- **[references/node-patterns.md](references/node-patterns.md)** — lessons learned from `nodejs/node` test suite. Adoption roadmap + helper signatures + which test files should refactor first.

## Adding new gotchas

When you discover a new gotcha in production, a CI flake, or a regression caught by a test:

1. **Write the regression test first** in `test/` — the test must fail without the fix.
2. **Add the gotcha entry** to `references/gotchas.md` with: symptom, root cause, fix pattern, citation (commit hash, issue ID).
3. **Update the skill** if the pattern generalizes beyond the runtime — i.e. applies to other Node projects with `worker_threads`.

The catalog grows by 1 entry per real-world bug caught. Resist the urge to add speculative gotchas — wait for empirical evidence.
