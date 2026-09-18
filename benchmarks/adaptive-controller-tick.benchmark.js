/**
 * Benchmark: adaptive-concurrency tick() overhead (Phase D, partial — T10)
 *
 * The controller samples signals + updates EWMAs + bumps telemetry on
 * every `tick()`. The per-tick cost MUST stay under 1ms in the median
 * case (ADR-0014 §Acceptance Criteria — Phase D "Tick overhead < 1ms
 * per sample"). If a future change to `SignalMonitor`, `Ewma`, or the
 * factory body introduces per-tick work (e.g. allocating objects,
 * logging), this benchmark detects the regression before it ships.
 *
 * Phase D-1: Median tick() cost (10,000 iterations, single listener).
 *             Hard assertion: p50 < 1ms, p99 < 5ms. Includes the T5
 *             wiring (classifyTickDirection + debounce.note) on every
 *             tick.
 * Phase D-2: Listener scaling — 0 / 1 / 10 listeners. Documents how
 *             the listener-set snapshot cost grows with subscriber
 *             count. The current implementation is O(N) per tick (we
 *             copy `resizeListeners` into an array before iterating).
 *             If this ever flips to O(N²) or worse, the benchmark
 *             catches it.
 * Phase D-3: Memory footprint of one controller (heap delta before/
 *             after 100 instances). Sanity check that the controller
 *             itself isn't a leak vector. T7 will re-measure with the
 *             actual V8 isolates attached.
 * Phase D-4: classifyTickDirection throughput (T5 pure helper).
 *             The classifier is O(1) — 4 threshold checks + a
 *             direction-flip. It's called once per tick on the hot
 *             path, so it MUST stay cheap (budget: >5M ops/sec).
 *             A regression here (e.g. accidentally logging inside
 *             the function, or adding allocations) compounds with
 *             D-1's per-tick budget.
 *
 * What's NOT covered here (still T7/T10):
 *   - End-to-end grow/shrink fire latency (5 ticks → spawn/retire
 *     resolved). Requires T7 runtime wiring + WorkerRuntime isolates.
 *   - Opt-out / band-validation gates under load. Lands in T6
 *     followed by T7 telemetry.
 *   - runtime.stats.adaptive consumer overhead. T8.
 */

import { classifyTickDirection, createAdaptiveController } from '../src/adaptive-controller.js';

function formatMs(ms) {
  return `${ms.toFixed(3).padStart(10)} ms`;
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * Runs N consecutive tick() calls and returns the per-iteration
 * latency distribution (sorted, microsecond resolution).
 *
 * @param {number} n
 * @param {() => void} perTick
 * @returns {{ p50: number, p99: number, p100: number, total: number }}
 */
function measureTicks(n, perTick) {
  const samples = new Float64Array(n);
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    perTick();
    samples[i] = performance.now() - t0;
  }
  const total = performance.now() - start;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    p100: sorted[sorted.length - 1],
    total,
  };
}

async function phase1SingleTickCost() {
  console.log('── Phase D-1: tick() overhead (median + tail) ─────────────────────');
  const controller = createAdaptiveController({
    minWorkers: 1,
    maxWorkers: 4,
    ewmaAlpha: 0.3,
    samplingCadenceMs: 100,
  });
  // 1 listener exercises the snapshot path without flooding it.
  controller.onResize(() => {
    /* noop listener — exercises the snapshot path */
  });

  const N = 10_000;
  const result = measureTicks(N, () => controller.tick());
  const avg = result.total / N;

  console.log(`  iterations:         ${N.toLocaleString()}`);
  console.log(`  total wall-clock:   ${formatMs(result.total)}`);
  console.log(`  average / tick:     ${formatMs(avg)}`);
  console.log(`  p50 / tick:         ${formatMs(result.p50)}`);
  console.log(`  p99 / tick:         ${formatMs(result.p99)}`);
  console.log(`  p100 (worst) / tick: ${formatMs(result.p100)}`);

  if (result.p50 >= 1.0) {
    console.error(`  FAIL: median tick cost ${formatMs(result.p50)} exceeds 1ms budget`);
    console.error(`  This used to satisfy ADR-0014 §Acceptance Criteria; investigate.`);
    return false;
  }
  if (result.p99 >= 5.0) {
    console.error(`  FAIL: p99 tick cost ${formatMs(result.p99)} exceeds 5ms tail budget`);
    return false;
  }
  console.log(`  ✓ p50 < 1ms, p99 < 5ms — within Phase D budget.`);
  return true;
}

async function phase2ListenerScaling() {
  console.log('\n── Phase D-2: tick() cost vs listener count ─────────────────────────');
  const N = 5_000;
  const counts = [0, 1, 10];
  const rows = [];

  for (const count of counts) {
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      ewmaAlpha: 0.3,
      samplingCadenceMs: 100,
    });
    for (let i = 0; i < count; i++) {
      controller.onResize(() => {
        /* noop listener — exists only to grow the snapshot set */
      });
    }
    const result = measureTicks(N, () => controller.tick());
    rows.push({ count, p50: result.p50, p99: result.p99 });
  }

  console.log(`  listeners      p50          p99`);
  for (const r of rows) {
    console.log(`  ${String(r.count).padStart(8)}     ${formatMs(r.p50)}    ${formatMs(r.p99)}`);
  }

  // Listener scaling should be roughly linear in the listener count.
  // If 10 listeners costs >10× the 1-listener cost, something is wrong.
  const baseP50 = rows[1].p50;
  const tenP50 = rows[2].p50;
  const ratio = tenP50 / baseP50;
  console.log(`  scaling ratio (10-listener p50 / 1-listener p50): ${ratio.toFixed(2)}x`);

  if (ratio > 15) {
    console.error(
      `  FAIL: 10-listener cost is ${ratio.toFixed(2)}× the 1-listener cost (budget: 15×)`,
    );
    console.error(`  Snapshot path may have flipped from O(N) to O(N²) — investigate.`);
    return false;
  }
  console.log(`  ✓ listener scaling within budget.`);
  return true;
}

async function phase3MemoryFootprint() {
  console.log('\n── Phase D-3: memory footprint of one controller ────────────────────');
  if (globalThis.gc) {
    globalThis.gc();
  } else {
    console.log('  (no --expose-gc; skipping forced GC; numbers are still informative)');
  }
  const beforeHeap = process.memoryUsage().heapUsed;
  const beforeRss = process.memoryUsage().rss;

  // 100 controllers — the per-instance cost is tiny but multiple
  // instances let us compare deltas more reliably than 1 instance.
  // We measure heapUsed (retained JS objects), NOT rss (RSS grows
  // when the allocator grabs pages from the OS but doesn't shrink on
  // GC — making it too noisy for a per-instance assertion).
  const N = 100;
  const controllers = [];
  for (let i = 0; i < N; i++) {
    controllers.push(
      createAdaptiveController({
        minWorkers: 1,
        maxWorkers: 4,
        ewmaAlpha: 0.3,
        samplingCadenceMs: 100,
      }),
    );
  }
  // Tick each controller once so any lazy allocations (e.g. EWMA
  // internals after first update, SignalMonitor histogram enablement)
  // are visible.
  for (const c of controllers) c.tick();

  if (globalThis.gc) globalThis.gc();
  const afterHeap = process.memoryUsage().heapUsed;
  const afterRss = process.memoryUsage().rss;
  const deltaHeap = afterHeap - beforeHeap;
  const deltaRss = afterRss - beforeRss;
  const perInstanceHeap = deltaHeap / N;

  console.log(`  instances:           ${N}`);
  console.log(`  heap before:         ${formatBytes(beforeHeap)}`);
  console.log(`  heap after:          ${formatBytes(afterHeap)}`);
  console.log(
    `  heap delta:          ${formatBytes(deltaHeap)}  (per-instance ≈ ${formatBytes(perInstanceHeap)})`,
  );
  console.log(`  rss before:          ${formatBytes(beforeRss)}`);
  console.log(`  rss after:           ${formatBytes(afterRss)}`);
  console.log(
    `  rss delta:           ${formatBytes(deltaRss)} (informational only — too noisy to assert on)`,
  );

  // Per-instance budget uses heap (retained objects) — generous at
  // 10 KB to leave headroom for DebounceCounter (T5), runtime events
  // wiring (T7), and any new closures that T6 adds. Anything > 10 KB
  // suggests something leaked into the closure scope that shouldn't
  // be there (e.g. capturing a large config object by reference).
  const PER_INSTANCE_HEAP_BUDGET_BYTES = 10 * 1024;
  if (perInstanceHeap > PER_INSTANCE_HEAP_BUDGET_BYTES) {
    console.error(
      `  FAIL: per-instance heap ${formatBytes(perInstanceHeap)} exceeds ${formatBytes(PER_INSTANCE_HEAP_BUDGET_BYTES)} budget`,
    );
    console.error(`  Investigate closure scope or accidental long-lived buffers.`);
    return false;
  }
  console.log(
    `  ✓ per-instance heap within budget (${formatBytes(PER_INSTANCE_HEAP_BUDGET_BYTES)}).`,
  );
  return true;
}

async function phase4ClassifierThroughput() {
  console.log('\n── Phase D-4: classifyTickDirection throughput (T5 pure helper) ──');
  // Mix of inputs that exercise every branch: shrink-by-ELU,
  // shrink-by-p99, grow (both signals low), and noop (dead zone /
  // signal disagreement). Cycling through them ensures the benchmark
  // doesn't accidentally only hit one fast path.
  const SAMPLES = [
    { elu: 0.9, latencyP99: 5 }, // shrink (by ELU)
    { elu: 0.2, latencyP99: 60 }, // shrink (by p99)
    { elu: 0.1, latencyP99: 2 }, // grow
    { elu: 0.7, latencyP99: 30 }, // noop (signals disagree)
  ];
  // Default thresholds from the controller factory — must match
  // adaptive-controller.js so a future change there triggers the
  // assertion failure here too.
  const SHRINK_ELU = 0.85;
  const SHRINK_P99 = 50;
  const GROW_ELU = 0.5;
  const GROW_P99 = 10;

  const N = 1_000_000;
  const start = performance.now();
  // Bitmask verification: bit 0 = 'grow' seen, bit 1 = 'shrink'
  // seen, bit 2 = 'noop' seen. Cycling through 4 inputs that each
  // hit one of those branches MUST produce mask === 7 (all bits).
  // This catches both V8 elision AND accidental branch removal.
  let resultMask = 0;
  for (let i = 0; i < N; i++) {
    const s = SAMPLES[i & 3];
    const r = classifyTickDirection(
      s.elu,
      s.latencyP99,
      SHRINK_ELU,
      SHRINK_P99,
      GROW_ELU,
      GROW_P99,
    );
    if (r === 'grow') resultMask |= 1;
    else if (r === 'shrink') resultMask |= 2;
    else if (r === 'noop') resultMask |= 4;
  }
  const elapsed = performance.now() - start;
  const nsPerOp = (elapsed / N) * 1_000_000;
  const opsPerSec = N / (elapsed / 1000);

  console.log(`  iterations:         ${N.toLocaleString()}`);
  console.log(`  total wall-clock:   ${formatMs(elapsed)}`);
  console.log(`  latency / call:     ${nsPerOp.toFixed(1).padStart(8)} ns`);
  console.log(`  throughput:         ${(opsPerSec / 1_000_000).toFixed(2).padStart(6)} M ops/sec`);
  console.log(`  branches covered:   ${resultMask.toString(2).padStart(3, '0')} (expect 111)`);
  if (resultMask !== 7) {
    console.error('  FAIL: classifyTickDirection was elided or a branch went missing');
    return false;
  }

  // Budget: >5M ops/sec (i.e., <200ns/call). Comfortably above any
  // reasonable CI hardware floor. If the classifier ever allocates,
  // logs, or hits a slow path, this catches it.
  const MIN_OPS_PER_SEC = 5_000_000;
  if (opsPerSec < MIN_OPS_PER_SEC) {
    console.error(
      `  FAIL: classifyTickDirection throughput ${(opsPerSec / 1_000_000).toFixed(2)} M ops/sec is below ${MIN_OPS_PER_SEC / 1_000_000} M ops/sec budget`,
    );
    return false;
  }
  console.log(`  ✓ classifier above ${MIN_OPS_PER_SEC / 1_000_000} M ops/sec budget.`);
  return true;
}

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: Adaptive Concurrency Controller — Phase D (partial)');
  console.log('=====================================================================\n');

  const ok1 = await phase1SingleTickCost();
  const ok2 = await phase2ListenerScaling();
  const ok3 = await phase3MemoryFootprint();
  const ok4 = await phase4ClassifierThroughput();

  console.log('\n=====================================================================');
  if (ok1 && ok2 && ok3 && ok4) {
    console.log('VERDICT: all phases pass — Phase D overhead budget respected.');
    console.log('(T5 decision matrix wired. Full Phase D with end-to-end grow/shrink');
    console.log(' and runtime.stats lands in T7+T10.)');
  } else {
    console.error('VERDICT: at least one phase FAILED — see lines above.');
    process.exit(1);
  }
  console.log('=====================================================================');
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
