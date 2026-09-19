/**
 * Benchmark: adaptive-concurrency end-to-end (T10 — Phases A, B, E).
 *
 * Validates the runtime-level adaptive controller behaviour against
 * synthetic main-thread pressure and idle queues. Three deliverables
 * per ADR-0014 §Acceptance Criteria + tasks.md §T10:
 *
 *   - **Phase A** (synthetic pressure / shrink): boot a runtime with
 *     `workers: 4`, `minWorkers: 1`, `maxWorkers: 8`. Inject a sustained
 *     busy main thread (ELU > 0.95 sustained via a `setImmediate` chain
 *     with 9 ms CPU bursts). Verify that the adaptive controller fires
 *     `shrink` and the pool drains from 4 → 1. Then stop the workload and
 *     verify that the main-thread ELU stabilizes below 0.5 — i.e., the
 *     runtime reaches a quiescent state where the only signal sample is
 *     the idle Event Loop and the controller stops firing.
 *
 *   - **Phase B** (synthetic grow): boot a runtime with `workers: 1`,
 *     `maxWorkers: 8`, no workload on the main thread (idle Event Loop).
 *     Dispatch a steady stream of fast sync tasks so the queue depth
 *     peaks while ELU and p99 stay below the grow thresholds. Verify the
 *     pool grows toward `maxWorkers: 8` and throughput scales linearly.
 *
 *   - **Phase E** (telemetry): same setup as Phase B (or A) but the
 *     assertion is on `runtime.stats.adaptive` — `lastResizeReason`,
 *     `lastResizeAt`, `ticksSinceResize` all reflect the resize events
 *     the controller fired during Phase A/B.
 *
 * Phase C (opt-out sanity) lives in a separate file —
 * `adaptive-controller-opt-out.benchmark.js` (commit `e64a82d`) — because
 * the opt-out path doesn't need a real runtime. This file covers the
 * runtime-level integration phases only.
 *
 * Wired via `npm run benchmark:adaptive-concurrency` (added when this file
 * is committed).
 */

import { createWorkerRuntime } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Workload primitives
// ─────────────────────────────────────────────────────────────────────────

const BURST_MS = 9;

/**
 * Runs a synchronous CPU burst for at most `BURST_MS` milliseconds per
 * iteration, then schedules the next iteration via `setImmediate` so the
 * event loop is never starved entirely. Raw ELU samples hover near 0.95 on
 * Linux/macOS and ~0.8 on Windows CI Node 22.x — both well above the
 * shrink threshold (0.85 default).
 *
 * Returns a `stop()` function that flips the active flag and clears the
 * pending `setImmediate` chain on the next callback boundary.
 *
 * Pattern reference: see `.agents/CROSS-OS-LESSONS.md` §2 — setImmediate
 * chains are more reliable than setInterval-based busy loops for
 * saturating the event loop on multi-core CI runners.
 */
function startBusyWorkload() {
  let active = true;
  // Underscore prefix tells Biome this variable is intentionally
  // write-only — the loop body uses it as a write sink to defeat
  // dead-code elimination (V8 would otherwise elide the busy burst
  // in release builds). The name must include an underscore to opt
  // out of the no-unused-variables heuristic.
  let _acc = 0;
  function tick() {
    if (!active) return;
    const burstStart = Date.now();
    while (Date.now() - burstStart < BURST_MS) {
      for (let i = 0; i < 1e6; i++) _acc += i;
    }
    setImmediate(tick);
  }
  setImmediate(tick);
  return () => {
    active = false;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function formatHeader(title) {
  const bar = '─'.repeat(Math.max(20, 70 - title.length));
  return `\n── ${title} ${bar}\n`;
}

function fmtMs(ms) {
  return `${ms.toFixed(3).padStart(10)} ms`;
}

function logLine(s) {
  console.log(s);
}

async function settleFor(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────
// Phase A — synthetic pressure (shrink)
// ─────────────────────────────────────────────────────────────────────────

async function phaseASyntheticPressure() {
  logLine(formatHeader('Phase A: synthetic main-thread pressure → shrink'));

  // The spec (`tasks.md` §T10 Phase A) calls for `workers: 4` as the
  // starting pool, but `resolveAdaptiveEnabled` in `worker-pool-sizing.js`
  // disables the adaptive controller whenever `options.workers` is a
  // number. The clean way to start with 4 workers AND keep adaptive on
  // is `WORKER_CONCURRENCY=4` (ADR-0023): same resolved count, no
  // opt-out. We set the env var locally so this benchmark doesn't leak
  // its sizing into the surrounding process. The restore is in the
  // `finally` block below.
  const SIZING_ENV_VAR = 'WORKER_CONCURRENCY';
  const previousEnv = process.env[SIZING_ENV_VAR];
  process.env[SIZING_ENV_VAR] = '4';

  let runtime;
  let stopBusy;
  try {
    runtime = await createWorkerRuntime({
      minWorkers: 1,
      maxWorkers: 8,
    });

    // Adaptive block is populated at construction. Snapshot the baseline
    // before any workload runs.
    const baseline = runtime.stats.adaptive;
    logLine(
      `  baseline: enabled=${baseline.enabled} effectiveWorkers=${baseline.effectiveWorkers}`,
    );

    if (baseline.effectiveWorkers !== 4) {
      throw new Error(
        `Phase A FAIL: expected baseline effectiveWorkers=4 (from WORKER_CONCURRENCY=4), got ${baseline.effectiveWorkers}`,
      );
    }

    // Start the busy workload (sustained ELU > 0.85 default shrink
    // threshold). Keep it running long enough to cover the shrink
    // debounce (5 ticks × 100 ms = 500 ms) plus EWMA convergence (~3
    // ticks from idle baseline) plus retire drain (~100 ms). 2500 ms
    // gives the same headroom used in
    // `test/adaptive-concurrency-runtime.test.js` Phase 2 — see commit
    // `daedaf6` for the Windows CI timing fix.
    stopBusy = startBusyWorkload();

    // ── Stage 1: workload applied, expect shrink to fire ──────────────
    await settleFor(2500);

    const duringBusy = runtime.stats.adaptive;
    logLine(
      `  during busy workload: ` +
        `effectiveWorkers=${duringBusy.effectiveWorkers} ` +
        `lastResizeReason=${duringBusy.lastResizeReason} ` +
        `ticksSinceResize=${duringBusy.ticksSinceResize} ` +
        `elu=${duringBusy.elu === null ? 'null' : duringBusy.elu.toFixed(3)}`,
    );

    if (duringBusy.effectiveWorkers !== 1) {
      throw new Error(
        `Phase A FAIL: expected effectiveWorkers=1 after shrink, got ${duringBusy.effectiveWorkers}`,
      );
    }
    if (duringBusy.lastResizeReason !== 'shrink') {
      throw new Error(
        `Phase A FAIL: expected lastResizeReason='shrink', got '${duringBusy.lastResizeReason}'`,
      );
    }
    if (!(duringBusy.elu !== null && duringBusy.elu > 0.7)) {
      throw new Error(
        `Phase A FAIL: expected ELU > 0.7 during sustained busy workload, got ${duringBusy.elu}`,
      );
    }

    // ── Stage 2: release workload, expect ELU to drop and pool to stay at 1 ──
    stopBusy();
    stopBusy = null;
    // Give the controller enough ticks to sample the now-idle signal and
    // for the EWMA to converge back below the shrink threshold. The
    // adaptive controller does not fire grow here (no queue), so the
    // pool should remain at `effectiveWorkers: 1`.
    await settleFor(800);

    const postBusy = runtime.stats.adaptive;
    logLine(
      `  post-busy:             ` +
        `effectiveWorkers=${postBusy.effectiveWorkers} ` +
        `lastResizeReason=${postBusy.lastResizeReason} ` +
        `ticksSinceResize=${postBusy.ticksSinceResize} ` +
        `elu=${postBusy.elu === null ? 'null' : postBusy.elu.toFixed(3)}`,
    );

    if (postBusy.effectiveWorkers !== 1) {
      throw new Error(
        `Phase A FAIL: pool should remain at 1 after workload release, got ${postBusy.effectiveWorkers}`,
      );
    }
    if (!(postBusy.elu !== null && postBusy.elu < 0.5)) {
      throw new Error(
        `Phase A FAIL: expected ELU < 0.5 after workload release (idle steady-state), got ${postBusy.elu}`,
      );
    }

    logLine(`  ✓ shrink fired (4 → 1)`);
    logLine(`  ✓ ELU stabilizes < 0.5 in idle post-shrink`);

    return { runtime, baseline };
  } finally {
    if (stopBusy) stopBusy();
    if (previousEnv === undefined) {
      delete process.env[SIZING_ENV_VAR];
    } else {
      process.env[SIZING_ENV_VAR] = previousEnv;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = performance.now();
  logLine('======================================================================');
  logLine('BENCHMARK: Adaptive Concurrency — Phase A (T10)');
  logLine('======================================================================');

  let runtime;
  try {
    const phaseA = await phaseASyntheticPressure();
    runtime = phaseA.runtime;

    const elapsed = performance.now() - t0;
    logLine(`\n  phase A wall time: ${fmtMs(elapsed)}`);
    logLine('\n  VERDICT: Phase A passed — shrink under sustained main-thread pressure works.');
  } catch (err) {
    logLine(`\n  ${err.message}`);
    logLine('\n  VERDICT: Phase A FAILED.');
    process.exitCode = 1;
  } finally {
    if (runtime) await runtime.shutdown();
  }
}

main().catch((err) => {
  console.error('Unhandled error in Phase A:', err);
  process.exitCode = 1;
});
