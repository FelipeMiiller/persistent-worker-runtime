# Node.js Test Patterns — Lessons Learned

Node.js core invests years in `test/common/index.js` because tests are the first defense against regression. This file documents which Node patterns we adopted, which we deliberately skipped, and the roadmap for refactoring existing tests.

**Source of truth:** [`nodejs/node` `test/common/index.js`](https://github.com/nodejs/node/blob/main/test/common/index.js) — 800+ lines of helpers evolved over 10+ years.

**Our translation:** [`test/common.js`](../../../test/common.js) — ESM, zero-deps, 11 helpers.

---

## The 5 lessons that change how you write tests

### Lesson 1: "did event X fire" must mean "exactly N times"

Node's `common.mustCall(fn, exact=1)` wraps a callback so that on `process.exit`, an assertion fires if the callback was called ≠ exact times. This catches three bug classes ad-hoc counters miss:

1. **"Fired zero times"** — counter at end of test reads 0 but `assert.ok(counter > 0)` was at line 50; bug is silent if test never reaches that line.
2. **"Fired twice"** — counter was 1 when assert ran, but the event fired again 5ms later during cleanup. Counter can't tell.
3. **"Fired on a different worker"** — counter is global; multiple workers can race-fire the same event. `mustCall` wraps a per-callback assertion.

**Our adoption:** ✅ `common.mustCall`, `common.mustCallAtLeast`. Helpers exist + smoke-tested (`test/common-smoke.test.js`).

**Tests that need refactoring (priority order):**

| File | Event | Refactor |
|---|---|---|
| `test/preemption.test.js` | `worker:preempted` | wrap with `mustCall(1)` per preempt |
| `test/recycling.test.js` | `worker:recycled` | wrap with `mustCall(N)` per grow |
| `test/state-and-affinity.test.js` | `task:completed` | wrap with `mustCall(N)` |
| `test/cancel-signal.test.js` | `task:aborted` | wrap with `mustCall(1)` per abort |
| `test/streaming-edge-cases.test.js` | `stream:aborted` | wrap with `mustCall(1)` per abort |

### Lesson 2: "this should not happen" is testable

`common.mustNotCall(msg)` wraps a callback so calling it throws immediately. Use for lifecycle paths where the absence of an event is the contract.

**Concrete example:** after `runtime.shutdown()` returns, no `task:completed` should fire. If a worker keeps emitting for 100ms after shutdown returns (a real bug we've seen in worker_thread implementations), memory leaks in production.

```js
runtime.on('task:completed', common.mustNotCall('task completed after shutdown'));
await runtime.shutdown();
await sleep(100);  // wait long enough for any rogue late event
```

**Our adoption:** ✅ `common.mustNotCall`. No tests use it yet — refactor candidates:

- `test/streaming-edge-cases.test.js` — after `runtime.shutdown()`, no `stream:yield` should fire
- `test/preemption.test.js` — after `worker:preempted`, no `task:completed` should fire for the same worker
- `test/cancel-signal.test.js` — after `task:aborted`, no `task:completed` should fire

### Lesson 3: process warnings are public API contracts

Node treats every `process.emit('warning', ...)` as a contract that users grep for. `common.expectWarning(name, message, code)` installs a `process.on('warning', ...)` trap and asserts the named warning fires with the expected message regex + code.

**Our gap:** `PersistentWorkerRuntimeDefaultSizing` warning exists but no test asserts its message or code. Renaming the warning text today is silent.

```js
common.expectWarning(
  'PersistentWorkerRuntimeDefaultSizing',
  /started with default workers=1 on a \d+-core host/,
  'ERR_PERSISTENT_WORKER_DEFAULT_SIZING',
);
const runtime = createWorkerRuntime();  // triggers warning
// After test: if warning fired with wrong message/code, test FAILS.
```

**Our adoption:** ✅ `common.expectWarning`. Refactor candidate: `test/worker-pool-sizing.test.js` (currently uses ad-hoc `process.on('warning', fn)`).

### Lesson 4: Test what matters, not what's easy

When transferring an `ArrayBuffer`, every typed-array view pointing into it (`Uint8Array`, `Int32Array`, `DataView`, `BigInt64Array`, …) must be detached. The single-view assertion `buf.byteLength === 0` passes if `Uint8Array` is detached — even if `DataView` is not.

`common.getArrayBufferViews(buf)` enumerates all 12 typed-array views. Pre-capture them BEFORE the transfer, then assert each view's `buffer.byteLength === 0` after.

**Our adoption:** ✅ `common.getArrayBufferViews`. Refactor demo: `test/zero-copy.test.js` "transfers a single ArrayBuffer" — already uses the pattern.

**Tests that need refactoring:**

- `test/zero-copy.test.js` "transfers multiple ArrayBuffers" — same pattern for each
- `test/zero-copy.test.js` "routes a TypedArray view via transferList" — pre-capture all views

### Lesson 5: test isolation is non-negotiable

Node tests fail on `process.exit` if any unexpected global appears in `globalThis`. Catches: leaked listeners, unclosed handles, accidental globals.

**Our gap:** `--test-concurrency=1` masks this because state leaks don't compound. Switching to parallel tests would expose leaks. `common.getLeakedGlobals()` is ready; not yet enforced.

**Adoption roadmap:**

1. Add `test/_setup.js` with `process.on('exit', () => assert.equal(getLeakedGlobals().length, 0))`
2. Run npm test for one week — fix any real leaks found
3. Switch to `--test-concurrency=4` once clean

---

## Patterns we deliberately did NOT adopt

### `// Flags: --expose-gc` / `// Env: WORKER_CONCURRENCY=4` metadata

Node's `parseTestMetadata()` reads test-file comments and re-spawns the test with required flags/env. We don't run tests with exotic flags. Document required flags in test-file JSDoc instead.

### Raw `{ ... }` blocks instead of `describe`/`it`

Node uses raw blocks for simple tests (less ceremony). We use `node:test`'s structure consistently — better for test reports.

### `node --abort-on-uncaught-exception` testing

Asserts the runtime aborts on uncaught exception. We're a library, not a CLI. Skip.

### `expectRequiredModule` / `expectRequiredTLAError` (ESM-specific)

Node's recent additions for ESM testing. Not needed — we're pure ESM, no `require()` ESM-graph concerns.

---

## Adoption roadmap

| Phase | Goal | Tests refactored | Effort |
|---|---|---|---|
| **Phase 1 (now)** | Helpers exist + 1 demo each | 1 (`zero-copy`) | ✅ Done |
| **Phase 2** | Wrap all event-driven tests in `mustCall` | 5 files | ~3 hours |
| **Phase 3** | Add `mustNotCall` to lifecycle tests | 3 files | ~1 hour |
| **Phase 4** | Add `expectWarning` for `PersistentWorkerRuntimeDefaultSizing` | 1 file | ~30 min |
| **Phase 5** | Add `platformTimeout` to long-running tests | 3+ files | ~1 hour |
| **Phase 6** | Enable `getLeakedGlobals` enforcement | 1 setup file | ~30 min |
| **Phase 7** | Switch to `--test-concurrency=4` | package.json | ~30 min |

**Total effort:** ~7 hours of focused refactoring. Each phase = 1 commit.

---

## Helper signatures (one-page reference)

```js
import * as common from './common.js';

// Event handlers
common.mustCall(fn, exact = 1);          // callback called EXACTLY N times
common.mustCallAtLeast(fn, minimum = 1); // callback called AT LEAST N times
common.mustNotCall(msg);                 // callback NEVER fires (throws if invoked)
common.mustSucceed(fn, exact = 1);       // (err, ...args) wrapper + assert.ifError
common.expectsError(validator, exact = 1); // throws N errors matching validator

// Process warnings
common.expectWarning(name, expected, code); // asserts warning fires with shape

// Platform
common.isWindows, common.isLinux, common.isMacOS; // process.platform constants
common.platformTimeout(ms);                        // × 2 on debug, × 4 on RISC-V 64

// Timing
await common.sleep(ms);   // async sleep (setTimeout-based)
common.sleepSync(ms);     // sync sleep (Atomics.wait-based)

// Typed-array views
common.getArrayBufferViews(buf);  // [Int8Array, Uint8Array, ..., DataView]
common.getBufferSources(buf);     // includes the underlying ArrayBuffer

// Test isolation
common.isMainThread;            // gate tests by thread context
common.allowGlobals(...vals);    // whitelist expected globals
common.getLeakedGlobals();       // unexpected globals at exit time
```

For Node's full helper surface (~80 helpers), see [`nodejs/node` `test/common/index.js`](https://github.com/nodejs/node/blob/main/test/common/index.js). We adopt the 11 above; the rest are Node-specific (cluster, child_process, openssl, etc.) and irrelevant to a library.

---

## How to know we're making progress

| Metric | Today (2026-09-20) | Target |
|---|---|---|
| `mustCall` / `mustNotCall` usages | 0 | ≥ 10 (one per event-driven subsystem) |
| `expectWarning` usages | 0 | ≥ 1 (covers `PersistentWorkerRuntimeDefaultSizing`) |
| `platformTimeout` usages | 0 | ≥ 3 (long-running tests) |
| `getArrayBufferViews` usages | 1 | ≥ 2 (zero-copy + view-transfer) |
| `sleepSync` usages | 0 | ≥ 1 (sync timing test) |
| Helpers exposed in `test/common.js` | 11 | (no target — keep minimal) |
| `--test-concurrency` | 1 | 4 (after leak audit clean) |
