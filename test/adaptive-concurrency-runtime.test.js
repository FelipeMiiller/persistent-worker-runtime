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

  it('flips lastResizeReason between grow and shrink with monotonic lastResizeAt', async () => {
    // Threshold overrides — see the comment block below. Production code
    // never sets these; the controller's defaults come from Phase E
    // empirical data. The overrides exist so this test can pin the
    // band in CI environments where GC pauses and Event Loop noise
    // would otherwise keep signals out of the default grow window.
    runtime = await createWorkerRuntime({
      minWorkers: 1,
      maxWorkers: 2,
      // `growLatencyP99Ms` defaults to 10ms. Idle Event Loop p99 in
      // a typical Node 22 process is ~31ms (V8 minor GC pauses are
      // captured as event-loop delays). Bumping the threshold to 100ms
      // makes an idle-loop run classify as 'grow' — without this, the
      // default threshold keeps the controller permanently in 'noop'
      // and the grow fire never happens.
      growLatencyP99Ms: 100,
      // `shrinkEluThreshold` defaults to 0.85. The busy-loop burst
      // below produces ~94% ELU on a single core, but on a
      // multi-core host (this CI runner has 28 cores) the EWMA
      // smooths down to ~85-90% — sometimes just under the default.
      // Drop to 0.7 to make the shrink fire deterministic without
      // touching production thresholds.
      shrinkEluThreshold: 0.7,
    });

    // Wait for any initial ticks to settle so the first tick doesn't
    // start from a stale signal window.
    await new Promise((r) => setTimeout(r, 100));

    // PHASE 1 — Induce GROW. Dispatch a flood of fast sync tasks so the
    // main thread stays idle (low ELU + low latencyP99 below the
    // overridden grow thresholds) while queue depth peaks. The
    // controller's grow condition (both signals below the grow
    // thresholds) fires after `debounceTicks` (=5) ticks.
    const handles = [];
    for (let i = 0; i < 200; i++) {
      handles.push(
        runtime.dispatch({
          type: 'mirror_task',
          fn: () => 1 + 1,
        }),
      );
    }

    // 5 ticks × 100ms = 500ms debounce + ~200ms spawn budget on a typical
    // CI runner. macOS GitHub Actions Node 22 is the slowest known target;
    // allow generous slack for a deterministic green.
    await new Promise((r) => setTimeout(r, 1200));
    await Promise.all(handles.map((h) => h.promise.catch(() => {})));

    const afterGrow = runtime.stats.adaptive;
    assert.equal(afterGrow.lastResizeReason, 'grow');
    const growAt = afterGrow.lastResizeAt;
    assert.ok(typeof growAt === 'number' && growAt > 0);
    assert.equal(
      afterGrow.effectiveWorkers,
      2,
      'pool should grow to the band ceiling (effectiveWorkers === maxWorkers)',
    );

    // PHASE 2 — Induce SHRINK. Phase 1's task drain leaves all workers
    // idle, so `retireLowestLoadWorker` can fire without waiting on
    // in-flight work. Use a recursive `setImmediate` chain to keep the
    // event loop near-100% busy — a `setInterval`-based burst loop
    // (the previous attempt) left ~0.5ms idle gaps where the controller's
    // own setInterval could land, producing oscillating ELU samples
    // (0.59 ↔ 0.68) that never reliably crossed the shrink threshold
    // (T9 P2 flake rate ~33% on this 28-core host). `setImmediate`
    // chain yields to the event loop only between iterations; the
    // resulting busy ratio is high enough that the EWMA converges
    // toward ~0.9 within 2-3 ticks and stays there.
    //
    // The busy loop runs until AFTER the stats read below. Stopping
    // it earlier lets the Event Loop go idle and grow direction
    // accumulates again — the next debounce window would flip
    // `lastResizeReason` back to 'grow' and the assertion would race.
    let busyLoopActive = true;
    const BURST_MS = 9;
    function busyTick() {
      if (!busyLoopActive) return;
      const burstStart = Date.now();
      let _acc = 0;
      while (Date.now() - burstStart < BURST_MS) {
        for (let i = 0; i < 1e6; i++) _acc += i;
      }
      setImmediate(busyTick);
    }
    setImmediate(busyTick);

    try {
      // Wait for shrink debounce (5 ticks × 100ms = 500ms) + EWMA
      // transition from idle (~0.05 ELU) to busy (~0.9 ELU) — at α=0.3
      // the smoothed ELU converges within 3-4 ticks once the raw sample
      // sits at ~0.9. Earliest shrink fire lands ~900ms into Phase 2,
      // plus retire drain (~100ms). 2500ms gives clear headroom against
      // Windows Node 22.x CI runners where the setImmediate chain is
      // ~20-30% slower than Linux/macOS (Windows GitHub Actions VM
      // has higher event-loop overhead, raw ELU samples hover closer
      // to 0.8 than 0.9, so the EWMA needs more ticks to cross the
      // 0.7 shrink threshold). 1500ms was right at the boundary on
      // Windows Node 22.x and produced a one-off flake.
      await new Promise((r) => setTimeout(r, 2500));
    } finally {
      busyLoopActive = false;
    }

    const afterShrink = runtime.stats.adaptive;
    assert.equal(afterShrink.lastResizeReason, 'shrink');
    assert.ok(
      afterShrink.lastResizeAt >= growAt,
      `lastResizeAt must advance past grow timestamp (shrink=${afterShrink.lastResizeAt}, grow=${growAt})`,
    );
    assert.equal(
      afterShrink.effectiveWorkers,
      1,
      'pool should shrink to the floor (effectiveWorkers === minWorkers)',
    );
  });
});
