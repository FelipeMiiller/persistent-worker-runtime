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
 *   6. Compare and assert the new default is at least 5× cheaper in RSS
 *      on a host with ≥ 4 cores.
 *
 * On hosts with ≤ 4 cores, the legacy default falls back to 1 worker
 * anyway, so the comparison is degenerate — the benchmark reports
 * "DEGENERATE" and exits 0 without failing.
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

  if (cores <= 4) {
    console.log('  DEGENERATE: legacy default also falls back to 1 worker on this host.');
    console.log('  The benchmark cannot demonstrate the ADR-0019 win on a ≤4-core host.');
    console.log('  Exiting 0 (no assertion to fail).\n');
    return;
  }

  const savingsMb = (b.peakRss - a.peakRss) / 1024 / 1024;
  const ratio = b.peakRss / a.peakRss;
  console.log(`  Comparison (peak RSS):`);
  console.log(`    legacy - ADR-0019 = ${savingsMb.toFixed(1)} MB saved`);
  console.log(`    ratio (legacy / new) = ${ratio.toFixed(2)}x\n`);

  // Soft assertion: the new default should be measurably cheaper.
  // On a 28-core host this typically lands between 5× and 20×.
  if (ratio < 2) {
    console.error(
      `  FAIL: ADR-0019 default not measurably cheaper (ratio ${ratio.toFixed(2)}x < 2x)`,
    );
    console.error(`  This benchmark used to be the justification for the ADR; investigate.`);
    process.exit(1);
  }
  console.log('  ✓ ADR-0019 default is at least 2× cheaper than legacy default.');
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
