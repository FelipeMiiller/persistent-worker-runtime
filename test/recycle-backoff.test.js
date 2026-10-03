import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';

/**
 * Poll until `predicate()` is true or the deadline passes.
 *
 * Recycling is asynchronous: `task_completed` → supervisor decides →
 * spawn replacement thread → terminate old. The spawn dominates and it is
 * routinely slower on a loaded CI runner than on a developer machine. These
 * tests previously used fixed sleeps and the constants kept having to be
 * raised after each flake (see the 50 ms → 200 ms notes below), which is the
 * anti-pattern: a sleep encodes a guess about the slowest machine, not a
 * statement about the behaviour under test.
 *
 * A deadline-based poll states the real requirement — "this must happen
 * within 5 s" — and returns as soon as it does, so the suite is both faster
 * on a good machine and stable on a bad one.
 */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}

// HARDEN-11 (ADR-0024 D3) — `recycleBackoffMs` drain grace.
//
// When a worker is recycled (maxTasksPerWorker / maxMemoryMb / accumulation
// rate / forceRecycleCheck), the old worker is currently terminated
// immediately after the replacement is spawned. With `recycleBackoffMs > 0`,
// the old worker stays in `runtime.getWorkers()` with status 'recycling'
// for that long before physical termination. The replacement is already
// serving tasks during the grace — pool capacity is temporarily N+1,
// drops back to N when the timer fires.
//
// Acceptance criteria under test:
//   1. Default `recycleBackoffMs` is `0` — old worker removed immediately.
//   2. With `recycleBackoffMs > 0` — old worker visible in
//      `runtime.getWorkers()` for the configured duration.
//   3. Negative values throw `RangeError`; non-finite throw `TypeError`.
//   4. Replacement worker is serving tasks during the backoff (pool
//      capacity is N+1 transiently, then back to N).

describe('WorkerRuntime — recycleBackoffMs (HARDEN-11)', () => {
  it('default recycleBackoffMs is 0', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxTasksPerWorker: 1,
      // recycleBackoffMs intentionally omitted
    });

    try {
      assert.equal(runtime.recycleBackoffMs, 0);
    } finally {
      await runtime.shutdown();
    }
  });

  it('with recycleBackoffMs=0 (default), recycled worker is removed immediately after the replacement is ready', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxTasksPerWorker: 1,
    });

    try {
      // Trigger a recycle by exhausting maxTasksPerWorker on the only worker.
      await runtime.execute({ fn: () => 42 });

      // Wait for the replacement to spawn and the old worker to terminate.
      await waitFor(
        () => {
          const ws = runtime.getWorkers();
          return ws.length === 1 && ws[0].status === 'idle';
        },
        { what: 'pool back to 1 idle worker after immediate recycle' },
      );

      const workers = runtime.getWorkers();
      // Total pool size should be back to 1 (the new replacement).
      assert.equal(
        workers.length,
        1,
        `expected 1 worker after immediate recycle, got ${workers.length}`,
      );
      // The remaining worker should be the new one (status: 'idle'),
      // NOT in 'recycling' state.
      assert.equal(workers[0].status, 'idle');
    } finally {
      await runtime.shutdown();
    }
  });

  it('with recycleBackoffMs=600, recycled worker stays in getWorkers() for ~600ms before removal', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxTasksPerWorker: 1,
      recycleBackoffMs: 600,
    });

    try {
      // Trigger a recycle by exhausting maxTasksPerWorker on the only worker.
      await runtime.execute({ fn: () => 42 });

      // Wait until the replacement is fully ready (pool N+1 AND one worker
      // 'idle'). Polling only on `length === 2` returns too early — the
      // replacement is still in status 'starting' at that point, so the
      // assertions about an idle replacement would race it.
      await waitFor(
        () => {
          const ws = runtime.getWorkers();
          return ws.length === 2 && ws.some((w) => w.status === 'idle');
        },
        { what: 'pool of 2 with an idle replacement during backoff' },
      );

      const midWorkers = runtime.getWorkers();
      assert.equal(
        midWorkers.length,
        2,
        `expected 2 workers during backoff (old + new), got ${midWorkers.length}: ${JSON.stringify(midWorkers.map((w) => ({ status: w.status })))}`,
      );

      const recyclingWorker = midWorkers.find((w) => w.status === 'recycling');
      assert.ok(recyclingWorker, 'one of the workers should be in recycling status during backoff');
      const idleWorker = midWorkers.find((w) => w.status === 'idle');
      assert.ok(idleWorker, 'one of the workers should be in idle status (the replacement)');

      // Snapshot the recycling worker's id BEFORE the backoff elapses —
      // after the backoff fires, the recycling worker is gone and only
      // the idle replacement remains. `recyclingWorker.id` is the
      // pre-backoff id; `finalWorkers[0].id` should be the replacement
      // id, NOT the same one.
      const recyclingWorkerId = recyclingWorker.id;

      // Wait for the backoff timer to fire and the old worker to be removed.
      await waitFor(() => runtime.getWorkers().length === 1, {
        what: 'old worker removed after backoff elapsed',
      });

      const finalWorkers = runtime.getWorkers();
      assert.equal(
        finalWorkers.length,
        1,
        `expected 1 worker after backoff, got ${finalWorkers.length}: ${JSON.stringify(finalWorkers.map((w) => ({ status: w.status })))}`,
      );
      // The remaining worker should be the replacement (idle).
      assert.equal(finalWorkers[0].status, 'idle');
      assert.notEqual(
        finalWorkers[0].id,
        recyclingWorkerId,
        'remaining worker should be the replacement, not the recycled one',
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it('replacement worker is in the pool (status idle) while old worker is in backoff (status recycling)', async () => {
    // Pool capacity is N+1 transiently: the old worker stays in
    // `recycling` for `recycleBackoffMs` while the new replacement is
    // already `idle` and ready for dispatch.
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxTasksPerWorker: 1,
      recycleBackoffMs: 800,
    });

    try {
      // Task 1 triggers recycle (w0 → recycling, w1 spawned as replacement).
      await runtime.execute({ fn: () => 42 });

      // Wait for the replacement to be ready AND the old worker to be
      // 'recycling' — that is the N+1 state this test is about.
      await waitFor(
        () => {
          const ws = runtime.getWorkers();
          return (
            ws.length === 2 &&
            ws.some((w) => w.status === 'recycling') &&
            ws.some((w) => w.status === 'idle')
          );
        },
        { what: 'pool of 2 with one recycling and one idle worker' },
      );

      // Pool should be N+1 (w0 recycling, w1 idle).
      const midWorkers = runtime.getWorkers();
      assert.equal(
        midWorkers.length,
        2,
        `expected 2 workers during backoff (old + new), got ${midWorkers.length}: ${JSON.stringify(midWorkers.map((w) => ({ status: w.status })))}`,
      );
      const statuses = midWorkers.map((w) => w.status).sort();
      assert.deepEqual(statuses, ['idle', 'recycling']);

      // Wait for the backoff to elapse.
      await waitFor(() => runtime.getWorkers().length === 1, {
        what: 'pool to return to 1 after backoff',
      });

      // Pool is back to N.
      assert.equal(runtime.getWorkers().length, 1);
    } finally {
      await runtime.shutdown();
    }
  });

  it('shutdown() during a recycle-backoff releases the awaiting Promise (regression for Finding 1 in .agents/issues/002)', async () => {
    // Issue 002 Finding 1 — when `shutdown()` is called while a
    // recycle-backoff timer is in flight, the shutdown path must invoke
    // `resolve()` on the awaiting Promise inside `#checkRecycling` (not
    // just `clearTimeout` the timer). Without `resolve()`, the Promise
    // hangs forever and the surrounding closure (`worker` + the
    // `replacement` worker) is leaked until the runtime is GC'd.
    //
    // Observable contract enforced by this test:
    //   1. shutdown() returns promptly even when interrupting a long backoff.
    //   2. No `unhandledRejection` events fire during the flow.
    //   3. Post-shutdown state is clean (no workers remaining).
    //
    // Caveat: the closure release itself is not directly observable
    // without `--expose-gc` (we don't enable it in CI). This test
    // therefore documents the user-visible contract and acts as a
    // regression guard — any future change that re-introduces the hang
    // would either break promptness, surface an unhandled rejection, or
    // leave stale workers behind.

    const runtime = await createWorkerRuntime({
      workers: 1,
      maxTasksPerWorker: 1,
      // Long enough to interrupt mid-flight.
      recycleBackoffMs: 5000,
    });

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      // Trigger a recycle by exhausting maxTasksPerWorker on the only worker.
      await runtime.execute({ fn: () => 42 });

      // Wait for the replacement to spawn and the OLD worker to enter
      // 'recycling' — we are now mid-backoff.
      await waitFor(() => runtime.getWorkers().some((w) => w.status === 'recycling'), {
        what: "a worker in 'recycling' status during backoff",
      });

      const midWorkers = runtime.getWorkers();
      assert.ok(
        midWorkers.some((w) => w.status === 'recycling'),
        `expected one worker in 'recycling' status during backoff, got: ${JSON.stringify(
          midWorkers.map((w) => ({ status: w.status })),
        )}`,
      );

      // Shutdown mid-backoff. Pre-fix: leaked the awaiting Promise's
      // closure (worker + replacement held until GC). Post-fix: shutdown
      // resolves the Promise so the `.then()` continuation runs to
      // completion (and bails out via the `isShuttingDown` check).
      const t0 = Date.now();
      await runtime.shutdown();
      const elapsed = Date.now() - t0;

      // Generous bound: 1000 ms is way less than the 5000 ms backoff and
      // leaves room for CI timer noise on slow runners.
      assert.ok(
        elapsed < 1000,
        `shutdown took ${elapsed}ms — expected < 1000ms; the backoff Promise may still be hanging (Finding 1 unresolved)`,
      );

      assert.equal(
        unhandled.length,
        0,
        `unexpected unhandledRejection events: ${JSON.stringify(unhandled)}`,
      );

      // Post-shutdown state is clean — no workers remain.
      assert.equal(runtime.getWorkers().length, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects negative recycleBackoffMs with RangeError', async () => {
    await assert.rejects(
      () => createWorkerRuntime({ workers: 1, recycleBackoffMs: -1 }),
      RangeError,
    );
    await assert.rejects(
      () => createWorkerRuntime({ workers: 1, recycleBackoffMs: -1000 }),
      RangeError,
    );
  });

  it('rejects non-numeric / non-finite recycleBackoffMs with TypeError', async () => {
    for (const bad of ['100', null, true, [], {}, NaN, Infinity, -Infinity]) {
      await assert.rejects(
        () => createWorkerRuntime({ workers: 1, recycleBackoffMs: bad }),
        TypeError,
        `recycleBackoffMs: ${JSON.stringify(bad)} should throw TypeError`,
      );
    }
  });

  it('accepts non-negative finite recycleBackoffMs values and exposes them via the getter', async () => {
    for (const good of [0, 1, 100, 1000, 60000]) {
      const runtime = await createWorkerRuntime({
        workers: 1,
        recycleBackoffMs: good,
      });
      try {
        assert.equal(runtime.recycleBackoffMs, good);
      } finally {
        await runtime.shutdown();
      }
    }
  });
});
