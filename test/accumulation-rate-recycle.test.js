import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';
import * as common from './common.js';

// HARDEN-06 (ADR-0024 C1) — accumulation-rate recycling guard.
//
// Acceptance criteria under test:
//   1. With `accumulationRateMbPerSec` set, a worker whose EWMA-smoothed
//      memory growth rate exceeds the threshold is recycled with
//      `reason: 'accumulation_exceeded'` BEFORE the absolute
//      `maxMemoryMb` threshold is crossed.
//   2. With `accumulationRateMbPerSec: Infinity` (default), the rate
//      check is skipped entirely — back-compat with the pre-HARDEN-06
//      behavior.
//   3. Stable memory (no growth) does NOT trigger rate-based recycling,
//      even with a tight threshold.
//
// The supervisor polls at a hard-coded 1000 ms interval for T6 (T10 in
// Wave 4 will expose this as `workerPollIntervalMs`). The test timing
// accounts for at least 2 poll ticks before checking for recycling so
// the EWMA has enough samples to compute a rate.

describe('WorkerRuntime — accumulation-rate recycling (HARDEN-06)', () => {
  it('recycles worker with reason=accumulation_exceeded BEFORE absolute maxMemoryMb', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      // High absolute threshold so it should NOT fire first. The rate
      // threshold is the one we expect to trip.
      maxMemoryMb: 200,
      accumulationRateMbPerSec: 5,
    });

    try {
      // Give supervisor at least one poll tick before dispatch so the
      // EWMA starts with a non-zero baseline. Without this, the first
      // sample is "0 bytes" and the second sample (after tasks start
      // allocating) shows the full growth as a single-step rate.
      await new Promise((r) => setTimeout(r, 1100));

      // Set up the recycling listener BEFORE dispatching so we don't
      // miss the event. timeoutMs > 2 poll ticks (2000 ms) so the
      // EWMA has time to fire after 2+ samples accumulate.
      const recyclingPromise = common.waitForEvent(runtime, 'worker:recycling', 1, 4000);

      // Each task allocates ~1 MB and stores it in the worker's L1
      // state map. Subsequent tasks see the heap grow because state
      // persists across calls on the same worker. With a 10 ms
      // setTimeout inside the fn, dispatch rate is capped at
      // ~100 tasks/s × 1 MB = ~100 MB/s — well above the 5 MB/s
      // threshold. Recycling should fire on the second poll tick.
      const accumulatingFn = async (_payload, state) => {
        await new Promise((r) => setTimeout(r, 10));
        const next = (state.get('nextKey') ?? 0) + 1;
        // new Array(N).fill(0) → ~8 bytes per entry on V8 (Smi)
        // + array overhead. 250_000 entries ≈ 1 MB heap growth.
        state.set(`chunk_${next}`, new Array(250_000).fill(0));
        state.set('nextKey', next);
        return next;
      };

      // Dispatch 100 tasks at 10 ms each ≈ 1000 ms total. Memory
      // grows 0 → ~100 MB over the window. With 1 worker, dispatch
      // is sequential — the workload spans 2+ poll ticks, so the
      // EWMA sees meaningful growth on each tick.
      const promises = Array.from({ length: 100 }, () => runtime.execute({ fn: accumulatingFn }));

      const event = await recyclingPromise;

      // Acceptance #1: reason is the rate-based one.
      assert.equal(
        event.reason,
        'accumulation_exceeded',
        `expected rate-based recycle, got reason=${event.reason}`,
      );

      // Acceptance #5 (ADR-0024 P6): recycle fires BEFORE the absolute
      // threshold (200 MB here). Allow generous headroom — the goal is
      // to assert recycling did not have to wait for the absolute cap.
      const memoryMb = event.memoryUsage / (1024 * 1024);
      assert.ok(
        memoryMb < 200,
        `recycle should fire before 200 MB absolute threshold; fired at ${memoryMb.toFixed(1)} MB`,
      );

      // Tasks may fail mid-stream (worker recycled). Use allSettled so
      // a few rejections don't fail the test — recycling succeeded.
      await Promise.allSettled(promises);
    } finally {
      await runtime.shutdown();
    }
  });

  it('does NOT fire rate-based recycling when accumulationRateMbPerSec=Infinity (default)', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      // Far above what we'll reach so absolute threshold won't fire
      // either — the test isolates "rate check is disabled".
      maxMemoryMb: 1000,
      // accumulationRateMbPerSec: undefined → Infinity (default).
    });

    try {
      await new Promise((r) => setTimeout(r, 1100));

      // Track accumulation_exceeded events with a plain counter. The
      // mustNotCall helper is not suitable here because OTHER recycling
      // reasons (memory_exceeded, tasks_exceeded) might also be
      // legitimate under unrelated configs — we want to filter on the
      // specific reason.
      let rateRecycled = false;
      runtime.on('worker:recycling', (data) => {
        if (data.reason === 'accumulation_exceeded') rateRecycled = true;
      });

      const accumulatingFn = async (_payload, state) => {
        await new Promise((r) => setTimeout(r, 5));
        const next = (state.get('nextKey') ?? 0) + 1;
        state.set(`chunk_${next}`, new Array(250_000).fill(0));
        state.set('nextKey', next);
        return next;
      };

      const promises = Array.from({ length: 50 }, () => runtime.execute({ fn: accumulatingFn }));

      await Promise.all(promises);
      // Wait an extra poll tick so any late EWMA-triggered recycle
      // would have time to fire.
      await new Promise((r) => setTimeout(r, 1500));

      assert.equal(
        rateRecycled,
        false,
        'rate-based recycling should NOT fire when threshold is Infinity (default)',
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it('does NOT recycle when memory is stable (negative case)', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxMemoryMb: 1000, // absolute threshold far away
      accumulationRateMbPerSec: 5, // tight but above V8 warmup noise
    });

    try {
      // Pre-warmup phase: dispatch a small burst of no-op tasks so V8
      // finishes compiling/initializing its module graph and the heap
      // settles. Without this, the FIRST 1-2 poll samples include the
      // natural ~5 MB warmup growth (modules, optimized code, etc.) and
      // a tight threshold would falsely flag that as a leak.
      await Promise.all(Array.from({ length: 30 }, () => runtime.execute({ fn: () => 42 })));
      // Wait 3+ poll ticks so the EWMA decays toward 0 once warmup is
      // done. α=0.3 means each tick pulls EWMA 30% toward the new
      // instantaneous rate; after 3 ticks of stable memory, the EWMA
      // is within 3% of the true rate.
      await new Promise((r) => setTimeout(r, 3500));

      // After pre-warmup, no recycling should fire — neither rate nor
      // absolute. mustNotCall asserts the listener is NEVER invoked,
      // catching "fired once due to GC spike or remaining warmup noise".
      const neverRecycle = common.mustNotCall(
        'worker:recycling should NOT fire when memory is stable',
      );
      runtime.on('worker:recycling', neverRecycle);

      // Sustained workload: no allocations in user fn, but the runtime
      // still allocates Promises and TaskHandles per dispatch. To avoid
      // serial Promise allocation showing up as a "rate", we space the
      // dispatches out (50 ms each) so any per-task overhead is smeared
      // across 50 ms windows = well below the 5 MB/s threshold.
      const promises = [];
      for (let i = 0; i < 30; i++) {
        promises.push(runtime.execute({ fn: () => 42 }));
        await new Promise((r) => setTimeout(r, 50));
      }
      await Promise.all(promises);
      // Span 3 more poll ticks so any residual allocation pressure has
      // time to be sampled and (incorrectly) trigger the rate check.
      await new Promise((r) => setTimeout(r, 2500));
    } finally {
      await runtime.shutdown();
    }
  });
});
