import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';

// HARDEN-07 (ADR-0024 C2) — recycle hysteresis.
//
// Acceptance criteria under test:
//   1. With `minRecycleIntervalMs > 0`, repeated recycle decisions for
//      the SAME worker within the window emit `worker:recycle:skipped`
//      instead of triggering another spawn cycle. The first decision
//      proceeds; subsequent ones are throttled.
//   2. With `minRecycleIntervalMs === 0` (default at the runtime
//      boundary), the throttle is disabled and every recycle decision
//      proceeds — back-compat with the pre-HARDEN-07 behavior.
//
// The "5 decisions on the same worker id" scenario is forced via
// `runtime.recycleWorker(workerId)` — a public API that bypasses the
// normal trigger paths (task_completed, poll tick) so the test
// deterministically exercises the hysteresis guard regardless of poll
// timing or worker-replacement race windows.

describe('WorkerRuntime — recycle hysteresis (HARDEN-07)', () => {
  it('emits worker:recycle:skipped for subsequent decisions within minRecycleIntervalMs', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      // Make EVERY task trigger a recycle decision so the same worker
      // is eligible for recycle on each subsequent `forceRecycleCheck`.
      maxTasksPerWorker: 1,
      // 60-second hysteresis — far longer than the test wall time so
      // every subsequent decision is throttled.
      minRecycleIntervalMs: 60000,
    });

    try {
      const skippedEvents = [];
      const recyclingEvents = [];

      // Listen on the colon-form public surface (mirror of `worker:recycling`).
      runtime.on('worker:recycle:skipped', (data) => skippedEvents.push(data));
      runtime.on('worker:recycling', (data) => recyclingEvents.push(data));

      // Dispatch 1 task. With `maxTasksPerWorker: 1`, the natural
      // `task_completed` path triggers a real recycle SYNCHRONOUSLY
      // inside the supervisor's `task_completed` handler — by the time
      // `execute()` resolves, the `worker:recycling` event has ALREADY
      // fired and `lastRecycledAt` is recorded. (We can't use
      // `waitForEvent` here: it would attach its listener AFTER the
      // event fired and time out.)
      await runtime.execute({ fn: () => 42 });

      // Capture the id of the recycling worker. At this point it is
      // still in the pool (status='recycling', awaiting replacement).
      assert.equal(
        recyclingEvents.length,
        1,
        `expected exactly 1 real recycle, got ${recyclingEvents.length}`,
      );
      const recycledWorkerId = recyclingEvents[0].workerId;

      // Force 4 more checks within the hysteresis window. Each should
      // emit `worker:recycle:skipped` because `lastRecycledAt` is set
      // and the worker is still in the pool.
      for (let i = 0; i < 4; i++) {
        runtime.recycleWorker(recycledWorkerId);
        // Yield so the EventEmitter listeners process synchronously
        // between forced checks — keeps event ordering deterministic.
        await new Promise((r) => setImmediate(r));
      }

      // Decision #1 → `worker:recycling` (real recycle, spawned replacement).
      // Decisions #2–#5 → `worker:recycle:skipped` (hysteresis blocks).
      assert.equal(
        recyclingEvents.length,
        1,
        `expected exactly 1 actual recycle, got ${recyclingEvents.length}`,
      );
      assert.equal(
        skippedEvents.length,
        4,
        `expected 4 skipped events, got ${skippedEvents.length}`,
      );

      // Skipped event payload shape per ADR-0024 C2:
      //   { workerId, reason: 'hysteresis', lastRecycledAt: number }
      for (const ev of skippedEvents) {
        assert.equal(ev.workerId, recycledWorkerId);
        assert.equal(ev.reason, 'hysteresis');
        assert.equal(typeof ev.lastRecycledAt, 'number');
        assert.ok(ev.lastRecycledAt > 0, 'lastRecycledAt must be a positive timestamp');
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it('does NOT throttle when minRecycleIntervalMs is 0 (default)', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      // Every task recycles — 5 sequential tasks = 5 recycle decisions.
      maxTasksPerWorker: 1,
      // minRecycleIntervalMs omitted → runtime default `0` → no throttle.
    });

    try {
      assert.equal(runtime.minRecycleIntervalMs, 0, 'runtime default must be 0');

      const skippedEvents = [];
      const recyclingEvents = [];
      runtime.on('worker:recycle:skipped', (data) => skippedEvents.push(data));
      runtime.on('worker:recycling', (data) => recyclingEvents.push(data));

      // Dispatch 5 tasks sequentially. With maxTasksPerWorker=1 and no
      // hysteresis, each task triggers a real recycle (different worker
      // ids each time because recycle = terminate + replace). We use
      // the same literal in every fn because the worker-thread entry
      // wraps fnCode via `new Function(...)` which has no access to
      // outer scope — so `() => i` would ReferenceError.
      for (let i = 0; i < 5; i++) {
        await runtime.execute({ fn: () => 42 });
      }

      // After 5 sequential tasks, 5 actual recycles should have fired.
      const deadline = Date.now() + 3000;
      while (recyclingEvents.length < 5 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        recyclingEvents.length >= 5,
        `expected at least 5 actual recycles with no hysteresis, got ${recyclingEvents.length}`,
      );
      assert.equal(
        skippedEvents.length,
        0,
        'no skipped events should fire when minRecycleIntervalMs is 0',
      );

      // Belt-and-suspenders: force 5 decisions on the SAME worker id
      // (whichever is currently in the pool) and verify none are
      // skipped — the same-worker path that test 1 throttles must be
      // bypassed here.
      const id = runtime.getWorkers()[0].id;
      for (let i = 0; i < 5; i++) {
        runtime.recycleWorker(id);
        await new Promise((r) => setImmediate(r));
      }
      // No new skipped events from the force-checks (the worker may
      // already be in 'recycling' state from the natural flow, but
      // `minRecycleIntervalMs: 0` means hysteresis is OFF so even the
      // recycling-guard path doesn't fire a skipped event).
      assert.equal(
        skippedEvents.length,
        0,
        'forced checks must not emit skipped events when hysteresis is disabled',
      );
    } finally {
      await runtime.shutdown();
    }
  });
});
