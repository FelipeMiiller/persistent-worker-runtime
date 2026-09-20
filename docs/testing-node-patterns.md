# Node.js Test Patterns — Gap Analysis for persistent-worker-runtime

This document maps the test patterns Node.js core uses (in `nodejs/node` `test/parallel/`) to patterns our test suite should adopt. It's a working list — each row points to a Node helper, our current state, and the concrete gap to close.

**Status legend:**
- ✅ adopted (helper lives in `test/common.js` + smoke test green)
- 🟡 adopted in helper, not yet used in production tests
- ❌ not adopted

---

## Tier 1 — High-impact, low-effort

### 1. `mustCall(fn, exact=N)` — assert callback called exactly N times

| Aspect | Detail |
|---|---|
| **Node helper** | `common.mustCall(fn, exact=1)` (test/common/index.js, ~line 470) |
| **What it does** | Wraps a callback so that, on `process.exit`, an assertion fires if the callback was called ≠ exact times. |
| **Why Node uses it** | Catches "event fired twice when it should fire once" or "event never fired when it should" without ad-hoc counters. |
| **Our gap** | Every event-driven test uses `let counter = 0; event.on(() => counter++)` and asserts `counter === 1`. If the test passes and the event ALSO fires a 2nd time later, the assertion doesn't see it. |
| **Status** | ✅ adopted (`test/common.js` `mustCall`) |
| **Example gap** | `test/preemption.test.js` — "watchdog kills runaway task within timeoutMs" — currently asserts the task rejects. Doesn't catch "task rejected twice" or "rejection + new task started". |

### 2. `mustNotCall(msg)` — assert callback NEVER fires

| Aspect | Detail |
|---|---|
| **Node helper** | `common.mustNotCall(msg)` |
| **What it does** | Wraps a callback so calling it triggers `assert.fail`. |
| **Why Node uses it** | "This should not happen" paths. E.g. after `runtime.shutdown()`, `task:completed` should NOT fire. |
| **Our gap** | We don't test absence. Tests assert "the task completed" but never "no extra tasks fired after shutdown". |
| **Status** | ✅ adopted |
| **Example gap** | `test/streaming-edge-cases.test.js` — could add: "after `runtime.shutdown()`, stream's `[Symbol.asyncIterator]()` should NOT throw `WorkerRuntimeError` on `next()`" — using `common.mustNotCall` for the error handler. |

### 3. `expectWarning(name, expected, code)` — assert process warning fires with shape

| Aspect | Detail |
|---|---|
| **Node helper** | `common.expectWarning(name, expected, code)` |
| **What it does** | Installs a `process.on('warning', ...)` trap. Asserts the named warning fires N times with matching message regex + code. |
| **Why Node uses it** | Drift detection. If a warning's text or code changes, the test fails. |
| **Our gap** | `PersistentWorkerRuntimeDefaultSizing` warning exists in `src/worker-runtime.js` but NO test asserts its message/code. If we rename the warning, nothing catches it. |
| **Status** | ✅ adopted |
| **Action item** | Refactor `test/worker-pool-sizing.test.js` to use `common.expectWarning('PersistentWorkerRuntimeDefaultSizing', /started with default workers/, 'ERR_PERSISTENT_WORKER_DEFAULT_SIZING')` instead of the current `process.on('warning', fn)` pattern. |

### 4. `mustSucceed(fn, exact=1)` — Node-style callback wrapper

| Aspect | Detail |
|---|---|
| **Node helper** | `common.mustSucceed(fn, exact=1)` |
| **What it does** | Wraps `(err, ...args)` callback: `mustCall` + `assert.ifError(err)`. |
| **Why Node uses it** | Standardizes error handling in Node-style callbacks. |
| **Our gap** | We use promises throughout — `mustSucceed` is less relevant. Keep for the few `child_process.exec` / `socket.connect` tests. |
| **Status** | ✅ adopted (lower priority; rarely used in our suite) |

---

## Tier 2 — Cross-platform robustness

### 5. `platformTimeout(ms)` — slow-CI multiplier

| Aspect | Detail |
|---|---|
| **Node helper** | `common.platformTimeout(ms)` (test/common/index.js, ~line 240) |
| **What it does** | Multiplies `ms` by 2 on AIX / IBMi / Raspberry Pi, 4 on RISC-V 64, 2 on debug builds. |
| **Why Node uses it** | Same test passes on x86 Linux + slow RISC-V CI. |
| **Our gap** | Tests use fixed timeouts (1500ms, 2500ms). `daedaf6` already bumped a Phase 2 wait 1500→2500ms for Windows CI flake. This is the same problem but generalized. |
| **Status** | ✅ adopted (returns `ms` unchanged on default CI) |
| **Action item** | Replace literal `await sleep(1500)` with `await sleep(common.platformTimeout(1500))` in long-running tests. |

### 6. `sleepSync(ms)` — synchronous sleep via `Atomics.wait`

| Aspect | Detail |
|---|---|
| **Node helper** | `common.sleepSync(ms)` (test/common/index.js, line ~410) |
| **What it does** | `Atomics.wait` on a SharedArrayBuffer; deterministic synchronous block. |
| **Why Node uses it** | Tests that need to advance time without yielding the event loop. |
| **Our gap** | We have async `sleep` but no sync equivalent. Not needed for current tests, but useful for future tests that need to block inside a sync test body. |
| **Status** | ✅ adopted |

---

## Tier 3 — Buffer / typed-array coverage

### 7. `getArrayBufferViews(buf)` + `getBufferSources(buf)`

| Aspect | Detail |
|---|---|
| **Node helper** | `common.getArrayBufferViews(buf)` / `common.getBufferSources(buf)` (test/common/index.js) |
| **What it does** | Enumerate every TypedArray view (Int8Array, Uint8Array, ..., DataView) that maps onto `buf`. |
| **Why Node uses it** | Tests that an ArrayBuffer is fully detached post-transfer, not just one view of it. |
| **Our gap** | `test/zero-copy.test.js` line ~80 only checks `byteLength === 0` for the SINGLE typed-array passed. Doesn't check other views. A transfer bug that only affects some views would slip through. |
| **Status** | ✅ adopted |
| **Action item** | Refactor `test/zero-copy.test.js` "transfers a single ArrayBuffer" to use `common.getArrayBufferViews(buf)` and assert every view is detached (`byteLength === 0`). |

---

## Tier 4 — Test hygiene

### 8. `isMainThread` gating

| Aspect | Detail |
|---|---|
| **Node helper** | `if (!isMainThread) common.skip('Worker bootstrapping works differently')` |
| **What it does** | Skips a test if it's already inside a worker. |
| **Why Node uses it** | Tests of async hooks in workers behave differently than in the main thread. |
| **Our gap** | Tests that exercise worker dispatch can themselves run inside a worker (rare, but possible if a test spawns a sub-test). |
| **Status** | ✅ adopted (export `isMainThread`) |

### 9. `allowGlobals` + `getLeakedGlobals`

| Aspect | Detail |
|---|---|
| **Node helper** | `common.allowGlobals(...allowlist)` + exit-time `leakedGlobals()` |
| **What it does** | Fails the test if any unexpected global appears in `globalThis` at exit. |
| **Why Node uses it** | Catches tests that pollute global state and leak it to subsequent tests. |
| **Our gap** | No global-pollution check. Tests can set globals without consequence. |
| **Status** | ✅ adopted (helper present, not enforced at test runner level yet) |
| **Action item** | Add a `test/_setup.js` that runs `getLeakedGlobals()` at exit. Decide later if we want hard enforcement. |

### 10. `expectsError(validator, exact=N)` — assert N errors with matching validator

| Aspect | Detail |
|---|---|
| **Node helper** | `common.expectsError(validator, exact=1)` |
| **What it does** | Wraps `mustCall` to assert the wrapped fn was called N times with an Error matching `validator`. |
| **Why Node uses it** | Tests that expect multiple errors (e.g., 3 tasks all rejecting with the same code). |
| **Our gap** | Tests of `executeAll` / `dispatchAll` with mixed success/failure use ad-hoc results arrays. |
| **Status** | ✅ adopted |

---

## Tier 5 — Patterns we deliberately do NOT adopt

### 11. `// Flags: --expose-gc` / `// Env: WORKER_CONCURRENCY=4` metadata

| Aspect | Detail |
|---|---|
| **Node helper** | `parseTestMetadata()` reads metadata from comments at the top of test files. |
| **What it does** | Spawns the test with the required flags/env. |
| **Our gap** | Some tests need `--expose-gc` or env vars but don't self-document. |
| **Why we don't adopt** | Biome / npm-test runs our tests directly. Adding a custom metadata parser is high-effort for low-value (we don't run tests with exotic flags). |
| **Action item** | Document required flags/env in test-file JSDoc instead. Future migration if we add `--expose-gc` to npm test: `node --expose-gc --test ...`. |

### 12. `node:test` framework vs raw blocks

| Aspect | Detail |
|---|---|
| **Node helper** | Many tests use raw `{ ... }` blocks (top-level `await assert.strictEqual(...)`) without `describe`/`it`. |
| **What it does** | Less ceremony for simple tests. |
| **Our gap** | We use `node:test`'s `describe`/`it` consistently. |
| **Why we don't switch** | `node:test`'s structure is more readable for test reports. Each test gets a clear name. Stick with `describe`/`it`. |

### 13. `node --abort-on-uncaught-exception` testing pattern

| Aspect | Detail |
|---|---|
| **Node helper** | Tests that the runtime aborts on uncaught exception. |
| **Our gap** | No test asserts "this kind of uncaught exception aborts the process". |
| **Why we don't adopt** | Our runtime is a library, not a CLI. Users embed it. Abort-on-uncaught is a Node-CLI concept. Skip. |

---

## Refactor plan — concrete next steps

1. ✅ **DONE**: Build `test/common.js` with helpers (Tier 1-4).
2. ✅ **DONE**: Build `test/common-smoke.test.js` (9 tests) to validate the helpers themselves.
3. **Refactor `test/worker-pool-sizing.test.js`** to use `common.expectWarning` (Tier 1 #3).
4. **Refactor `test/zero-copy.test.js`** "transfers a single ArrayBuffer" to use `common.getArrayBufferViews` (Tier 3 #7).
5. **Refactor 2-3 long-running tests** to use `common.platformTimeout` (Tier 2 #5).
6. **Refactor 1-2 "should not happen" tests** to use `common.mustNotCall` (Tier 1 #2).
7. **Add a regression test** that uses `common.mustCall(exact=2)` to catch a real "event fired twice" bug we find or invent (Tier 1 #1).

Each refactor = one commit with the test changes + new `common.js` imports.

---

## Closing the loop — how to know we're making progress

| Metric | Today | Target |
|---|---|---|
| Tests using `mustCall` / `mustNotCall` | 0 | ≥ 5 (one per event-driven subsystem) |
| Tests using `expectWarning` | 0 | ≥ 1 (covering `PersistentWorkerRuntimeDefaultSizing`) |
| Tests using `platformTimeout` | 0 | ≥ 3 (in long-running tests) |
| Tests using `getArrayBufferViews` | 0 | ≥ 1 (zero-copy regression) |
| Tests using `sleepSync` | 0 | ≥ 1 (synchronous timing) |
| Helpers exposed in `common.js` | 11 | (no target — keep minimal) |

When the "Tests using" metrics hit their targets, the suite is genuinely Node-pattern-compliant.
