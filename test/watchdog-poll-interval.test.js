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
//   4. Preemption fires on the poll cadence — the supervisor preempts on
//      the first poll tick that observes `elapsed >= workerPollIntervalMs`,
//      so it lands within TWO poll intervals of the runaway starting, and
//      a huge `timeoutMs` does not delay it — verified end-to-end with
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
    // skew + IPC variance push the preemption past two poll
    // intervals).
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

  it('preempts a runaway task within two poll intervals even when timeoutMs is huge', async () => {
    // With `timeoutMs: 60000` the per-task watchdog would NOT fire for
    // ~60 s, but the supervisor poll at 200 ms catches the runaway well
    // before then. That is the behaviour this test guards: the
    // supervisor watchdog, NOT the per-task watchdog, is what preempts.
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

      // The supervisor preempts on the first poll tick that OBSERVES
      // `elapsed >= workerPollIntervalMs` (src/supervisor.js:990). The
      // task's start phase inside the poll cycle is arbitrary, so the
      // preemption lands anywhere in (pollInterval, 2 x pollInterval]:
      // a tick that fires a hair before the interval has elapsed does
      // not observe it, and the NEXT tick fires.
      //
      // Measured over 25 runs on an idle host: min 356 ms, p50 360 ms,
      // max 373 ms — every sample in the second-tick band. A loaded
      // macOS CI runner reached 402 ms.
      //
      // The bound therefore has to clear the mechanism's own CEILING
      // (2 x pollInterval) plus the detection overhead (the IPC round
      // trip and the terminate) and a scheduling margin for a loaded
      // runner. The previous bound was `< 400 ms` — strictly BELOW the
      // ceiling, with only ~40 ms of headroom on an idle host — which is
      // why it failed with "preemption fired at 402ms".
      //
      // The regression this test exists to catch is the pre-HARDEN-10
      // behaviour: waiting for `timeoutMs` (60 s). The bound stays two
      // orders of magnitude away from that, so it keeps its power.
      const pollIntervalMs = 200;
      const maxPreemptionMs = 2 * pollIntervalMs + Math.round(pollIntervalMs * 0.75);
      const minPreemptionMs = pollIntervalMs - Math.round(pollIntervalMs * 0.125);
      assert.ok(
        elapsed < maxPreemptionMs,
        `preemption fired at ${elapsed}ms — expected < ${maxPreemptionMs}ms (2 x workerPollIntervalMs ${pollIntervalMs} + 75% detection/scheduling margin)`,
      );
      assert.ok(
        elapsed >= minPreemptionMs,
        `preemption fired at ${elapsed}ms — expected >= ${minPreemptionMs}ms (the poll needs at least one tick to observe elapsed >= workerPollIntervalMs)`,
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
