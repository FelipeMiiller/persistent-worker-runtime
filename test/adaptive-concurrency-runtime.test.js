/**
 * T9 P5/P1/P2 — Adaptive Concurrency integration tests (ADR-0014).
 *
 * The grow/shrink end-to-end coverage lives here because it needs real
 * `WorkerRuntime` ticks (T7 wiring) and the live `runtime.stats.adaptive`
 * mirror (T8 block). T7's `adaptive-controller-runtime.test.js` only
 * proves the seam is plumbed; T9 verifies the public contract from the
 * caller's perspective.
 *
 * Each scenario uses `options.minWorkers` / `options.maxWorkers` to
 * constrain the band so a single grow / shrink cycle settles in a
 * finite number of resize fires. Without the constraint, defaults would
 * let the pool grow from 1 to `availableParallelism()` (~28 on the dev
 * box), taking ~13.5s of debounce time alone — impractical for unit
 * tests. The `ae5c980` T7 commit hard-coded `minWorkers: 1` and
 * `maxWorkers: availableParallelism()`; the factory option was wired
 * here so tests can override it without forking the constructor.
 *
 * **Lifecycle hygiene**: `createWorkerRuntime` is async and starts
 * the runtime before returning. Each test that creates a runtime MUST
 * `await` it and MUST let the `afterEach` hook shut it down — leaking
 * worker threads keeps the Event Loop alive past the test's last
 * assertion and hangs the runner.
 */
import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';

const ORIGINAL_ENV = Object.hasOwn(process.env, 'WORKER_CONCURRENCY')
  ? process.env.WORKER_CONCURRENCY
  : undefined;
function clearSizingEnv() {
  delete process.env.WORKER_CONCURRENCY;
}
function restoreSizingEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.WORKER_CONCURRENCY;
  } else {
    process.env.WORKER_CONCURRENCY = ORIGINAL_ENV;
  }
}

describe('T9 P5 — runtime.stats.adaptive live-mirrors controller telemetry', () => {
  let runtime;

  before(clearSizingEnv);

  afterEach(async () => {
    if (runtime) {
      await runtime.shutdown();
      runtime = null;
    }
    restoreSizingEnv();
  });

  it('updates elu / latencyP99Ms / ticksSinceResize after real ticks', async () => {
    runtime = await createWorkerRuntime({ maxWorkers: 2 });

    const before = runtime.stats.adaptive;
    assert.equal(before.ticksSinceResize, 0);
    assert.equal(before.elu, null);
    assert.equal(before.latencyP99Ms, null);
    assert.equal(before.lastResizeReason, null);

    // Wait for at least 2 ticks (200ms+). The signal histogram needs
    // one interval window to accumulate meaningful samples; the second
    // tick is the first with a non-null EWMA delta on both channels.
    await new Promise((r) => setTimeout(r, 350));

    const after = runtime.stats.adaptive;
    assert.ok(
      after.ticksSinceResize >= 2,
      `ticksSinceResize should advance, got ${after.ticksSinceResize}`,
    );
    assert.ok(after.elu !== null, 'elu should populate after first tick');
    assert.ok(after.latencyP99Ms !== null, 'latencyP99Ms should populate after first tick');
    assert.equal(after.enabled, true);
    // Idle signal window: no resize expected inside the 350ms gate.
    assert.equal(after.lastResizeReason, null);
    assert.equal(after.lastResizeAt, null);
  });
});
