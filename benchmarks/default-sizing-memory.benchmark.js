import { availableParallelism } from 'node:os';
import { createWorkerRuntime } from '../src/index.js';

/**
 * ADR-0019 memory benchmark — proves the default `workers = 1` choice
 * saves substantial RSS on multi-core hosts versus the legacy
 * `availableParallelism() - 1` default.
 *
 * Methodology:
 *   1. Capture process RSS at startup.
 *   2. Boot a runtime with `workers: 1` (the new ADR-0019 default).
 *   3. Capture RSS after warm-up; let V8 settle; sample peak RSS.
 *   4. Tear down; reboot a runtime with `workers: availableParallelism() - 1`
 *      (the legacy default).
 *   5. Capture RSS again.
 *   6. Compare and assert the new default saves a meaningful amount of RSS
 *      *per extra worker*, plus a fixed absolute floor.
 *
 * On the ratio assertion: the legacy pool size is `cores - 1`, so the
 * memory ratio is a **function of the host's core count**, not a
 * constant. A 28-core workstation gives ~27 legacy workers and a ratio
 * in the double digits; a 4-core CI runner gives 3 workers and ~1.4×.
 * A fixed ratio threshold (this file previously required 2×, while its
 * own docstring claimed 5×) therefore encodes the benchmark author's
 * hardware, not the property ADR-0019 actually asserts. It failed on
 * `macos-latest` in CI run 36415949248 with `ratio 1.46x < 2x` even
 * though the direction was correct and the absolute saving was 28.6 MB.
 *
 * The invariant that IS hardware-independent is **marginal cost per
 * worker**: each additional worker thread costs real RSS, and ADR-0019's
 * whole point is to not pay that by default. That is what is asserted
 * now, together with a small absolute floor so a trivially small pool
 * cannot pass by arithmetic accident.
 */

function rss() {
  return process.memoryUsage().rss;
}

async function settle() {
  // Let the V8 runtime warm up; small delay + microtask drain.
  if (global.gc) global.gc();
  await new Promise((r) => setTimeout(r, 100));
}

async function measureWith(workers) {
  const startupRss = rss();
  const runtime = await createWorkerRuntime({ workers });
  await settle();
  const warmRss = rss();
  // Run a few small tasks so the pool is fully exercised.
  await Promise.all(
    Array.from({ length: 16 }).map((_, i) =>
      runtime.execute({ type: 'noop', payload: { i }, fn: (p) => p.i + 1 }),
    ),
  );
  await settle();
  const peakRss = rss();
  await runtime.shutdown();
  await settle();
  const shutdownRss = rss();

  return { startupRss, warmRss, peakRss, shutdownRss };
}

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: ADR-0019 default worker pool size — RSS comparison');
  console.log('=====================================================================\n');

  const cores = availableParallelism();
  console.log(`  Host cores: ${cores}\n`);

  console.log(`  Phase A: default (ADR-0019) — workers = 1`);
  const a = await measureWith(1);
  console.log(`    startup RSS:     ${(a.startupRss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    warm-up RSS:     ${(a.warmRss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    peak RSS:        ${(a.peakRss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    post-shutdown:   ${(a.shutdownRss / 1024 / 1024).toFixed(1)} MB\n`);

  const legacyCount = Math.max(1, cores - 1);
  console.log(`  Phase B: legacy default — workers = ${legacyCount}`);
  const b = await measureWith(legacyCount);
  console.log(`    startup RSS:     ${(b.startupRss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    warm-up RSS:     ${(b.warmRss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    peak RSS:        ${(b.peakRss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    post-shutdown:   ${(b.shutdownRss / 1024 / 1024).toFixed(1)} MB\n`);

  // Degenerate only when the legacy default would be indistinguishable
  // from the new one, i.e. `cores - 1 <= 1`. At 4 cores the legacy pool
  // is 3 workers — a real, measurable difference, so it must be asserted.
  // (The previous guard used `cores <= 4` and its comment claimed the
  // legacy default "falls back to 1 worker", which is simply wrong: it
  // falls back at `cores <= 2`.)
  if (legacyCount <= 1) {
    console.log(
      `  DEGENERATE: legacy default also yields ${legacyCount} worker(s) on this ` +
        `${cores}-core host, so there is nothing to compare.`,
    );
    console.log('  Exiting 0 (no assertion to fail).\n');
    return;
  }

  const savingsMb = (b.peakRss - a.peakRss) / 1024 / 1024;
  const ratio = b.peakRss / a.peakRss;
  console.log(`  Comparison (peak RSS):`);
  console.log(`    legacy - ADR-0019 = ${savingsMb.toFixed(1)} MB saved`);
  console.log(`    ratio (legacy / new) = ${ratio.toFixed(2)}x`);
  console.log(`    extra workers      = ${legacyCount - 1}\n`);

  // 1. Direction. The new default must never cost MORE than the legacy
  //    default. This is the core ADR-0019 claim and is hardware-independent.
  if (savingsMb <= 0) {
    console.error(
      `  FAIL: ADR-0019 default is not cheaper than legacy ` +
        `(${savingsMb.toFixed(1)} MB — legacy used ${((b.peakRss - a.peakRss) / 1024 / 1024).toFixed(1)} MB LESS). ` +
        `This benchmark used to be the justification for the ADR; investigate.`,
    );
    process.exit(1);
  }

  // 2. Marginal cost per extra worker. This is the hardware-independent
  //    invariant: each worker thread has a real, measurable RSS cost, and
  //    that cost is exactly what ADR-0019 avoids paying by default.
  //    A 4-core CI runner (3 extra workers) and a 28-core workstation
  //    (27 extra workers) both satisfy this; a fixed ratio does not.
  const mbPerWorker = savingsMb / (legacyCount - 1);
  console.log(`    marginal cost      = ${mbPerWorker.toFixed(1)} MB per extra worker\n`);

  const MIN_MB_PER_WORKER = 2.0;
  if (mbPerWorker < MIN_MB_PER_WORKER) {
    console.error(
      `  FAIL: marginal RSS cost is only ${mbPerWorker.toFixed(2)} MB per worker ` +
        `(budget: ${MIN_MB_PER_WORKER} MB). Worker threads should each cost real memory; ` +
        `if they no longer do, this benchmark is no longer measuring what it claims.`,
    );
    process.exit(1);
  }

  // 3. Absolute floor, so a 2-worker pool cannot pass on arithmetic
  //    accident alone. Kept low because the whole saving scales with
  //    `legacyCount`.
  const MIN_SAVINGS_MB = 5;
  if (savingsMb < MIN_SAVINGS_MB) {
    console.error(
      `  FAIL: total saving is only ${savingsMb.toFixed(1)} MB across ${legacyCount - 1} extra workers ` +
        `(budget: ${MIN_SAVINGS_MB} MB).`,
    );
    process.exit(1);
  }

  console.log(
    `  ✓ ADR-0019 default saves ${savingsMb.toFixed(1)} MB ` +
      `(${mbPerWorker.toFixed(1)} MB/worker over ${legacyCount - 1} extra workers).`,
  );
  console.log(
    `    The ratio is ${ratio.toFixed(2)}x and is host-dependent by construction ` +
      `(legacy pool = cores - 1), so it is reported rather than asserted.`,
  );
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
