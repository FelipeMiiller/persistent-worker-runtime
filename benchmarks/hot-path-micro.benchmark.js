import { createWorkerRuntime, Supervisor, WorkerHandle } from '../src/index.js';
import { TaskHandle } from '../src/task-handle.js';

// Micro-benchmark suite — measures raw overhead of hot paths on the
// main thread. Designed to surface regressions in:
//   1. dispatch() — called once per task (hottest path)
//   2. TaskHandle constructor — allocates per task
//   3. snapshot() — called by getWorkers() / stats.workers
//   4. stats getter — called by dashboards / Prometheus scrapers
//   5. findWorkerForTask — called per dispatch (internal)
//
// Methodology:
//   - Burst-then-idle pattern from T10-B lessons (memory: setImmediate
//     chain saturates main thread).
//   - Synchronous warm-up + measured window.
//   - Report p50 / p99 / mean (in microseconds) so regressions surface
//     without noise from a single outlier.
//   - process.exit(1) on regression thresholds (per AGENTS.md hard
//     assertion rule).
//
// Exit code:
//   0 — all budgets met (no regression)
//   1 — at least one budget breached (regression detected)

const REGRESSION_BUDGETS = {
  // Each budget is "p99 over 10k iterations must stay under X us".
  // These are initial baselines — tighten in follow-up commits as the
  // perf surface stabilizes.
  dispatchOverheadUs: 500, // dispatch() + scanFnDeps + TaskHandle alloc
  taskHandleAllocUs: 200, // TaskHandle constructor alone
  snapshotOverheadUs: 50, // WorkerHandle.snapshot()
  statsGetterUs: 100, // runtime.stats getter
  findWorkerUs: 100, // supervisor.findWorkerForTask
};

const ITERATIONS = 10_000;

function percentile(sortedArr, p) {
  const idx = Math.floor((sortedArr.length * p) / 100);
  return sortedArr[Math.min(idx, sortedArr.length - 1)];
}

function measure(fn, iters = ITERATIONS) {
  const samples = new Array(iters);
  // Warm-up
  for (let i = 0; i < 1000; i++) fn();
  // Measured window — capture start/end with high-resolution timer.
  for (let i = 0; i < iters; i++) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    samples[i] = Number(end - start) / 1000; // ns → μs
  }
  samples.sort((a, b) => a - b);
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples[samples.length - 1],
    min: samples[0],
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
}

function fmt(name, stats, budgetUs) {
  const tag = stats.p99 <= budgetUs ? 'PASS' : 'FAIL';
  return (
    `[${tag}] ${name.padEnd(28)} ` +
    `p50=${stats.p50.toFixed(2)}μs ` +
    `p95=${stats.p95.toFixed(2)}μs ` +
    `p99=${stats.p99.toFixed(2)}μs ` +
    `max=${stats.max.toFixed(2)}μs ` +
    `(budget: p99 ≤ ${budgetUs}μs)`
  );
}

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('MICRO-BENCHMARK: Hot-path overhead on the main thread');
  console.log('=====================================================================\n');
  console.log(`Iterations per measurement: ${ITERATIONS}`);
  console.log(`Methodology: 1k warm-up, then burst-then-${ITERATIONS}k samples\n`);

  const failures = [];

  // ─── 1. TaskHandle constructor (no dispatch, no worker) ──────────────
  {
    const stats = measure(() => {
      // biome-ignore lint/correctness/noUnusedVariables: instantiation triggers side effect
      const t = new TaskHandle({ fn: () => 1 });
    });
    const line = fmt('TaskHandle constructor', stats, REGRESSION_BUDGETS.taskHandleAllocUs);
    console.log(line);
    if (stats.p99 > REGRESSION_BUDGETS.taskHandleAllocUs) failures.push(line);
  }

  // ─── 2. dispatch() overhead (sync path, no actual task execution) ────
  {
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      // We can't dispatch-then-collect in a tight loop (workers can't
      // keep up) — so we measure dispatch() SYNCHRONOUSLY (just the
      // setup, before the queue enqueue) and let the Event Loop drain
      // the queue at the end. .catch on each handle so pending tasks
      // rejected by shutdown don't pollute the run with unhandled
      // rejections.
      const stats = measure(() => {
        const handle = runtime.dispatch({ fn: () => 1 });
        handle.promise.catch(() => undefined);
      });
      const line = fmt(
        'runtime.dispatch() (sync part)',
        stats,
        REGRESSION_BUDGETS.dispatchOverheadUs,
      );
      console.log(line);
      if (stats.p99 > REGRESSION_BUDGETS.dispatchOverheadUs) failures.push(line);
    } finally {
      await runtime.shutdown();
    }
  }

  // ─── 3. WorkerHandle.snapshot() overhead ──────────────────────────────
  {
    const w = new WorkerHandle();
    await w.waitUntilReady();
    const stats = measure(() => w.snapshot());
    const line = fmt('WorkerHandle.snapshot()', stats, REGRESSION_BUDGETS.snapshotOverheadUs);
    console.log(line);
    if (stats.p99 > REGRESSION_BUDGETS.snapshotOverheadUs) failures.push(line);
    await w.terminate();
  }

  // ─── 4. runtime.stats getter overhead ─────────────────────────────────
  {
    const runtime = await createWorkerRuntime({ workers: 4 });
    try {
      const stats = measure(() => runtime.stats);
      const line = fmt('runtime.stats (getter)', stats, REGRESSION_BUDGETS.statsGetterUs);
      console.log(line);
      if (stats.p99 > REGRESSION_BUDGETS.statsGetterUs) failures.push(line);
    } finally {
      await runtime.shutdown();
    }
  }

  // ─── 5. supervisor.findWorkerForTask overhead ─────────────────────────
  {
    const supervisor = new Supervisor({ workers: 4 });
    await supervisor.start();
    // Stub task object — only fields used by findWorkerForTask.
    const stubTask = { affinityKey: null };
    const stats = measure(() => supervisor.findWorkerForTask(stubTask));
    const line = fmt('supervisor.findWorkerForTask', stats, REGRESSION_BUDGETS.findWorkerUs);
    console.log(line);
    if (stats.p99 > REGRESSION_BUDGETS.findWorkerUs) failures.push(line);
    await supervisor.shutdown();
  }

  console.log('\n=====================================================================');
  if (failures.length === 0) {
    console.log('VERDICT: PASSED — all hot-path budgets met.');
    process.exit(0);
  } else {
    console.log(`VERDICT: FAILED — ${failures.length} budget(s) breached:`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
}

runBenchmark().catch((err) => {
  console.error('Benchmark crashed:', err);
  process.exit(1);
});
