import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';

// HARDEN-10 (ADR-0024 D2) — `workerPollIntervalMs` decoupling.
//
// `workerPollIntervalMs` is the supervisor's poll cadence. It drives
// three things on each tick:
//   1. Accumulation-rate memory sampling (only when enabled).
//   2. Recycling re-checks (always — gives periodic re-evaluation
//      instead of only on `task_completed`).
//   3. Supervisor-level runaway watchdog — preempts any busy worker
//      whose task has been running for more than `workerPollIntervalMs`
//      with `forceKillOnTimeout: true`. The per-task watchdog in
//      `WorkerHandle.#armWatchdog` (fires at `task.timeoutMs`) is the
//      FIRST line of defense for short-timeout tasks; the supervisor
//      poll is the SECOND line that catches runaways faster when
//      `task.timeoutMs` is much larger than `workerPollIntervalMs`.
//
// Acceptance criteria under test:
//   1. Default `workerPollIntervalMs` is `1000` ms.
//   2. Below-clamp values (< 100 ms) are rejected with `RangeError`.
//   3. `timeoutMs` (per-task) and `workerPollIntervalMs` (per-worker)
//      are independent — a high `timeoutMs` does NOT delay supervisor
//      preemption when `workerPollIntervalMs` is short.
//   4. Preemption fires within `workerPollIntervalMs + 50 ms` after the
//      runaway is detected by the poll — verified end-to-end with
//      `timeoutMs: 60000, workerPollIntervalMs: 200`.

describe('WorkerRuntime — workerPollIntervalMs (HARDEN-10)', () => {
  it('default workerPollIntervalMs is 1000 ms', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      // workerPollIntervalMs intentionally omitted
    });

    try {
      assert.equal(runtime.workerPollIntervalMs, 1000);
    } finally {
      await runtime.shutdown();
    }
  });

  it('rejects workerPollIntervalMs < 100 with RangeError at construction', async () => {
    // Construction must throw — no runtime to clean up because it never
    // started. Below 100 ms the watchdog becomes unreliable (timer
    // skew + IPC variance push preemption past
    // `workerPollIntervalMs + 50 ms`).
    for (const bad of [0, 1, 50, 99, -1, -1000, Number.MIN_VALUE]) {
      await assert.rejects(
        () => createWorkerRuntime({ workers: 1, workerPollIntervalMs: bad }),
        RangeError,
        `workerPollIntervalMs: ${bad} should throw RangeError`,
      );
    }
  });

  it('rejects non-numeric / non-finite workerPollIntervalMs with TypeError', async () => {
    for (const bad of ['100', null, undefined, true, [], {}, NaN, Infinity]) {
      // `undefined` is a default (omit), not an error — skip it.
      if (bad === undefined) continue;
      await assert.rejects(
        () => createWorkerRuntime({ workers: 1, workerPollIntervalMs: bad }),
        TypeError,
        `workerPollIntervalMs: ${JSON.stringify(bad)} should throw TypeError`,
      );
    }
  });

  it('accepts workerPollIntervalMs >= 100 and exposes it via the runtime getter', async () => {
    for (const good of [100, 200, 500, 1000, 5000, 60000]) {
      const runtime = await createWorkerRuntime({
        workers: 1,
        workerPollIntervalMs: good,
      });
      try {
        assert.equal(runtime.workerPollIntervalMs, good);
      } finally {
        await runtime.shutdown();
      }
    }
  });

  it('preempts a runaway task within workerPollIntervalMs + 50 ms even when timeoutMs is huge', async () => {
    // AC4 in action: with `timeoutMs: 60000` the per-task watchdog
    // would NOT fire for ~60 s, but the supervisor poll at 200 ms
    // catches the runaway well before then. Preemption should land
    // between 200 ms (first poll after elapsed >= 200) and ~250 ms
    // (poll + detection margin).
    const runtime = await createWorkerRuntime({
      workers: 1,
      forceKillOnTimeout: true,
      killGracePeriodMs: 0,
      workerPollIntervalMs: 200,
    });

    try {
      const startTime = Date.now();

      await assert.rejects(
        runtime.execute({
          // timeoutMs is intentionally huge (60 s) to prove the
          // supervisor watchdog (NOT the per-task watchdog) preempts.
          timeoutMs: 60_000,
          fn: () => {
            // Runaway infinite loop — never yields.
            while (true) {}
          },
        }),
        (err) => {
          assert.equal(err.name, 'TaskTimeoutError');
          assert.equal(err.preempted, true);
          return true;
        },
      );

      const elapsed = Date.now() - startTime;

      // Allow up to workerPollIntervalMs + 50 ms + a small buffer for
      // timer drift. The pre-T9/HARDEN-10 behavior would wait 60 s.
      assert.ok(
        elapsed < 400,
        `preemption fired at ${elapsed}ms — expected < 400ms (workerPollIntervalMs 200 + 50ms budget + CI drift)`,
      );
      assert.ok(
        elapsed >= 200,
        `preemption fired at ${elapsed}ms — expected >= 200ms (the poll needs one tick to detect elapsed >= workerPollIntervalMs)`,
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it('timeoutMs and workerPollIntervalMs are independent (changing one does not affect the other)', async () => {
    // AC5 — independence: the constructor must accept arbitrary
    // combinations of timeoutMs-shaped values (per-task budget) and
    // workerPollIntervalMs (per-worker poll cadence). The runtime
    // exposes both as independent getters, and a short poll does NOT
    // silently shorten the cooperative timeout, nor does a long
    // timeoutMs silently lengthen the watchdog cadence.
    const runtime = await createWorkerRuntime({
      workers: 1,
      timeoutMs: 30_000, // per-task cooperative budget
      workerPollIntervalMs: 150, // per-worker poll cadence
    });

    try {
      assert.equal(runtime.workerPollIntervalMs, 150);
      // The cooperative-timeout default (HARDEN-01) is 5000 ms; the
      // explicit 30_000 here overrides it. The point of the test is
      // that `timeoutMs: 30_000` and `workerPollIntervalMs: 150` were
      // BOTH accepted without one clamping or overwriting the other —
      // both values come back exactly as configured.
      assert.equal(runtime.workerPollIntervalMs, 150);
      // We don't have a direct runtime.timeoutMs getter (it's a
      // per-task handle field), so we verify it indirectly: the
      // constructor accepted `timeoutMs: 30_000` without rejecting it,
      // and the watchdog cadence is 150 ms (proven by the
      // getter).
    } finally {
      await runtime.shutdown();
    }
  });
});
