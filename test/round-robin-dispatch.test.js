import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';

// HARDEN-09 (ADR-0024 D1) — dispatch strategies.
//
// Three strategies are accepted on `createWorkerRuntime`:
//   - `'lru'` (default) — round-robin through idle workers in spawn order.
//     Recycled-fresh workers (`tasksCompleted === 0` + idle) get priority
//     regardless of strategy (cheapest slot to fill).
//   - `'fifo'` — preserves pre-HARDEN-09 "first idle wins" semantics. With
//     sequential awaits, the first-spawned worker is `candidates[0]` and
//     receives every dispatch after the initial fresh-priority phase.
//   - `'random'` — uniform random pick among idle workers.
//
// Acceptance criteria under test:
//   1. LRU distributes evenly across the pool over many sequential
//      dispatches (±10 % of fair share per worker).
//   2. FIFO concentrates dispatches on worker 0 once the pool is warmed
//      (pre-HARDEN-09 back-compat).
//   3. Default strategy is `'lru'` when `dispatchStrategy` is omitted.
//   4. Invalid strategies throw `TypeError` at construction time.
//   5. All three documented strategies are accepted and exposed via
//      `runtime.dispatchStrategy`.

describe('WorkerRuntime — dispatch strategies (HARDEN-09)', () => {
  it('LRU round-robin distributes evenly across 4 workers over 400 sequential tasks', async () => {
    const runtime = await createWorkerRuntime({
      workers: 4,
      dispatchStrategy: 'lru',
    });

    try {
      // Sequential awaits ensure each task completes (worker returns to
      // idle) before the next dispatch. That's the regime where LRU
      // cycling is exercised: every dispatch sees all 4 workers as
      // candidates and the strategy picks the "next" one in rotation.
      //
      // The fresh-priority branch DOES pick the first 4 in insertion
      // order, which happens to coincide with the LRU cycle's first
      // rotation. After disp 4, every worker has tasksCompleted === 1
      // and the LRU cycle takes over. With 400 total tasks (divisible
      // by 4), each worker ends with exactly 100 — so the assertion
      // is exact, not just within tolerance.
      for (let i = 0; i < 400; i++) {
        await runtime.execute({ fn: () => 42 });
      }

      const counts = runtime
        .getWorkers()
        .map((w) => w.tasksCompleted)
        .sort((a, b) => a - b);

      // LRU must distribute evenly. ±10 % of 100 = ±10 — but the math
      // is exact for divisible-by-N task counts, so we assert exactly
      // 100 per worker and let CI catch any regression in the cycling.
      assert.deepEqual(
        counts,
        [100, 100, 100, 100],
        `expected each worker to receive exactly 100 tasks under LRU, got ${counts.join(', ')}`,
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it('FIFO concentrates post-warm dispatches on worker 0 (pre-HARDEN-09 behavior)', async () => {
    const runtime = await createWorkerRuntime({
      workers: 4,
      dispatchStrategy: 'fifo',
    });

    try {
      // Pre-warm: dispatch 4 tasks so every worker has done at least 1.
      // After this, the fresh-priority branch no longer applies (all
      // workers have tasksCompleted >= 1) and FIFO takes over — the
      // strategy returns `candidates[0]`, which is the first-spawned
      // idle worker.
      for (let i = 0; i < 4; i++) {
        await runtime.execute({ fn: () => 42 });
      }

      // Confirm pre-warm state — every worker did exactly 1 task.
      const preWarmCounts = runtime
        .getWorkers()
        .map((w) => w.tasksCompleted)
        .sort((a, b) => a - b);
      assert.deepEqual(
        preWarmCounts,
        [1, 1, 1, 1],
        'pre-warm: every worker should have exactly 1 task completed',
      );

      // Now dispatch 20 more tasks. With FIFO + sequential awaits, all
      // 4 workers are idle between dispatches; `candidates[0]` is the
      // first-spawned worker (the original "worker 0") and receives
      // every dispatch. The other 3 stay at 1.
      for (let i = 0; i < 20; i++) {
        await runtime.execute({ fn: () => 42 });
      }

      const finalCounts = runtime.getWorkers().map((w) => w.tasksCompleted);
      const [w0, w1, w2, w3] = finalCounts;

      assert.equal(w0, 21, `worker 0 should have 21 (1 pre-warm + 20 post-warm), got ${w0}`);
      assert.equal(w1, 1, `worker 1 should have 1 (pre-warm only), got ${w1}`);
      assert.equal(w2, 1, `worker 2 should have 1 (pre-warm only), got ${w2}`);
      assert.equal(w3, 1, `worker 3 should have 1 (pre-warm only), got ${w3}`);
    } finally {
      await runtime.shutdown();
    }
  });

  it('default dispatchStrategy is "lru" when option is omitted', async () => {
    const runtime = await createWorkerRuntime({
      workers: 2,
      // dispatchStrategy intentionally omitted
    });

    try {
      assert.equal(runtime.dispatchStrategy, 'lru', 'runtime default must be lru');
    } finally {
      await runtime.shutdown();
    }
  });

  it('rejects invalid dispatchStrategy with TypeError at construction', async () => {
    // Construction must throw — no runtime to clean up because it never
    // started. `createWorkerRuntime` returns a rejected Promise, so we
    // use `assert.rejects` with the sync factory form.
    const badValues = [
      'LRU', // uppercase typo
      'FIFO',
      'foo',
      '', // empty string
      null,
      42,
      true,
      false,
      [],
      {},
    ];

    for (const bad of badValues) {
      await assert.rejects(
        () => createWorkerRuntime({ workers: 2, dispatchStrategy: bad }),
        TypeError,
        `dispatchStrategy: ${JSON.stringify(bad)} should throw TypeError`,
      );
    }
  });

  it('accepts all three documented dispatch strategies', async () => {
    for (const good of ['lru', 'fifo', 'random']) {
      const runtime = await createWorkerRuntime({
        workers: 2,
        dispatchStrategy: good,
      });
      try {
        assert.equal(runtime.dispatchStrategy, good, `getter must reflect ${good}`);
        // Smoke: dispatch a single task to confirm the strategy doesn't
        // throw at runtime. Distribution is not asserted (random would
        // be flaky) — just that the strategy is wired.
        await runtime.execute({ fn: () => 42 });
      } finally {
        await runtime.shutdown();
      }
    }
  });
});
