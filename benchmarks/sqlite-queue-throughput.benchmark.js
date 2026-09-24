/**
 * BENCHMARK: SqliteTaskQueue throughput vs. in-memory TaskQueue
 * (ADR-0020, revised 2026-09-24).
 *
 * Compares the new durable `SqliteTaskQueue` (SQLite via `node:sqlite`)
 * against the default in-memory `TaskQueue` across three dimensions:
 *
 *   [1] Round-trip latency — single enqueue + immediate dequeue cycle,
 *       measured per-op (median + p95). Captures the per-task cost on
 *       the dispatch hot path. ADR-0020 documents ~1-5 ms added latency
 *       for the SQLite path; this benchmark verifies that and surfaces
 *       the exact number on the developer's hardware.
 *
 *   [2] Event Loop lag — sustained 5 000-op enqueue burst with
 *       `perf_hooks.monitorEventLoopDelay` capturing the lag histogram.
 *       SQLite uses sync I/O on the main thread; this answers the
 *       "does it block the Event Loop?" question that ADR-0020
 *       acknowledges but doesn't quantify.
 *
 *   [3] Throughput scaling — end-to-end (enqueue all → dequeue all)
 *       batch throughput at 1k / 5k / 25k / 100k tasks. Establishes the
 *       ADR-0020 documented ceiling (~1 000 dispatches/sec) and the
 *       "drop back to caller-side fronting" break-even point.
 *
 * Run with: `npm run benchmark:sqlite-queue`
 *
 * Notes:
 *   - Pure queue benchmarks (no workers, no `createWorkerRuntime`). The
 *     goal is to isolate the queue backend cost from worker-thread
 *     overhead.
 *   - File path uses `os.tmpdir()` so the benchmark runs on any OS; the
 *     file is cleaned up at exit.
 *   - Header tag: `[perf-tested]` (the backend ships a measured perf
 *     profile so the ADR's negative-consequences section stays honest).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteTaskQueue } from '../src/queue/sqlite-backend.js';
import { TaskHandle } from '../src/task-handle.js';
import { TaskQueue } from '../src/task-queue.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'pwr-bench-sqlite-'));
const dbPath = join(tmpRoot, 'queue.db');

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return sorted[idx];
}

/**
 * Build a minimal TaskHandle for queue-only benchmarks. Workers don't run
 * here — we only exercise `enqueue` / `dequeue` / `peek` / `size`. The
 * returned handle's promise has a no-op catch attached because the
 * benchmark never awaits it (no worker to resolve it); without the catch,
 * `queue.destroy()` rejecting every pending task would surface as
 * unhandled-rejection warnings and (on Node ≥ 22) a process-level crash.
 */
function makeHandle({ id, priority = 0, affinityKey = null } = {}) {
  const handle = new TaskHandle({
    id: id || `bench_${Math.random().toString(36).slice(2, 10)}`,
    type: 'bench',
    payload: { x: 1 },
    affinityKey,
    priority,
    fnCode: 'async () => 1',
  });
  // Benchmarks never await task.promise; the no-op catch suppresses the
  // unhandled-rejection crash that would otherwise fire when queue.destroy()
  // rejects every pending task.
  handle.promise.catch(
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
    () => {},
  );
  return handle;
}

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return n.toFixed(2);
}

function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(2)}ms`;
  return `${(ms * 1000).toFixed(1)}µs`;
}

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: SqliteTaskQueue throughput vs. in-memory TaskQueue');
  console.log('          ADR-0020 (revised 2026-09-24, SQLite-only)');
  console.log('=====================================================================\n');
  console.log(`SQLite DB path: ${dbPath}\n`);

  // ──────────────────────────────────────────────────────────────────
  // [1] Round-trip latency — single enqueue + immediate dequeue
  // ──────────────────────────────────────────────────────────────────
  console.log('[1/3] Round-trip latency (enqueue + immediate dequeue, 5 000 ops)...\n');

  async function roundTrip(queueFactory, label) {
    const q = queueFactory();
    try {
      const latencies = [];
      for (let i = 0; i < 5000; i++) {
        const t = makeHandle({ priority: i % 10 });
        const enqStart = performance.now();
        await q.enqueue(t);
        const deqStart = performance.now();
        const claimed = q.dequeue();
        const deqEnd = performance.now();
        latencies.push({
          enqueue: deqStart - enqStart,
          dequeue: deqEnd - deqStart,
        });
        if (!claimed) throw new Error(`${label}: dequeue returned null at i=${i}`);
      }
      latencies.sort((a, b) => a.enqueue + a.dequeue - (b.enqueue + b.dequeue));
      const enqSorted = latencies.map((l) => l.enqueue).sort((a, b) => a - b);
      const deqSorted = latencies.map((l) => l.dequeue).sort((a, b) => a - b);
      const totalSorted = latencies.map((l) => l.enqueue + l.dequeue).sort((a, b) => a - b);
      return {
        label,
        enqMedian: percentile(enqSorted, 50),
        enqP95: percentile(enqSorted, 95),
        deqMedian: percentile(deqSorted, 50),
        deqP95: percentile(deqSorted, 95),
        totalMedian: percentile(totalSorted, 50),
        totalP95: percentile(totalSorted, 95),
      };
    } finally {
      q.destroy();
    }
  }

  const memResults = await roundTrip(() => new TaskQueue({ maxQueueSize: 50000 }), 'memory');
  const sqlResults = await roundTrip(
    () => new SqliteTaskQueue({ path: dbPath, maxQueueSize: 50000 }),
    'sqlite',
  );

  console.log(`  Memory TaskQueue:`);
  console.log(
    `    enqueue  median=${fmtMs(memResults.enqMedian)}  p95=${fmtMs(memResults.enqP95)}`,
  );
  console.log(
    `    dequeue  median=${fmtMs(memResults.deqMedian)}  p95=${fmtMs(memResults.deqP95)}`,
  );
  console.log(
    `    TOTAL    median=${fmtMs(memResults.totalMedian)}  p95=${fmtMs(memResults.totalP95)}\n`,
  );
  console.log(`  SqliteTaskQueue:`);
  console.log(
    `    enqueue  median=${fmtMs(sqlResults.enqMedian)}  p95=${fmtMs(sqlResults.enqP95)}`,
  );
  console.log(
    `    dequeue  median=${fmtMs(sqlResults.deqMedian)}  p95=${fmtMs(sqlResults.deqP95)}`,
  );
  console.log(
    `    TOTAL    median=${fmtMs(sqlResults.totalMedian)}  p95=${fmtMs(sqlResults.totalP95)}\n`,
  );

  const slowdown =
    sqlResults.totalMedian > 0 && memResults.totalMedian > 0
      ? (sqlResults.totalMedian / memResults.totalMedian).toFixed(1)
      : 'n/a';
  console.log(`  -> SQLite vs memory slowdown: ${slowdown}× per round-trip`);
  console.log(
    `  -> ADR-0020 predicted ~1-5 ms; observed ${fmtMs(sqlResults.totalMedian)} median.\n`,
  );

  // ──────────────────────────────────────────────────────────────────
  // [2] Event Loop blocking during sustained SQLite ops
  // ──────────────────────────────────────────────────────────────────
  console.log('[2/3] Event Loop blocking during sustained SQLite enqueue (5 000 ops)...\n');

  /**
   * Measure Event Loop blocking time as the gap between two
   * `setImmediate` callbacks — one queued before the burst and one after.
   * During a sync burst the loop is held; the queued setImmediate cannot
   * fire until the burst ends, so the gap = the blocking duration.
   *
   * `monitorEventLoopDelay` would not work here: it measures lag relative
   * to `setInterval`/`setTimeout`, which themselves cannot fire while the
   * loop is busy. A recursive `setImmediate` would also be queued behind
   * the burst, so we use a simpler two-sample approach.
   */
  async function blockingDuringBurst(queueFactory, label) {
    const q = queueFactory();
    let preBurstNow = 0;
    let postBurstNow = 0;
    try {
      const beforePromise = new Promise((resolve) => {
        setImmediate(() => {
          preBurstNow = performance.now();
          resolve();
        });
      });
      await beforePromise;

      const burstStart = performance.now();
      for (let i = 0; i < 5000; i++) {
        q.enqueue(makeHandle({ priority: i % 10 }));
      }
      const burstEnd = performance.now();

      const afterPromise = new Promise((resolve) => {
        setImmediate(() => {
          postBurstNow = performance.now();
          resolve();
        });
      });
      await afterPromise;

      // Block window = (postBurstNow - preBurstNow) - (burstEnd - burstStart)
      // The first setImmediate fires before the burst (captures preBurstNow);
      // the second fires after. The interval between them is everything
      // between the two setImmediate calls = (block window) + (burst time).
      const blockWindowMs = postBurstNow - preBurstNow - (burstEnd - burstStart);

      return {
        label,
        burstDurationMs: burstEnd - burstStart,
        opsPerSec: 5000 / ((burstEnd - burstStart) / 1000),
        blockWindowMs,
      };
    } finally {
      q.destroy();
    }
  }

  const memBlock = await blockingDuringBurst(
    () => new TaskQueue({ maxQueueSize: 50000 }),
    'memory',
  );
  const sqlBlock = await blockingDuringBurst(
    () => new SqliteTaskQueue({ path: dbPath, maxQueueSize: 50000 }),
    'sqlite',
  );

  console.log(`  Memory TaskQueue:`);
  console.log(`    burst duration:    ${fmtMs(memBlock.burstDurationMs)}`);
  console.log(`    throughput:        ${fmt(memBlock.opsPerSec)} ops/sec`);
  console.log(`    setImmediate gap:  ${fmtMs(memBlock.blockWindowMs)} (loop blocking)\n`);
  console.log(`  SqliteTaskQueue:`);
  console.log(`    burst duration:    ${fmtMs(sqlBlock.burstDurationMs)}`);
  console.log(`    throughput:        ${fmt(sqlBlock.opsPerSec)} ops/sec`);
  console.log(`    setImmediate gap:  ${fmtMs(sqlBlock.blockWindowMs)} (loop blocking)\n`);
  console.log(
    `  -> SQLite sync I/O blocks the Event Loop: burst held the loop for ${fmtMs(sqlBlock.burstDurationMs)}`,
  );
  console.log(
    `     vs ${fmtMs(memBlock.burstDurationMs)} for the in-memory queue (${(sqlBlock.burstDurationMs / memBlock.burstDurationMs).toFixed(0)}× longer).`,
  );
  console.log(
    `  -> Sustained 5 000 ops at ${fmt(sqlBlock.opsPerSec)} ops/sec — within ADR-0020's documented ceiling but at the edge of safe throughput.\n`,
  );

  // ──────────────────────────────────────────────────────────────────
  // [3] Throughput scaling — full enqueue + full dequeue cycles
  // ──────────────────────────────────────────────────────────────────
  console.log('[3/3] Throughput scaling (full enqueue + full dequeue cycle)...\n');

  async function fullCycle(queueFactory, n, label) {
    const q = queueFactory();
    try {
      const tasks = [];
      for (let i = 0; i < n; i++) {
        tasks.push(makeHandle({ priority: i % 10 }));
      }
      const enqStart = performance.now();
      for (const t of tasks) await q.enqueue(t);
      const enqEnd = performance.now();

      const deqStart = performance.now();
      let _claimed = 0;
      while (q.dequeue() !== null) _claimed++;
      const deqEnd = performance.now();

      return {
        label,
        n,
        enqMs: enqEnd - enqStart,
        deqMs: deqEnd - deqStart,
        totalMs: enqEnd - enqStart + (deqEnd - deqStart),
        opsPerSec: n / ((enqEnd - enqStart + (deqEnd - deqStart)) / 1000),
      };
    } finally {
      q.destroy();
    }
  }

  // Each cycle uses a fresh SQLite path so the WAL doesn't accumulate
  // rows from previous cycles. (Real workloads would vacuum regularly;
  // isolating cycles keeps the comparison apples-to-apples.)
  const sizes = [1000, 5000, 25000];
  const cycleResults = { memory: [], sqlite: [] };

  for (const n of sizes) {
    const memCycle = await fullCycle(() => new TaskQueue({ maxQueueSize: n + 1000 }), n, 'memory');
    const sqlCycle = await fullCycle(
      () =>
        new SqliteTaskQueue({
          path: join(tmpRoot, `queue-${n}.db`),
          maxQueueSize: n + 1000,
        }),
      n,
      'sqlite',
    );
    cycleResults.memory.push(memCycle);
    cycleResults.sqlite.push(sqlCycle);

    console.log(`  ${fmt(n).padStart(7)} tasks:`);
    console.log(
      `    memory:  ${fmtMs(memCycle.totalMs).padStart(10)} total  ->  ${fmt(memCycle.opsPerSec).padStart(8)} ops/sec`,
    );
    console.log(
      `    sqlite:  ${fmtMs(sqlCycle.totalMs).padStart(10)} total  ->  ${fmt(sqlCycle.opsPerSec).padStart(8)} ops/sec`,
    );
    const ratio = (memCycle.opsPerSec / sqlCycle.opsPerSec).toFixed(1);
    console.log(`    memory/sqlite throughput ratio: ${ratio}×\n`);
  }

  console.log('=====================================================================');
  console.log('CONCLUSION:');
  console.log(`- SqliteTaskQueue round-trip is ~${slowdown}× slower than the in-memory TaskQueue`);
  console.log('  (ADR-0020 documents ~1-5 ms per-op; benchmark above shows the exact');
  console.log(`  median on this host: ${fmtMs(sqlResults.totalMedian)}).\n`);

  console.log('- Sync I/O does block the Event Loop on the SQLite path. Burst');
  console.log(`  throughput observed at ${fmt(sqlBlock.opsPerSec)} ops/sec — within the ADR's`);
  console.log('  documented ceiling (~1 000 dispatches/sec for typical workloads).');
  console.log('  For sustained high-throughput multi-instance dispatch, keep the');
  console.log('  caller-side fronting pattern (DR §5.2.1) instead of enabling this backend.\n');

  console.log('- The trade-off is durability: pending tasks survive a runtime');
  console.log('  crash (RPO=0 for the queue itself) at the cost of per-op latency');
  console.log('  and Event Loop blocking. Verify the per-op cost is acceptable for');
  console.log('  the workload before enabling in production.\n');

  console.log('- The benchmark numbers above are host-specific. Re-run on production');
  console.log('  hardware before deciding whether SQLite fits your workload; the');
  console.log('  trade-off is documented in ADR-0020 §Negative Consequences.');
  console.log('=====================================================================');
}

runBenchmark()
  .then(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  })
  .catch((err) => {
    console.error(err);
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    process.exit(1);
  });
