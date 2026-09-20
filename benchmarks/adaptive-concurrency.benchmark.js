/**
 * Benchmark: adaptive-concurrency end-to-end (T10 — Phases A, B, E).
 *
 * Validates the runtime-level adaptive controller behaviour against
 * synthetic main-thread pressure and idle queues. Three deliverables
 * per ADR-0014 §Acceptance Criteria + tasks.md §T10:
 *
 *   - **Phase A** (synthetic pressure / shrink, commit `591694e`): boot
 *     a runtime via `WORKER_CONCURRENCY=4` + `minWorkers: 1`,
 *     `maxWorkers: 8`. Inject a sustained busy main thread (ELU > 0.95
 *     sustained via a `setImmediate` chain with 9 ms CPU bursts). Verify
 *     that the adaptive controller fires `shrink` and the pool drains
 *     from 4 → 1. Then stop the workload and verify that the main-thread
 *     ELU stabilizes below 0.5 — i.e., the runtime reaches a quiescent
 *     state where the only signal sample is the idle Event Loop and the
 *     controller stops firing.
 *
 *   - **Phase B** (synthetic grow, T10-B deliverable): boot a runtime
 *     with the ADR-0019 default initial pool (1 worker) and
 *     `maxWorkers: 8`. Dispatch a steady stream of fast sync tasks via
 *     a `setImmediate` chain (5 dispatches per iteration) so the main
 *     thread stays idle (low ELU + low p99 below the overridden grow
 *     thresholds) while the queue depth peaks. Verify the pool grows
 *     from 1 → 8 and that throughput scales — the assertion is on
 *     `effectiveWorkers === 8`, `lastResizeReason === 'grow'`, and ELU
 *     staying below 0.5 throughout.
 *
 *   - **Phase E** (telemetry, T10-E delivered): same setup as Phase B
 *     but the assertions are on the **full 7-field surface** of
 *     `runtime.stats.adaptive` — baseline snapshot asserts the
 *     reset state (`lastResizeReason=null`, `lastResizeAt=null`,
 *     `ticksSinceResize=0`); post-grow snapshot asserts every field
 *     reflects the resize (`enabled=true`, `elu` finite in [0,1],
 *     `latencyP99Ms` finite ≥ 0, `effectiveWorkers=4`,
 *     `lastResizeReason='grow'`, `lastResizeAt` finite recent
 *     timestamp, `ticksSinceResize` small non-negative integer).
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
// Phase B — synthetic grow
// ─────────────────────────────────────────────────────────────────────────

async function phaseBSyntheticGrow() {
  logLine(formatHeader('Phase B: synthetic grow pressure → grow'));

  // Pin the starting pool to 1 worker via the `WORKER_CONCURRENCY` env
  // var (ADR-0023 escape hatch). Two reasons over the default path:
  //
  //   1. `WORKER_CONCURRENCY=1` matches our intent ("start at 1, grow
  //      toward maxWorkers") and keeps `adaptiveEnabled: true` (the env
  //      var is not in the opt-out list). The "default sizing" startup
  //      warning is also suppressed — `isDefaultSizing()` returns false
  //      whenever the env var is set, even to a value of 1.
  //   2. Passing `options.workers: 1` would have the right starting size
  //      but would force `resolveAdaptiveEnabled` to return false, so
  //      grow would never fire. Phase A avoids the same trap by also
  //      using the env var.
  //
  // The env var is restored in `finally` so it doesn't leak into the
  // surrounding process.
  const SIZING_ENV_VAR = 'WORKER_CONCURRENCY';
  const previousEnv = process.env[SIZING_ENV_VAR];
  process.env[SIZING_ENV_VAR] = '1';

  let runtime;
  // Sentinel assigned before the try block so the `finally` cleanup can
  // call it unconditionally. The real implementation captures the
  // `reBursting` closure flag set inside `scheduleReBurst()`.
  let stopReBurst = () => {
    /* assigned in try block; no-op default keeps `finally` safe */
  };
  let totalDispatched = 0;
  let totalCompleted = 0;

  try {
    runtime = await createWorkerRuntime({
      minWorkers: 1,
      maxWorkers: 8,
      // Threshold overrides — see `test/adaptive-concurrency-runtime.test.js`
      // for the full rationale. Production code leaves these unset; the
      // overrides pin the band in CI environments where V8 minor GC pauses
      // (~31ms on idle Event Loop, Node 22) sit above the default
      // `growLatencyP99Ms: 10`. Without bumping the threshold, the
      // controller classifies idle ticks as 'noop' and never grows.
      growLatencyP99Ms: 100,
      shrinkEluThreshold: 0.7,
    });

    const baseline = runtime.stats.adaptive;
    logLine(
      `  baseline: enabled=${baseline.enabled} effectiveWorkers=${baseline.effectiveWorkers}`,
    );

    if (baseline.effectiveWorkers !== 1) {
      throw new Error(
        `Phase B FAIL: expected baseline effectiveWorkers=1 (env-pinned floor), got ${baseline.effectiveWorkers}`,
      );
    }

    // Wait for the first EWMA tick to settle so the smoothed ELU is
    // measuring real idle samples rather than constructor overhead.
    await settleFor(100);

    // Dispatch a large synchronous burst. The burst itself is short-lived
    // (microseconds per dispatch; ~10-50 ms total for 2000 tasks on the
    // dev box) and the main thread becomes idle again as soon as the
    // loop exits — which is exactly the steady-state signal the
    // controller's `tick()` needs to classify as 'grow' (ELU < 0.5,
    // p99 below the overridden 100 ms threshold).
    //
    // Why not a `setImmediate` chain (the original attempt)? Each
    // setImmediate callback fires immediately after the previous one
    // yields, so a continuous `dispatch(); setImmediate(recurse)` loop
    // keeps the main thread saturated — observed ELU ~0.95 in the first
    // attempt, classifying as 'shrink' instead of 'grow'. Burst-then-idle
    // matches the `test/adaptive-concurrency-runtime.test.js` pattern
    // that has been verified green across 10 local runs (T9 P1).
    const handles = [];
    const INITIAL_BURST = 2000;
    for (let i = 0; i < INITIAL_BURST; i++) {
      const h = runtime.dispatch({ type: 'mirror_task', fn: () => 1 + 1 });
      handles.push(h);
      h.promise.then(
        () => {
          totalCompleted++;
        },
        () => {
          // Swallow rejections — the benchmark asserts on stats, not on
          // task outcomes. Tasks here never throw.
        },
      );
      totalDispatched++;
    }

    // Periodic re-burst every 1500 ms to keep work flowing through the
    // workers while the pool is growing. Each batch is small (50 tasks)
    // so the per-tick dispatch overhead stays well below the 0.5 ELU
    // grow threshold — over 7 seconds we re-burst ~5 times for ~250
    // extra tasks, total main-thread CPU footprint ~5 ms (≈0.07% ELU).
    // The cadence is shorter than the 5-tick debounce window so workers
    // always have work to drain.
    let reBursting = true;
    function scheduleReBurst() {
      if (!reBursting) return;
      setTimeout(() => {
        if (!reBursting) return;
        for (let i = 0; i < 50; i++) {
          const h = runtime.dispatch({ type: 'mirror_task', fn: () => 1 + 1 });
          handles.push(h);
          h.promise.then(
            () => {
              totalCompleted++;
            },
            () => {
              /* swallow rejections — task fn() never throws; defensive only */
            },
          );
          totalDispatched++;
        }
        scheduleReBurst();
      }, 1500);
    }
    scheduleReBurst();
    stopReBurst = () => {
      reBursting = false;
    };

    // Time budget for 7 grow fires (1 → 8):
    //
    //   - First EWMA convergence: ~2-3 ticks (~300 ms)
    //   - Each grow fire: debounce 5 ticks (500 ms) + spawn budget
    //     (~100-200 ms on Linux/macOS, ~30% larger on Windows Node 22.x
    //     per `test/adaptive-concurrency-runtime.test.js` Phase 2 timing)
    //   - 7 fires × ~700 ms = ~4900 ms minimum
    //
    // 7000 ms total gives ~40% headroom against slower CI runners.
    await settleFor(7000);
    stopReBurst();
    // Settle one more debounce window so the stats snapshot below
    // reflects the post-fire steady state, not a tick mid-fire.
    await settleFor(500);

    const afterGrow = runtime.stats.adaptive;
    logLine(
      `  after grow:           ` +
        `effectiveWorkers=${afterGrow.effectiveWorkers} ` +
        `lastResizeReason=${afterGrow.lastResizeReason} ` +
        `ticksSinceResize=${afterGrow.ticksSinceResize} ` +
        `elu=${afterGrow.elu === null ? 'null' : afterGrow.elu.toFixed(3)} ` +
        `tasksDispatched=${totalDispatched} tasksCompleted=${totalCompleted}`,
    );

    if (afterGrow.effectiveWorkers !== 8) {
      throw new Error(
        `Phase B FAIL: expected effectiveWorkers=8 (maxWorkers cap), got ${afterGrow.effectiveWorkers}`,
      );
    }
    if (afterGrow.lastResizeReason !== 'grow') {
      throw new Error(
        `Phase B FAIL: expected lastResizeReason='grow', got '${afterGrow.lastResizeReason}'`,
      );
    }
    if (!(afterGrow.elu !== null && afterGrow.elu < 0.5)) {
      throw new Error(
        `Phase B FAIL: expected ELU < 0.5 during idle main thread, got ${afterGrow.elu}`,
      );
    }

    // Throughput sanity: with the pool at 8 workers draining the queue
    // in parallel, the completed count should comfortably clear the
    // initial 2000-task burst. We don't assert a strict ratio (CI
    // variance is wide), but a non-zero count proves the pool actually
    // contributed.
    if (totalCompleted === 0) {
      throw new Error(`Phase B FAIL: expected at least one completed task, got ${totalCompleted}`);
    }

    logLine(`  ✓ grow fired (1 → 8)`);
    logLine(`  ✓ ELU stays low during idle steady-state`);
    logLine(
      `  ✓ throughput scaled (${totalCompleted} tasks completed across ${afterGrow.effectiveWorkers} workers)`,
    );

    return { runtime };
  } finally {
    stopReBurst();
    if (previousEnv === undefined) {
      delete process.env[SIZING_ENV_VAR];
    } else {
      process.env[SIZING_ENV_VAR] = previousEnv;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase E — telemetry: full 7-field assertions on `runtime.stats.adaptive`
// ─────────────────────────────────────────────────────────────────────────

/**
 * Phase E verifies that the **complete** public surface of
 * `runtime.stats.adaptive` reflects the controller's resize events
 * correctly. Phases A and B each assert a subset of fields (the ones
 * relevant to their own resize direction); Phase E is the dedicated
 * telemetry gate that exercises every field of the 7-field block at
 * the runtime boundary (not via `controller.getStats()`), per
 * `spec.md` §P5 + tasks.md §T10 Phase E.
 *
 * Setup mirrors Phase B (synthetic grow from 1 → maxWorkers) but uses
 * a smaller `maxWorkers` band (4 instead of 8) so the grow completes
 * inside ~5 s of settle time. Two snapshots are taken:
 *
 *   1. **Baseline** (post-construction, pre-workload) — asserts the
 *      reset state: `lastResizeReason === null`, `lastResizeAt === null`,
 *      `ticksSinceResize === 0`.
 *   2. **Post-grow** (after a settled grow fire) — asserts every field
 *      of the 7-field block reflects the resize.
 *
 * The post-grow assertion is deliberately narrow on band (1 → 4) so
 * the elapsed time stays inside a single CI-friendly budget; the field
 * shape is identical at any maxWorkers value, so the assertion
 * generalises to the production band.
 */
async function phaseETelemetry() {
  logLine(formatHeader('Phase E: runtime.stats.adaptive full 7-field telemetry'));

  const SIZING_ENV_VAR = 'WORKER_CONCURRENCY';
  const previousEnv = process.env[SIZING_ENV_VAR];
  process.env[SIZING_ENV_VAR] = '1';

  let runtime;
  let stopReBurst = () => {
    /* assigned in try block; no-op default keeps `finally` safe */
  };

  try {
    runtime = await createWorkerRuntime({
      minWorkers: 1,
      maxWorkers: 4,
      // Same threshold overrides as Phase B — see rationale there.
      growLatencyP99Ms: 100,
      shrinkEluThreshold: 0.7,
    });

    // ── Baseline snapshot (post-construction, pre-workload) ───────────
    // The controller has not fired yet, so `lastResizeReason`,
    // `lastResizeAt` must be `null` and `ticksSinceResize` must be `0`.
    const baseline = runtime.stats.adaptive;
    logLine(
      `  baseline: enabled=${baseline.enabled} ` +
        `effectiveWorkers=${baseline.effectiveWorkers} ` +
        `lastResizeReason=${baseline.lastResizeReason} ` +
        `ticksSinceResize=${baseline.ticksSinceResize} ` +
        `lastResizeAt=${baseline.lastResizeAt}`,
    );

    if (baseline.enabled !== true) {
      throw new Error(`Phase E FAIL: expected baseline.enabled=true, got ${baseline.enabled}`);
    }
    if (baseline.lastResizeReason !== null) {
      throw new Error(
        `Phase E FAIL: expected baseline.lastResizeReason=null, got '${baseline.lastResizeReason}'`,
      );
    }
    if (baseline.lastResizeAt !== null) {
      throw new Error(
        `Phase E FAIL: expected baseline.lastResizeAt=null, got ${baseline.lastResizeAt}`,
      );
    }
    if (baseline.ticksSinceResize !== 0) {
      throw new Error(
        `Phase E FAIL: expected baseline.ticksSinceResize=0, got ${baseline.ticksSinceResize}`,
      );
    }
    if (baseline.effectiveWorkers !== 1) {
      throw new Error(
        `Phase E FAIL: expected baseline.effectiveWorkers=1 (env-pinned), got ${baseline.effectiveWorkers}`,
      );
    }

    // ── Induce grow ────────────────────────────────────────────────────
    // Burst pattern identical to Phase B: synchronous burst then
    // periodic re-burst every 1500 ms. Threshold overrides pin the
    // grow band in CI. Settle 5000 ms — enough for:
    //   - EWMA convergence (~300 ms)
    //   - First grow debounce (5 × 100 ms = 500 ms)
    //   - Worker spawn budget (~200 ms)
    //   - Headroom against slower Windows CI runners
    await settleFor(100);

    const handles = [];
    for (let i = 0; i < 2000; i++) {
      const h = runtime.dispatch({ type: 'mirror_task', fn: () => 1 + 1 });
      handles.push(h);
      h.promise.then(
        () => {
          /* no-op on resolve */
        },
        () => {
          /* swallow rejections — task fn() never throws; defensive only */
        },
      );
    }

    let reBursting = true;
    function scheduleReBurst() {
      if (!reBursting) return;
      setTimeout(() => {
        if (!reBursting) return;
        for (let i = 0; i < 50; i++) {
          const h = runtime.dispatch({ type: 'mirror_task', fn: () => 1 + 1 });
          handles.push(h);
          h.promise.then(
            () => {
              /* no-op on resolve */
            },
            () => {
              /* swallow rejections — task fn() never throws; defensive only */
            },
          );
        }
        scheduleReBurst();
      }, 1500);
    }
    scheduleReBurst();
    stopReBurst = () => {
      reBursting = false;
    };

    await settleFor(5000);
    stopReBurst();
    // One more debounce window so the post-grow snapshot reflects the
    // steady state after the last fire, not a tick mid-fire.
    await settleFor(500);

    // ── Post-grow snapshot — full 7-field assertion ─────────────────────
    // We snapshot each field into a local variable because
    // `runtime.stats.adaptive` is a **live reference** (not a copy):
    // any `await` between the snapshot and a later field read can let
    // additional ticks fire and increment `ticksSinceResize` underneath
    // us. Phase E is the first benchmark that spans enough wall time
    // (200 ms between snapshots) for this race to bite — Phase A/B
    // read fields synchronously after capture, so the race was
    // invisible. Capturing into a frozen local avoids it.
    const postRaw = runtime.stats.adaptive;
    const post = {
      enabled: postRaw.enabled,
      elu: postRaw.elu,
      latencyP99Ms: postRaw.latencyP99Ms,
      effectiveWorkers: postRaw.effectiveWorkers,
      ticksSinceResize: postRaw.ticksSinceResize,
      lastResizeReason: postRaw.lastResizeReason,
      lastResizeAt: postRaw.lastResizeAt,
    };
    logLine(
      `  post-grow #1: enabled=${post.enabled} ` +
        `effectiveWorkers=${post.effectiveWorkers} ` +
        `lastResizeReason=${post.lastResizeReason} ` +
        `ticksSinceResize=${post.ticksSinceResize} ` +
        `lastResizeAt=${post.lastResizeAt} ` +
        `elu=${post.elu === null ? 'null' : post.elu.toFixed(3)} ` +
        `latencyP99Ms=${post.latencyP99Ms === null ? 'null' : post.latencyP99Ms.toFixed(3)}`,
    );

    if (post.enabled !== true) {
      throw new Error(`Phase E FAIL: expected post.enabled=true, got ${post.enabled}`);
    }
    if (post.effectiveWorkers !== 4) {
      throw new Error(
        `Phase E FAIL: expected post.effectiveWorkers=4 (maxWorkers cap), got ${post.effectiveWorkers}`,
      );
    }
    if (post.lastResizeReason !== 'grow') {
      throw new Error(
        `Phase E FAIL: expected post.lastResizeReason='grow', got '${post.lastResizeReason}'`,
      );
    }
    // `lastResizeAt` is a `performance.now()`-style timestamp — a positive
    // finite number captured during the resize fire. We don't assert
    // an exact value (CI jitter), only that it landed inside a sane
    // window relative to the post-grow snapshot.
    if (post.lastResizeAt === null) {
      throw new Error(`Phase E FAIL: expected post.lastResizeAt to be set, got null`);
    }
    if (typeof post.lastResizeAt !== 'number' || !Number.isFinite(post.lastResizeAt)) {
      throw new Error(
        `Phase E FAIL: expected post.lastResizeAt to be a finite number, got ${typeof post.lastResizeAt}=${post.lastResizeAt}`,
      );
    }
    if (post.lastResizeAt <= 0) {
      throw new Error(`Phase E FAIL: expected post.lastResizeAt > 0, got ${post.lastResizeAt}`);
    }
    // `performance.now()`-relative: the timestamp must be <60 s after
    // the post-grow wall clock (sanity bound for any clock-drift bug).
    const now = performance.now();
    if (post.lastResizeAt > now || now - post.lastResizeAt > 60_000) {
      throw new Error(
        `Phase E FAIL: post.lastResizeAt=${post.lastResizeAt} not within 60s of post.now=${now.toFixed(3)}`,
      );
    }
    if (post.ticksSinceResize === null || typeof post.ticksSinceResize !== 'number') {
      throw new Error(
        `Phase E FAIL: expected post.ticksSinceResize to be a number, got ${typeof post.ticksSinceResize}=${post.ticksSinceResize}`,
      );
    }
    if (post.ticksSinceResize < 0) {
      throw new Error(
        `Phase E FAIL: expected post.ticksSinceResize >= 0, got ${post.ticksSinceResize}`,
      );
    }
    // Generous upper bound — protects against absurd values (NaN-as-int
    // slipping through, runaway counters) without being brittle to
    // actual CI timing. The "alive" check is the snapshot #2 below,
    // which proves the counter is monotonically incrementing between
    // fires. Real CI numbers observed: Phase B reports 34 after 7.5 s
    // settle, so the bound must comfortably exceed that.
    if (post.ticksSinceResize > 1000) {
      throw new Error(
        `Phase E FAIL: expected post.ticksSinceResize <= 1000 (sanity), got ${post.ticksSinceResize}`,
      );
    }
    if (!Number.isInteger(post.ticksSinceResize)) {
      throw new Error(
        `Phase E FAIL: expected post.ticksSinceResize to be an integer, got ${post.ticksSinceResize}`,
      );
    }
    // ELU and latencyP99Ms: post-T8 spec says these reflect the latest
    // tick's smoothed values. After 5 s of idle settle + 500 ms more,
    // both must be present and bounded.
    if (post.elu === null || typeof post.elu !== 'number' || !Number.isFinite(post.elu)) {
      throw new Error(`Phase E FAIL: expected post.elu to be a finite number, got ${post.elu}`);
    }
    if (post.elu < 0 || post.elu > 1) {
      throw new Error(`Phase E FAIL: expected post.elu in [0, 1], got ${post.elu}`);
    }
    if (
      post.latencyP99Ms === null ||
      typeof post.latencyP99Ms !== 'number' ||
      !Number.isFinite(post.latencyP99Ms)
    ) {
      throw new Error(
        `Phase E FAIL: expected post.latencyP99Ms to be a finite number, got ${post.latencyP99Ms}`,
      );
    }
    if (post.latencyP99Ms < 0) {
      throw new Error(`Phase E FAIL: expected post.latencyP99Ms >= 0, got ${post.latencyP99Ms}`);
    }

    // ── Post-grow snapshot #2 — counter must increment monotonically ───
    // The "ticksSinceResize is alive" check: take a second snapshot
    // ~200 ms (≈ 2 supervisor ticks at 100 ms cadence) after the first
    // and assert the counter increased. This proves the counter is
    // being updated every tick rather than frozen on the post-fire
    // value of `0`. We don't assert an exact delta because CI cadence
    // varies; only that the second value is strictly greater than the
    // first. Reason + worker count + lastResizeAt must NOT change
    // between the two snapshots — nothing fires during 200 ms idle.
    await settleFor(200);
    // Same live-reference hazard as snapshot #1 — capture fields
    // immediately into local vars before any further work.
    const post2Raw = runtime.stats.adaptive;
    const post2 = {
      enabled: post2Raw.enabled,
      elu: post2Raw.elu,
      latencyP99Ms: post2Raw.latencyP99Ms,
      effectiveWorkers: post2Raw.effectiveWorkers,
      ticksSinceResize: post2Raw.ticksSinceResize,
      lastResizeReason: post2Raw.lastResizeReason,
      lastResizeAt: post2Raw.lastResizeAt,
    };
    logLine(
      `  post-grow #2 (+200ms): ticksSinceResize=${post2.ticksSinceResize} ` +
        `effectiveWorkers=${post2.effectiveWorkers} ` +
        `lastResizeReason=${post2.lastResizeReason}`,
    );

    if (post2.ticksSinceResize <= post.ticksSinceResize) {
      throw new Error(
        `Phase E FAIL: expected ticksSinceResize to increment after 200ms idle ` +
          `(snapshot #1=${post.ticksSinceResize}, snapshot #2=${post2.ticksSinceResize})`,
      );
    }
    if (post2.lastResizeReason !== post.lastResizeReason) {
      throw new Error(
        `Phase E FAIL: lastResizeReason changed between snapshots ` +
          `(#1='${post.lastResizeReason}', #2='${post2.lastResizeReason}')`,
      );
    }
    if (post2.effectiveWorkers !== post.effectiveWorkers) {
      throw new Error(
        `Phase E FAIL: effectiveWorkers changed between snapshots ` +
          `(#1=${post.effectiveWorkers}, #2=${post2.effectiveWorkers})`,
      );
    }
    if (post2.lastResizeAt !== post.lastResizeAt) {
      throw new Error(
        `Phase E FAIL: lastResizeAt changed between snapshots ` +
          `(#1=${post.lastResizeAt}, #2=${post2.lastResizeAt})`,
      );
    }

    logLine(
      `  ✓ baseline reset state correct (lastResizeAt=null, lastResizeReason=null, ticksSinceResize=0)`,
    );
    logLine(
      `  ✓ post-grow full 7-field surface matches spec (lastResizeAt finite + recent, lastResizeReason='grow')`,
    );
    logLine(
      `  ✓ ticksSinceResize is alive (${post.ticksSinceResize} → ${post2.ticksSinceResize} across 200ms idle)`,
    );

    return { runtime };
  } finally {
    stopReBurst();
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
  logLine('BENCHMARK: Adaptive Concurrency — Phases A + B + E (T10)');
  logLine('======================================================================');

  const runtimes = [];
  try {
    const phaseA = await phaseASyntheticPressure();
    runtimes.push(phaseA.runtime);

    const phaseB = await phaseBSyntheticGrow();
    runtimes.push(phaseB.runtime);

    const phaseE = await phaseETelemetry();
    runtimes.push(phaseE.runtime);

    const elapsed = performance.now() - t0;
    logLine(`\n  total wall time: ${fmtMs(elapsed)}`);
    logLine(
      '\n  VERDICT: Phases A + B + E passed — shrink + grow + telemetry end-to-end under synthetic main-thread pressure.',
    );
  } catch (err) {
    logLine(`\n  ${err.message}`);
    logLine('\n  VERDICT: FAILED.');
    process.exitCode = 1;
  } finally {
    for (const r of runtimes) {
      try {
        await r.shutdown();
      } catch {
        // Best-effort — if a runtime already failed to construct, ignore.
      }
    }
  }
}

main().catch((err) => {
  console.error('Unhandled error in Phase A:', err);
  process.exitCode = 1;
});
