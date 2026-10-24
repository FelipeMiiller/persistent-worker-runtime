/**
 * Benchmark: CPU saturation point (Phase E — T6 prep)
 *
 * Goal: empirically validate the Gunicorn/Uvicorn-style sizing rule
 * (`workers ≈ availableParallelism()` for CPU-bound workloads) before
 * implementing `concurrency: 'auto'` + `WORKER_CONCURRENCY` env var
 * in T6. If saturation is proven here, T6's defaults rest on data,
 * not folklore.
 *
 * Phases:
 *
 *   E-1 — CPU-bound saturation (hard assertions):
 *         Sweep a set of worker counts that CONTAINS the host core
 *         count (`CORES`) and 2× the core count, both capped at
 *         MAX_WORKERS.
 *
 *           E-1a — 2-worker throughput ≥ SPEEDUP_MIN_E1 × 1-worker
 *                   throughput (proves the workers really run in
 *                   parallel).
 *           E-1  — KNEE pair: throughput(2×CORES) / throughput(CORES)
 *                   ≤ SAT_RATIO_MAX_E1. The knee of a CPU-bound sweep
 *                   sits at the core count, so doubling the pool past
 *                   it must NOT buy throughput. If the ratio is ≈2×
 *                   the knee is at 2×CORES and the sizing rule is
 *                   wrong on this host → fail.
 *
 *         E-1 is measured over ROUNDS_E1 rounds. The sweep order is
 *         ROTATED by one position per round AND its direction is
 *         ALTERNATED per round (even rounds ascending, odd rounds
 *         descending), so the relative order of the two members of the
 *         measured pair inverts between rounds. A discarded warmup
 *         sweep (quarter of the tasks per point) precedes the rounds.
 *         Each configuration's reported value is the MEDIAN of the
 *         rounds. See "Why rounds + rotation + direction" below.
 *
 *   E-2 — I/O-bound control (hard assertion):
 *         Same sweep with `await setTimeout(10)` per task. Assert
 *         throughput scales sub-linearly even with oversubscription
 *         (more workers = more concurrent I/O slots). This proves
 *         the inverse rule: I/O-bound is NOT CPU-limited. Uses the
 *         SAME pair as E-1 when the knee is measurable, so the two
 *         phases are comparable apples-to-apples; otherwise the
 *         doubling pair (8, 16) is used as fallback.
 *
 *   E-3 — Decision matrix (reporting only):
 *         Side-by-side comparison prints a sizing recommendation
 *         table the user can act on. No hard assertion here.
 *
 *   E-4 — Health probes under load (hard assertions):
 *         runtime.isAlive() / runtime.isReady() under idle, saturated
 *         and draining states (DR §8.2).
 *
 * What this DOESN'T measure (deliberately):
 *   - Latency p50/p99 (separate benchmark; saturation is about
 *     steady-state throughput, not response time).
 *   - Memory pressure (use `benchmarks/default-sizing-memory`).
 *   - Process-level isolation (`node:cluster`, ADR-0020 territory).
 *
 * Why rounds + rotation + direction (and why the old single-pass
 * sweep was a noise gate):
 *   The original E-1 measured every configuration ONCE, in a fixed
 *   order, with the host's own core count LAST, and it compared the
 *   two LARGEST entries of the sweep whatever the host was. Two
 *   independent defects followed from that shape:
 *
 *     1. The first configuration paid the process cold-start and was
 *        ~20% slow (measured on a 28-core host: 1 worker took 1021 ms
 *        where 2 workers took 431 ms — an impossible 118% "efficiency").
 *        Ratios that use the first measurement as denominator inherit
 *        that bias.
 *     2. On a 3-core CI runner the compared pair was (16, 8) — both
 *        already oversubscribed — so the TRUE ratio was ≈1.0 by
 *        construction and the gate was measuring runner noise against
 *        a 1.5× budget. It failed intermittently (CI run 40036815752:
 *        1.58×).
 *
 *   Rotating the sweep order per round removes the "always measured
 *   in the same position" bias. Alternating the DIRECTION per round
 *   removes the systematic component that rotation alone cannot: a
 *   cyclic rotation preserves the relative order of the two members
 *   of the pair, so a "measured later is faster" effect stays
 *   systematic and inflates the ratio in EVERY round. Alternating the
 *   direction inverts that relative order in every other round, so the
 *   systematic component cancels across the even number of rounds.
 *
 *   The value taken per configuration is the MEDIAN, not the maximum:
 *   the gate is a RATIO between two magnitudes, and the variance of
 *   the maximum of N samples is larger than the variance of the
 *   median.
 *
 * Failure modes (read these if E-1 fails):
 *   - Knee ratio > 1.5×: throughput kept scaling past the core count
 *     → something other than CPU is the bottleneck (memory bandwidth?
 *     cache contention?). Investigate before shipping
 *     `concurrency: 'auto'`.
 *   - 2-worker speedup below the floor: workers aren't truly
 *     parallel. Check `worker_threads` config + `resourceLimits`.
 *   - Knee not measurable (2×CORES > MAX_WORKERS): the host has more
 *     cores than the sweep can reach (MAX_WORKERS = 20). The knee
 *     assertion is SKIPPED and says so — it is never reported as
 *     "saturation confirmed".
 */

import { availableParallelism } from 'node:os';
import { createWorkerRuntime } from '../src/index.js';

/**
 * Tight CPU-bound inner loop. ~50k iterations of modular arithmetic
 * per call. Benchmarked at ~5-8ms per call on a single core, so the
 * workload is meaningful (not a no-op) but not absurdly long.
 *
 * @param {{ seed: number }} p
 * @returns {{ seed: number, acc: number }}
 */
function cpuBoundWorkload(p) {
  let acc = 0;
  for (let i = 0; i < 50_000; i++) {
    acc = (acc * 31 + i + p.seed) % 9973;
  }
  return { seed: p.seed, acc };
}

/**
 * I/O-bound workload: 10ms of idle wait per task. Simulates a
 * network or disk call without actual I/O variability.
 *
 * @param {{ seed: number }} _p
 * @returns {Promise<{ seed: number }>}
 */
async function ioBoundWorkload(p) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { seed: p.seed };
}

const TASKS_PER_TRIAL = 2_000;
// Cap at 20 workers max so the benchmark doesn't saturate the host
// (user constraint 2026-09-18). On >20-core machines, the sweep
// stops short of `availableParallelism()`; the saturation rule is
// still empirically visible up to the cap, and the recommendation
// in E-3 notes when the host has more cores than we tested.
const MAX_WORKERS = 20;
// Platform-aware E-1 speedup floor. Linux x86_64 / Windows cleanly hit
// 1.3× at 2-worker vs 1-worker (well above noise floor). macOS-ARM64 (M1-
// class) GitHub Actions runners occasionally show 1.15–1.25× because the
// single-worker run benefits from L1/L2 cache warmth that doesn't carry
// over to the 2-worker run proportionally — same code path, different
// microarchitecture characteristics. 1.15× still proves true worker
// parallelism (any value > 1.0 means non-zero parallel speedup; we pick
// 1.15 to leave a generous margin against CI noise without masking a
// genuine regression). See `.agents/issues/CI-FAILURE-macos-benchmarks.md`
// for the original failure analysis.
const SPEEDUP_MIN_E1 = process.platform === 'darwin' ? 1.15 : 1.3;
// Budget for the knee ratio. The knee at CORES gives ≈1.0; a knee at
// 2×CORES gives ≈2.0. 1.5 separates the two.
const SAT_RATIO_MAX_E1 = 1.5;
// Floor for the I/O control: I/O-bound throughput must keep growing
// with the worker count.
const IO_RATIO_MIN_E2 = 1.15;
// Number of measured rounds over the same sweep. EVEN on purpose:
// every configuration must occupy each relative role the same number
// of times, or the systematic order component does not cancel.
const ROUNDS_E1 = 4;
// Warmup tasks per point — a quarter of the measured load. Enough to
// warm the JIT and the worker pools, cheap enough to discard.
const WARMUP_TASKS_PER_TRIAL = Math.floor(TASKS_PER_TRIAL / 4);
const CORES = availableParallelism();
// Oversubscription probe: the classic "past the knee" point, kept from
// the original sweep.
const OVERSUBSCRIPTION_PROBE = Math.min(MAX_WORKERS, Math.max(16, Math.floor(CORES / 2)));
// The sweep CONTAINS the knee (CORES) and the double (2×CORES) whenever
// 2×CORES is reachable within MAX_WORKERS. Sorted ascending so the
// sweep, the round orders and the decision matrix are deterministic.
const WORKER_COUNTS = [
  1,
  2,
  4,
  8,
  OVERSUBSCRIPTION_PROBE,
  Math.min(MAX_WORKERS, CORES),
  Math.min(MAX_WORKERS, CORES * 2),
]
  .filter((v, i, a) => a.indexOf(v) === i)
  .sort((a, b) => a - b);
// The knee pair: the host core count and twice it.
const KNEE_LOW = CORES;
const KNEE_HIGH = CORES * 2;
// The knee is measurable only when the double fits inside the sweep
// cap (CORES ≤ 10). Above that the host is bigger than the benchmark
// can reach and the assertion is skipped — never silently passed.
const KNEE_MEASURABLE = KNEE_HIGH <= MAX_WORKERS;

/**
 * Median of a sample. Even-sized samples average the two central
 * values, which mixes the two order roles of the median exactly when
 * the sample has one entry per role.
 *
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Measurement order for one round.
 *
 * The sweep is rotated by one position per round (so no configuration
 * always sits in the same slot) AND the direction alternates per round
 * (even rounds ascending, odd rounds descending).
 *
 * Why the direction alternation exists: a cyclic rotation alone keeps the
 * RELATIVE order of the two members of the measured pair fixed in every
 * round, so a position-dependent bias ("measured later is faster") would
 * land on the same side of the asserted ratio in EVERY round — a systematic
 * bias, which no order statistic removes. Alternating the direction moves
 * the pair across the sweep between rounds and largely cancels it.
 *
 * How largely: the cancellation is NOT exact. Whether the pair's relative
 * order flips in a given round depends on where the pair sits in the sweep.
 * Measured on the sweep a 3-core CI runner produces ([1,2,3,4,6,8,16], pair
 * 3→6), the balance is 3 rounds "low first" against 1 "high first", leaving
 * the high member on average 1.75 positions later than the low one. The
 * residual inflates the ratio by a few percent — measured at ~4% on a
 * 28-core host, against a budget that has ~50% of headroom, so it cannot
 * flip the assertion in either direction. Do not treat the alternation as
 * an exact cancellation: if the gate ever needs one, the pair has to be
 * measured adjacently with mirrored slots (see .agents/issues/
 * CI-FAILURE-macos-cpu-saturation-knee.md).
 *
 * @param {number[]} sweep ascending worker counts
 * @param {number} round zero-based round index
 * @returns {number[]} worker counts in measurement order
 */
function roundOrder(sweep, round) {
  const n = sweep.length;
  const start = round % n;
  const order = [];
  for (let i = 0; i < n; i++) {
    const index = round % 2 === 0 ? (start + i) % n : (start - i + n) % n;
    order.push(sweep[index]);
  }
  return order;
}

/**
 * Pair used by the I/O control (E-2): the knee pair whenever it is
 * measurable, so both phases compare the SAME two worker counts. When
 * the knee is out of range the doubling pair (8, 16) is used instead —
 * the E-2 assertion ("I/O-bound keeps scaling with more workers")
 * does not depend on the knee.
 *
 * @returns {{ low: number, high: number, reason: string } | null}
 */
function selectIoPair() {
  if (KNEE_MEASURABLE) {
    return { low: KNEE_LOW, high: KNEE_HIGH, reason: 'knee pair (identical to the E-1 pair)' };
  }
  if (WORKER_COUNTS.includes(8) && WORKER_COUNTS.includes(16)) {
    return {
      low: 8,
      high: 16,
      reason: 'doubling-pair fallback (the knee is not measurable on this host)',
    };
  }
  for (const low of WORKER_COUNTS) {
    if (WORKER_COUNTS.includes(low * 2)) {
      return {
        low,
        high: low * 2,
        reason: 'doubling-pair fallback (the knee is not measurable on this host)',
      };
    }
  }
  return null;
}

function formatRow(workers, durationMs, throughput, idealScaling, efficiency) {
  const w = String(workers).padStart(3);
  const dur = durationMs.toFixed(0).padStart(7);
  const tput = throughput.toFixed(0).padStart(7);
  const ideal = idealScaling.toFixed(0).padStart(7);
  const eff = (efficiency * 100).toFixed(1).padStart(6);
  return `  workers=${w}: ${dur}ms -> ${tput} tasks/sec  (ideal ${ideal}, ${eff}% efficient)`;
}

/**
 * Measures one configuration. The runtime is created and destroyed
 * outside the timed window, exactly like the original benchmark.
 *
 * @param {number} workers
 * @param {(p: { seed: number }) => any} workloadFn
 * @param {number} tasksPerTrial
 * @returns {Promise<{ workers: number, durationMs: number, throughput: number }>}
 */
async function measureWorkload(workers, workloadFn, tasksPerTrial = TASKS_PER_TRIAL) {
  const runtime = await createWorkerRuntime({ workers });
  try {
    const tasks = [];
    for (let i = 0; i < tasksPerTrial; i++) {
      tasks.push({ type: 'probe', payload: { seed: i }, fn: workloadFn });
    }
    const start = performance.now();
    await runtime.executeAll(tasks);
    const durationMs = performance.now() - start;
    const throughput = tasksPerTrial / (durationMs / 1000);
    return { workers, durationMs, throughput };
  } finally {
    await runtime.shutdown();
  }
}

/**
 * Phase E-1: CPU-bound saturation point.
 *
 * @returns {Promise<Map<number, { workers: number, throughput: number, durationMs: number, rounds: number[] }>>}
 */
async function phaseECpuSaturation() {
  console.log('\n── Phase E-1: CPU-bound saturation point ─────────────────────────────');
  console.log(`  host: ${CORES} logical cores available`);
  console.log(`  workload: ${TASKS_PER_TRIAL} tasks × 50k-iter modular arithmetic per task`);
  console.log(`  sweep: ${WORKER_COUNTS.join(', ')}`);
  console.log(
    `  method: ${ROUNDS_E1} rounds, sweep order rotated by 1 position per round and direction ` +
      `alternated per round, per-configuration value = median of the ${ROUNDS_E1} rounds`,
  );

  // Warmup: one discarded sweep with a quarter of the tasks per point,
  // so the process cold-start is not charged to the first measured
  // configuration.
  const warmupOrder = roundOrder(WORKER_COUNTS, 0);
  console.log(
    `\n  warmup sweep (${WARMUP_TASKS_PER_TRIAL} tasks/point, discarded): ${warmupOrder.join('→')}`,
  );
  for (const workers of warmupOrder) {
    await measureWorkload(workers, cpuBoundWorkload, WARMUP_TASKS_PER_TRIAL);
  }

  // Measured rounds.
  const perWorker = new Map();
  const rounds = [];
  for (let round = 0; round < ROUNDS_E1; round++) {
    const order = roundOrder(WORKER_COUNTS, round);
    console.log(`  round ${round + 1}/${ROUNDS_E1} order: ${order.join('→')}`);
    const results = [];
    for (const workers of order) {
      results.push(await measureWorkload(workers, cpuBoundWorkload, TASKS_PER_TRIAL));
    }
    rounds.push(results);
    for (const result of results) {
      if (!perWorker.has(result.workers)) perWorker.set(result.workers, []);
      perWorker.get(result.workers).push(result);
    }
  }

  // Per-configuration median over the rounds + the full per-round
  // dispersion, so a reader sees the spread and not only the median
  // the gate asserts on.
  console.log('');
  const cpuResults = new Map();
  const baselineThroughput = median((perWorker.get(1) ?? []).map((r) => r.throughput));
  for (const workers of WORKER_COUNTS) {
    const samples = perWorker.get(workers) ?? [];
    const throughputs = samples.map((r) => r.throughput);
    const medianThroughput = median(throughputs);
    const medianDurationMs = (TASKS_PER_TRIAL / medianThroughput) * 1000;
    const spread = Math.max(...throughputs) - Math.min(...throughputs);
    const spreadPct = medianThroughput > 0 ? (spread / medianThroughput) * 100 : 0;
    const idealScaling = baselineThroughput * workers;
    const efficiency = medianThroughput / idealScaling;
    cpuResults.set(workers, {
      workers,
      throughput: medianThroughput,
      durationMs: medianDurationMs,
      rounds: throughputs,
    });
    console.log(formatRow(workers, medianDurationMs, medianThroughput, idealScaling, efficiency));
    console.log(
      `             rounds: ${throughputs.map((t) => t.toFixed(0)).join(' | ')}   ` +
        `spread ${spread.toFixed(0)} (${spreadPct.toFixed(1)}%)`,
    );
  }

  // E-1a — the workers are really parallel.
  const w1 = cpuResults.get(1);
  const w2 = cpuResults.get(2);
  const speedup = w2.throughput / w1.throughput;
  if (!(speedup >= SPEEDUP_MIN_E1)) {
    console.error(
      `\n  E-1 FAIL: 2-worker throughput not >${SPEEDUP_MIN_E1}× baseline ` +
        `(${speedup.toFixed(2)}× on ${process.platform}) — workers not parallel.`,
    );
    process.exit(1);
  }
  console.log(
    `\n  ✓ 2-worker scaling: ${speedup.toFixed(2)}× baseline ` +
      `(floor=${SPEEDUP_MIN_E1}× for ${process.platform})`,
  );

  // E-1 — the knee is at the core count.
  let kneeMeasured = false;
  if (KNEE_MEASURABLE) {
    const low = cpuResults.get(KNEE_LOW);
    const high = cpuResults.get(KNEE_HIGH);
    const satRatio = high.throughput / low.throughput;
    const perRoundRatios = rounds.map((round) => {
      const lowSample = round.find((r) => r.workers === KNEE_LOW);
      const highSample = round.find((r) => r.workers === KNEE_HIGH);
      return highSample.throughput / lowSample.throughput;
    });
    console.log(`  knee pair (CORES→2×CORES): ${KNEE_LOW}→${KNEE_HIGH} workers`);
    console.log(
      `  per-round knee ratios: ${perRoundRatios.map((r) => `${r.toFixed(2)}×`).join(' | ')}   ` +
        `spread ${(Math.max(...perRoundRatios) - Math.min(...perRoundRatios)).toFixed(2)}`,
    );
    console.log(
      `  saturation ratio (${KNEE_HIGH}/${KNEE_LOW}): ${satRatio.toFixed(2)}×   ` +
        `(budget ≤${SAT_RATIO_MAX_E1}×, host cores=${CORES})`,
    );
    if (satRatio > SAT_RATIO_MAX_E1) {
      console.error(
        `\n  E-1 FAIL: throughput did not plateau at cores — ${satRatio.toFixed(2)}× ` +
          `> ${SAT_RATIO_MAX_E1}× budget at ${KNEE_LOW}→${KNEE_HIGH} workers ` +
          `(host cores=${CORES}). Investigate.`,
      );
      process.exit(1);
    }
    console.log(
      `  ✓ saturation confirmed at the knee (${KNEE_LOW}→${KNEE_HIGH} workers): ` +
        `${satRatio.toFixed(2)}× (extra ${((satRatio - 1) * 100).toFixed(0)}% from doubling past saturation)`,
    );
    kneeMeasured = true;
  } else {
    console.log(`  knee pair (CORES→2×CORES): ${KNEE_LOW}→${KNEE_HIGH} workers`);
    console.log(
      `  NOT MEASURABLE on this host: 2×CORES=${KNEE_HIGH} > MAX_WORKERS=${MAX_WORKERS} — ` +
        `the sweep cannot reach the knee.`,
    );
    console.log(
      `  → E-1 knee assertion SKIPPED (not measurable on this host), NOT passed. ` +
        `The sweep tops out at ${WORKER_COUNTS[WORKER_COUNTS.length - 1]} workers.`,
    );
  }

  return { cpuResults, kneeMeasured };
}

async function probeUnderLoad() {
  console.log('\n── Phase E-4: Health probes under load ───────────────────────────────');
  console.log(
    '  Exercises runtime.isAlive() + runtime.isReady() (DR §8.2) under CPU saturation\n' +
      '  + queue backpressure. Probes must reflect the actual runtime state.\n',
  );

  // Scenario A: idle runtime → both probes return { ok: true }.
  {
    const runtime = await createWorkerRuntime({ workers: 4 });
    try {
      const a = runtime.isAlive();
      const r = runtime.isReady();
      console.log(`  [idle]        isAlive=${JSON.stringify(a)}  isReady=${JSON.stringify(r)}`);
      const ok = a.ok && r.ok;
      if (!ok) {
        console.error('  E-4 FAIL: idle runtime must report ok:true on both probes.');
        process.exit(1);
      }
    } finally {
      await runtime.shutdown();
    }
  }

  // Scenario B: 1 worker + tiny queue + blocking tasks → isReady flips
  // to { ok:false, reason:"queue-full" }. Demonstrates the readiness
  // gate an external observer (k8s readinessProbe, LB target group)
  // would use to drain traffic from a saturated instance.
  {
    const runtime = await createWorkerRuntime({ workers: 1, maxQueueSize: 2 });
    try {
      const blocker = () =>
        new Promise(() => {
          // Never resolves — keeps the worker busy so the queue fills.
        });
      runtime.dispatch(blocker).promise.catch(() => {
        // Fire-and-forget — the rejected promise is intentional (test setup).
      });
      runtime.dispatch(blocker).promise.catch(() => {
        // Same — second pending task fills the queue.
      });
      runtime.dispatch(blocker).promise.catch(() => {
        // Same — third task goes to a parked waiter.
      });
      // Let the scheduler settle so the first task is busy + two pending.
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));

      const a = runtime.isAlive();
      const r = runtime.isReady();
      console.log(`  [queue-full]  isAlive=${JSON.stringify(a)}  isReady=${JSON.stringify(r)}`);
      const ok = a.ok === true && r.ok === false && r.reason === 'queue-full';
      if (!ok) {
        console.error(
          '  E-4 FAIL: queue-full scenario — expected isAlive=true, isReady={ok:false,reason:"queue-full"}.',
        );
        process.exit(1);
      }
    } finally {
      await runtime.shutdown();
    }
  }

  // Scenario C: drain in flight → isAlive stays true (process is alive
  // while workers finish), isReady flips to { ok:false,
  // reason:"shutting-down" } (no new work, even mid-drain).
  {
    const runtime = await createWorkerRuntime({ workers: 2 });
    try {
      const drainPromise = runtime.shutdown();
      const a = runtime.isAlive();
      const r = runtime.isReady();
      console.log(`  [draining]    isAlive=${JSON.stringify(a)}  isReady=${JSON.stringify(r)}`);
      const ok = a.ok === true && r.ok === false && r.reason === 'shutting-down';
      if (!ok) {
        console.error(
          '  E-4 FAIL: drain scenario — expected isAlive=true, isReady={ok:false,reason:"shutting-down"}.',
        );
        process.exit(1);
      }
      await drainPromise;
    } catch {
      // runtime.shutdown() already resolved — nothing to do.
    }
  }

  console.log('  ✓ E-4: probes correctly reflect idle / saturated / draining states.');
}

async function phaseEDecisionMatrix(cpuResults, ioResults, kneeMeasured) {
  console.log('\n── Phase E-3: Sizing decision matrix ──────────────────────────────────');
  console.log('  CPU-bound vs I/O-bound scaling for the same worker-count sweep:\n');

  const header = `  ${'workers'.padStart(7)}  ${'CPU tput'.padStart(12)}  ${'IO tput'.padStart(12)}  ${'best for'.padStart(12)}`;
  console.log(header);
  console.log(`  ${'-'.repeat(7)}  ${'-'.repeat(12)}  ${'-'.repeat(12)}  ${'-'.repeat(12)}`);

  for (const w of WORKER_COUNTS) {
    const cpu = cpuResults.get(w)?.throughput ?? 0;
    const io = ioResults.get(w)?.throughput ?? 0;
    // Heuristic: if CPU-bound plateaus here, label as 'I/O (wasted)';
    // if both are still climbing, label as 'still scaling'.
    const cpuLabel = w <= CORES ? 'both ok' : 'I/O only';
    console.log(
      `  ${String(w).padStart(7)}  ${cpu.toFixed(0).padStart(10)}  ${io.toFixed(0).padStart(10)}  ${cpuLabel.padStart(10)}`,
    );
  }

  console.log('\n  Default sizing recommendation:');
  console.log(`    WORKER_CONCURRENCY = availableParallelism() = ${CORES} on this host`);
  if (kneeMeasured) {
    console.log('    → CPU-bound workloads saturate at this value (E-1 measured the knee)');
  } else {
    console.log(
      `    → CPU-bound workloads are EXPECTED to saturate at this value, but E-1 could not measure`,
    );
    console.log(
      `      the knee on this host (2×CORES=${KNEE_HIGH} > MAX_WORKERS=${MAX_WORKERS}) — this line is`,
    );
    console.log('      the sizing rule, not a measurement taken here.');
  }
  console.log('    → I/O-bound workloads benefit from more, but only if memory allows (E-2)');
  console.log(
    '    → Mapped from Gunicorn: workers = $WEB_CONCURRENCY = nproc (CPU) or nproc × N (I/O)',
  );
}

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: CPU Saturation Point (Phase E — T6 prep)');
  console.log('=====================================================================\n');

  const { cpuResults, kneeMeasured } = await phaseECpuSaturation();

  console.log('\n── Phase E-2: I/O-bound control ───────────────────────────────────────');
  console.log(`  workload: ${TASKS_PER_TRIAL} tasks × 10ms setTimeout each\n`);
  const ioResults = new Map();
  for (const workers of WORKER_COUNTS) {
    const r = await measureWorkload(workers, ioBoundWorkload, TASKS_PER_TRIAL);
    ioResults.set(workers, r);
    const dur = r.durationMs.toFixed(0).padStart(7);
    const tput = r.throughput.toFixed(0).padStart(7);
    console.log(`  workers=${String(workers).padStart(3)}: ${dur}ms -> ${tput} tasks/sec`);
  }

  const ioPair = selectIoPair();
  if (!ioPair) {
    console.error('\n  E-2 FAIL: no doubling pair of worker counts in the sweep to compare.');
    process.exit(1);
  }
  const lowIo = ioResults.get(ioPair.low);
  const highIo = ioResults.get(ioPair.high);
  const ioRatio = highIo.throughput / lowIo.throughput;
  console.log(`  comparison pair: ${ioPair.high}/${ioPair.low} — ${ioPair.reason}`);
  console.log(
    `  oversubscription ratio (${ioPair.high}/${ioPair.low}): ${ioRatio.toFixed(2)}×   ` +
      `(floor=${IO_RATIO_MIN_E2}×, host cores=${CORES})`,
  );
  if (ioRatio < IO_RATIO_MIN_E2) {
    console.error(
      `\n  E-2 FAIL: I/O-bound throughput did not grow with workers (${ioRatio.toFixed(2)}×) — runtime bottleneck.`,
    );
    process.exit(1);
  }
  console.log(
    `  ✓ I/O-bound scales ${ioRatio.toFixed(2)}× from ${ioPair.low}→${ioPair.high} workers — confirms CPU is the E-1 bottleneck`,
  );

  await phaseEDecisionMatrix(cpuResults, ioResults, kneeMeasured);
  await probeUnderLoad();

  console.log('\n=====================================================================');
  if (kneeMeasured) {
    console.log(
      'VERDICT: Phase E passed — the saturation knee was measured at availableParallelism().',
    );
  } else {
    console.log(
      `VERDICT: Phase E passed — the knee was NOT measurable on this host (2×CORES=${KNEE_HIGH} > MAX_WORKERS=${MAX_WORKERS}).`,
    );
    console.log('        E-1a, E-2 and E-4 verified; the saturation knee remains UNMEASURED here.');
  }
  console.log('Sizing rule for `concurrency: "auto"` + WORKER_CONCURRENCY (T6): workers ≈ nproc.');
  console.log('=====================================================================');
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
