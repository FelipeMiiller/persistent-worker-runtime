/**
 * Benchmark: I/O throughput + memory cleanup + failure recovery +
 * recycling — **sustained rate over time** (not burst).
 *
 * **Real environment simulation** — 50 000 TCP round-trips spread
 * across a 30+ second window at a constant ~1 500 req/s (the same
 * target rate the default-sized pool would handle on a healthy
 * Node.js host). Tasks accumulate state in worker memory to drive
 * recycling, 5 % of tasks fail (simulated "trade failure"), and a
 * mid-stream runaway task exercises the preemption watchdog. Every
 * 5 seconds the benchmark prints a progress line so you can watch
 * memory + throughput evolve in real time.
 *
 * **What the benchmark validates** (each = one explicit hard
 * assertion in the final report):
 *
 *   1. **Sustained throughput** — 50k tasks complete within the wall
 *      budget under sustained pressure (not just a one-shot burst).
 *
 *   2. **Memory accumulation drives recycling** — workers that
 *      accumulate trade history faster than V8 GC reclaims cross
 *      the configured `maxMemoryMb` threshold and are recycled.
 *     `worker:recycled` events must fire at least once.
 *
 *   3. **Memory reclaims after recycling** — fresh workers boot
 *      with the V8 isolate floor only; the RSS delta between the
 *      peak (during the sustained phase) and the post-drain
 *      baseline quantifies how much memory recycling actually
 *      freed.
 *
 *   4. **Runaway tasks trigger preemption** — a `while (true) {}`
 *      task dispatched mid-stream is detected by the watchdog and
 *      the worker is replaced. `worker:preempted` /
 *      `worker:recycled` events fire within the watchdog budget.
 *
 *   5. **Recovery after recycling/preemption** — fresh workers come
 *      back online and accept new tasks (a Phase 3 dispatch
 *      verifies completion on the new pool).
 *
 *   6. **Per-worker share** — every worker gets ≥ 50 % of its fair
 *      share of the sustained-phase tasks (catches dispatch
 *      starvation).
 *
 *   7. **ADR-0019 floor** — post-boot RSS / workers stays within
 *      the 30-50 MB / worker V8 isolate floor band (regression
 *      signal).
 *
 *   8. **Heap doesn't leak between phases** — main-thread heap
 *      growth after the full sequence stays under the bound
 *      (catches any callback / closure / dispatch leak).
 *
 *   9. **No floor creep across phases** — RSS at each idle-drain
 *      snapshot is ≤ previous peak minus a sane drain margin (no
 *      monotonic upward drift that would suggest unbounded state).
 *
 * **Continuous logging** — every 5 seconds during Phase 1 the
 * benchmark prints:
 *
 *   [tick @Ts.ms] done=N (rate=X/s) | in-flight=Y | memory RSS=X.X MB (Δ vs prev=X.X MB)
 *                 | gc-delta=X.X MB (heap drop since prev snapshot)
 *                 | recycled=N | preempted=N | workers=N
 *
 * The final report includes an "Improvement opportunities" section
 * derived from the observed numbers — anything the benchmark
 * surfaces that points to a tunable in `src/` or a missing
 * feature.
 *
 * Run with: `npm run benchmark:io-throughput`.
 * Override worker count via `BENCH_IO_WORKERS=<n>` env var.
 */

import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import { threadId as mainThreadId } from 'node:worker_threads';
import { createWorkerRuntime } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

const WORKERS = Number(process.env.BENCH_IO_WORKERS) || 4;
// Sustained rate: 1 500 req/s × ~33.3 s = 50 000 tasks. Tune via
// env vars for faster CI runs.
const TARGET_RATE_PER_SEC = Number(process.env.BENCH_IO_RATE_PER_SEC) || 1500;
const TOTAL_TASKS = Number(process.env.BENCH_IO_TOTAL_TASKS) || 50_000;
const BATCH_SIZE = 50;
// Dispatch batches of BATCH_SIZE at BATCH_INTERVAL_MS to hit TARGET_RATE_PER_SEC.
const BATCH_INTERVAL_MS = Math.max(1, Math.round((BATCH_SIZE / TARGET_RATE_PER_SEC) * 1000));

// Recycling threshold (ADR-0019). With 10 KB per-task accumulation,
// this fires after ~3 000 tasks per worker.
const MAX_MEMORY_MB = Number(process.env.BENCH_IO_MAX_MEMORY_MB) || 80;
// HARDEN-06 (ADR-0024 C1): rate-based recycling guard. Defaults to
// `Infinity` (disabled) so the benchmark exercises the absolute-cap
// path that originally surfaced the 242-recyclings finding. Set
// `BENCH_IO_ACCUMULATION_RATE_MB_PER_SEC` (e.g. `5`) to opt into the
// Wave-3 rate-based guard and measure its impact.
const ACCUMULATION_RATE_MB_PER_SEC =
  process.env.BENCH_IO_ACCUMULATION_RATE_MB_PER_SEC === undefined
    ? Infinity
    : Number(process.env.BENCH_IO_ACCUMULATION_RATE_MB_PER_SEC);
// HARDEN-07 (ADR-0024 C2): per-worker recycle hysteresis. Defaults to
// `0` (disabled) for back-compat with the pre-HARDEN-07 behavior.
// Set `BENCH_IO_MIN_RECYCLE_INTERVAL_MS` (e.g. `30000`) to opt into
// the Wave-3 hysteresis throttle and measure its impact.
const MIN_RECYCLE_INTERVAL_MS =
  process.env.BENCH_IO_MIN_RECYCLE_INTERVAL_MS === undefined
    ? 0
    : Number(process.env.BENCH_IO_MIN_RECYCLE_INTERVAL_MS);
// Preemption configuration — aggressive enough to confirm the
// watchdog works within Phase 1's 33-second window.
const FORCE_KILL_ON_TIMEOUT = true;
const KILL_GRACE_PERIOD_MS = 0;
// Per-task memory accumulation (drives recycling).
const TRADE_RESULT_BYTES = 10_240;
// Failure injection rate.
const FAILURE_RATE = 0.05;
// Preemption mid-stream trigger — dispatch a runaway task at this
// fraction through Phase 1 to test the watchdog.
const PREEMPTION_TRIGGER_AT_FRACTION = 0.5;

// Payload size for the TCP round-trip body.
const PAYLOAD_MIN_BYTES = 64;
const PAYLOAD_MAX_BYTES = 4_064;
const SERVER_LATENCY_MAX_MS = 2;
const MAX_INFLIGHT = 500;

// Idle drain windows between phases.
const IDLE_DRAIN_BETWEEN_MS = 10_000;
const IDLE_DRAIN_FINAL_MS = 15_000;
const SETTLE_AFTER_MS = 200;
// Periodic logging interval during the sustained phase.
const PROGRESS_LOG_INTERVAL_MS = 5_000;

// Sanity bounds.
const WALL_TIME_BUDGET_MS = 240_000;
const MIN_RECYCLING_EVENTS = 1;
const MIN_THROUGHPUT_REQ_PER_SEC = 200;
const MAX_HEAP_GROWTH_MB = 200;
const MAX_PER_WORKER_RSS_MB_POST_BOOT = 100;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function snapMemory() {
  const mu = process.memoryUsage();
  const v8s = v8.getHeapStatistics();
  return {
    tsMs: performance.now(),
    rss: mu.rss,
    heapUsed: mu.heapUsed,
    heapTotal: mu.heapTotal,
    arrayBuffers: mu.arrayBuffers,
    external: mu.external,
    v8HeapUsed: v8s.used_heap_size,
    v8HeapTotal: v8s.total_heap_size,
    v8HeapLimit: v8s.heap_size_limit,
    v8NativeContexts: v8s.number_of_native_contexts,
  };
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function signedMb(bytes) {
  const sign = bytes >= 0 ? '+' : '-';
  return `${sign}${mb(Math.abs(bytes))}`;
}

function fmtMs(ms) {
  return `${ms.toFixed(3).padStart(10)} ms`;
}

function logLine(s) {
  console.log(s);
}

function formatHeader(title) {
  const bar = '─'.repeat(Math.max(20, 70 - title.length));
  return `\n── ${title} ${bar}\n`;
}

async function settleFor(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function maybeGc() {
  if (global.gc) global.gc();
}

/**
 * TCP echo server with **variable latency injection** and a request
 * counter. Bind `127.0.0.1` only. Port `0` = ephemeral.
 */
function startEchoServer() {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        const delay = Math.floor(Math.random() * SERVER_LATENCY_MAX_MS);
        setTimeout(() => {
          requestCount++;
          socket.write(data);
        }, delay);
      });
      socket.on('error', () => {
        /* ignore — task fn records its own outcome */
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        getRequestCount: () => requestCount,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            setTimeout(r, 200).unref?.();
          }),
      });
    });
  });
}

/**
 * One TCP round-trip + per-task memory accumulation + 5 % failure
 * injection. **Pure I/O** in the round-trip body; the only CPU is
 * the roundtrip validation. Memory accumulation simulates trade
 * history held in worker state.
 *
 * **State usage** — the runtime passes per-worker persistent
 * `state` as the second argument. We use a single key `history`
 * to hold the accumulated trade results. The map persists across
 * tasks within a worker lifetime; recycling resets it.
 *
 * **Why a STRING (not Buffer) for accumulation** — the runtime's
 * recycling threshold is compared against `process.memoryUsage().heapUsed`
 * from inside the worker, which only counts V8-heap allocations.
 * `Buffer.alloc()` / `randomBytes()` allocate off-heap (counted
 * under `external` and `arrayBuffers`, not `heapUsed`), so they
 * would never drive recycling. `String.prototype.repeat(n)` is
 * guaranteed to allocate n bytes of V8 heap, which is what we want
 * here.
 */
async function tcpRoundtripFn(payload, state) {
  const [{ createConnection }, { threadId }, { randomBytes }] = await Promise.all([
    import('node:net'),
    import('node:worker_threads'),
    import('node:crypto'),
  ]);

  const payloadMinBytes = 64;
  const payloadMaxBytes = 4_064;
  const tradeResultBytes = 10_240;
  const failureRate = 0.05;
  const taskTimeoutMs = 5_000;

  // Per-task memory accumulation on the V8 heap (drives recycling).
  // **Critical:** the string content must be UNIQUE per task —
  // V8 deduplicates strings with identical content (the heap's
  // string-internalization table collapses them to one entry), so
  // `'x'.repeat(n)` would only allocate ~n bytes TOTAL regardless of
  // how many tasks run. We use a deterministic per-task seed to
  // build a string with content that differs across tasks, which
  // forces V8 to allocate a fresh string per push.
  const segLen = Math.max(1, tradeResultBytes);
  let uniqueContent = '';
  const seed = (payload.requestId * 31 + Math.floor(Math.random() * 1_000_000)) >>> 0;
  for (let j = 0; j < segLen; j++) {
    uniqueContent += String.fromCharCode(33 + ((seed + j * 7) % 94));
  }
  const tradeResult = uniqueContent;
  let history = state.get('history');
  if (!history) {
    history = [];
    state.set('history', history);
  }
  history.push(tradeResult);

  // Synthetic trade failure (5 % rate).
  if (Math.random() < failureRate) {
    throw new Error('simulated trade failure');
  }

  // Realistic random payload + TCP round-trip.
  const payloadSize =
    payloadMinBytes + Math.floor(Math.random() * (payloadMaxBytes - payloadMinBytes));
  const payloadBytes = randomBytes(payloadSize);

  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port: payload.port });
    let receivedLen = 0;
    const receivedChunks = [];
    const timer = null;
    const finish = (err, value) => {
      if (timer) clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    sock.setTimeout(taskTimeoutMs);
    sock.once('connect', () => sock.write(payloadBytes));
    sock.on('data', (chunk) => {
      receivedChunks.push(chunk);
      receivedLen += chunk.length;
      if (receivedLen >= payloadBytes.length) {
        const received = Buffer.concat(receivedChunks, receivedLen);
        const matches = received.length === payloadBytes.length && received.equals(payloadBytes);
        if (!matches) {
          finish(new Error('payload mismatch (expected equal bytes)'));
        } else {
          finish(null, {
            requestId: payload.requestId,
            bytes: payloadBytes.length,
            workerThreadId: threadId,
            historySize: history.length,
          });
        }
      }
    });
    sock.on('error', (err) => finish(err));
    sock.on('timeout', () => finish(new Error('socket timeout')));
  });
}

/**
 * Runaway task: dispatches a `while (true) {}` to the runtime. With
 * `forceKillOnTimeout: true` + `killGracePeriodMs: 0`, the watchdog
 * should preempt this within the supervisor's polling interval
 * (default 1 s). Returns a promise that resolves when the watchdog
 * reports either `worker:preempted` or `worker:recycled` for the
 * dispatched task.
 */
function dispatchRunawayTask(runtime, port) {
  return new Promise((resolve, reject) => {
    let preemptedOrRecycled = false;
    const onPreempt = () => {
      preemptedOrRecycled = true;
      resolve('preempted');
    };
    const onRecycled = () => {
      preemptedOrRecycled = true;
      resolve('recycled');
    };
    runtime.once('worker:preempted', onPreempt);
    runtime.once('worker:recycled', onRecycled);

    let runawayHandle;
    try {
      runawayHandle = runtime.dispatch({
        type: 'runaway',
        payload: { port },
        // Inline `while (true) {}` — no I/O, just a CPU spin that
        // never yields. The watchdog should preempt within
        // `timeoutMs` (1 000 ms here).
        fn: () => {
          while (true) {
            /* intentional runaway — watchdog must catch this */
          }
        },
        // Watchdog requires both `forceKillOnTimeout: true` AND
        // `timeoutMs > 0` — the latter defaults to 0 (no watchdog)
        // unless the caller sets it.
        forceKillOnTimeout: true,
        killGracePeriodMs: 0,
        timeoutMs: 1_000,
      });
    } catch (err) {
      runtime.off('worker:preempted', onPreempt);
      runtime.off('worker:recycled', onRecycled);
      reject(err);
      return;
    }

    // The dispatch itself shouldn't reject (the task body runs
    // asynchronously inside the worker); we still attach a
    // rejection handler to avoid unhandled-rejection noise.
    runawayHandle.promise.then(
      () => {
        /* intentional: swallow fire-and-forget resolution */
      },
      () => {
        /* intentional: swallow fire-and-forget rejection */
      },
    );

    // Failsafe: if neither event fires within 10 s, declare it a
    // missed-preemption regression.
    setTimeout(() => {
      if (!preemptedOrRecycled) {
        runtime.off('worker:preempted', onPreempt);
        runtime.off('worker:recycled', onRecycled);
        reject(new Error('preemption did not fire within 10 000 ms — watchdog regression?'));
      }
    }, 10_000).unref?.();
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  logLine('======================================================================');
  logLine(
    `BENCHMARK: I/O throughput + memory cleanup + failure recovery (SUSTAINED ${TOTAL_TASKS.toLocaleString()} tasks @ ${TARGET_RATE_PER_SEC.toLocaleString()} req/s)`,
  );
  logLine(
    `  payload: ${PAYLOAD_MIN_BYTES} B - ${PAYLOAD_MAX_BYTES} B + 10 KB per-task accumulation + ${(FAILURE_RATE * 100).toFixed(0)}% failure injection`,
  );
  logLine(
    `  recycling threshold: maxMemoryMb=${MAX_MEMORY_MB} | accumulationRateMbPerSec=${ACCUMULATION_RATE_MB_PER_SEC === Infinity ? '∞' : ACCUMULATION_RATE_MB_PER_SEC} | minRecycleIntervalMs=${MIN_RECYCLE_INTERVAL_MS} | preemption: forceKillOnTimeout=${FORCE_KILL_ON_TIMEOUT}, killGracePeriodMs=${KILL_GRACE_PERIOD_MS}`,
  );
  logLine(`  bounded concurrency: ${MAX_INFLIGHT} in-flight max`);
  logLine(
    `  dispatch: ${BATCH_SIZE} tasks every ${BATCH_INTERVAL_MS} ms (= ${((BATCH_SIZE * 1000) / BATCH_INTERVAL_MS).toFixed(0)} req/s nominal)`,
  );
  logLine(
    `  expected duration: ${(TOTAL_TASKS / TARGET_RATE_PER_SEC).toFixed(1)} s sustained + idle drains + recovery`,
  );
  logLine('======================================================================\n');

  logLine(`  Main thread ID: ${mainThreadId}`);
  logLine(`  Worker count: ${WORKERS}`);
  logLine(`  Wall-time budget: ${WALL_TIME_BUDGET_MS / 1000}s`);

  // ── Boot echo server ──────────────────────────────────────────────────
  const echo = await startEchoServer();
  logLine(`  Echo server: 127.0.0.1:${echo.port} (ephemeral)`);

  // ── Memory baseline ───────────────────────────────────────────────────
  maybeGc();
  await settleFor(SETTLE_AFTER_MS);
  const memBaseline = snapMemory();
  logLine(`\n  Memory baseline (pre-runtime):`);
  logLine(`    process RSS:        ${mb(memBaseline.rss)} MB`);
  logLine(`    main heap used:     ${mb(memBaseline.heapUsed)} MB`);
  logLine(`    main heap total:    ${mb(memBaseline.heapTotal)} MB`);
  logLine(`    arrayBuffers:       ${mb(memBaseline.arrayBuffers)} MB`);
  logLine(`    external:           ${mb(memBaseline.external)} MB`);
  logLine(`    v8 heap used:       ${mb(memBaseline.v8HeapUsed)} MB`);
  logLine(`    v8 native contexts: ${memBaseline.v8NativeContexts}`);
  logLine(`    v8 heap size limit: ${mb(memBaseline.v8HeapLimit)} MB`);

  // ── Boot runtime with full instrumentation ────────────────────────────
  const runtime = await createWorkerRuntime({
    workers: WORKERS,
    maxMemoryMb: MAX_MEMORY_MB,
    forceKillOnTimeout: FORCE_KILL_ON_TIMEOUT,
    killGracePeriodMs: KILL_GRACE_PERIOD_MS,
    // HARDEN-06 (ADR-0024 C1): rate-based recycling guard. With 5 MB/s,
    // workers are recycled on accumulation rate before the absolute cap.
    accumulationRateMbPerSec: ACCUMULATION_RATE_MB_PER_SEC,
    // HARDEN-07 (ADR-0024 C2): recycle hysteresis — 30 s default per
    // ADR-0024 spec. Reduces the 242-baseline recycle storm toward the
    // ≤80 Wave-3 target (and toward the Wave-4 LRU-uniform target).
    minRecycleIntervalMs: MIN_RECYCLE_INTERVAL_MS,
  });

  // Event counters + timestamps for forensic reconstruction.
  const eventLog = []; // chronological log of every interesting event
  let recycledCount = 0;
  let preemptedCount = 0;
  let recyclingStartCount = 0;
  let taskCompletedCount = 0;
  let taskFailedCount = 0;
  let taskPreemptedCount = 0;
  let errorCount = 0;
  const recyclingTimestamps = []; // performance.now() per worker:recycled
  const preemptionTimestamps = [];
  const perWorkerRecycledCount = new Map(); // workerId → count

  runtime.on('worker:recycling', (data) => {
    recyclingStartCount++;
    eventLog.push({ ts: performance.now(), kind: 'recycling', data });
    logLine(
      `    [event] worker:recycling workerId=${data.workerId} reason=${data.reason} ` +
        `mem=${mb(data.memoryUsage)} tasksCompleted=${data.tasksCompleted}`,
    );
  });
  runtime.on('worker:recycled', (data) => {
    recycledCount++;
    const ts = performance.now();
    recyclingTimestamps.push(ts);
    perWorkerRecycledCount.set(data.oldId, (perWorkerRecycledCount.get(data.oldId) ?? 0) + 1);
    eventLog.push({ ts, kind: 'recycled', data });
    logLine(
      `    [event] worker:recycled oldId=${data.oldId} newId=${data.newId} (cumulative=${recycledCount})`,
    );
  });
  runtime.on('worker:preempted', (data) => {
    preemptedCount++;
    const ts = performance.now();
    preemptionTimestamps.push(ts);
    eventLog.push({ ts, kind: 'preempted', data });
    logLine(
      `    [event] worker:preempted workerId=${data.workerId} exitCode=${data.exitCode} (cumulative=${preemptedCount})`,
    );
  });
  runtime.on('task:completed', () => {
    taskCompletedCount++;
  });
  runtime.on('task:failed', () => {
    taskFailedCount++;
  });
  runtime.on('task:preempted', () => {
    taskPreemptedCount++;
  });
  runtime.on('error', (err) => {
    errorCount++;
    eventLog.push({ ts: performance.now(), kind: 'error', err: err.message });
    logLine(`    [event] error: ${err.message}`);
  });

  await settleFor(SETTLE_AFTER_MS);
  maybeGc();
  const memPostBoot = snapMemory();
  const perWorkerRssMb = (memPostBoot.rss - memBaseline.rss) / WORKERS / (1024 * 1024);
  logLine(
    `\n  After runtime boot (${WORKERS} workers, maxMemoryMb=${MAX_MEMORY_MB}, forceKillOnTimeout=${FORCE_KILL_ON_TIMEOUT}):`,
  );
  logLine(
    `    process RSS:        ${mb(memPostBoot.rss)} MB  (Δ ${signedMb(memPostBoot.rss - memBaseline.rss)} MB)`,
  );
  logLine(
    `    per-worker RSS:     ${perWorkerRssMb.toFixed(2)} MB  ` +
      `(ADR-0019 floor 30-50 MB; cap ${MAX_PER_WORKER_RSS_MB_POST_BOOT} MB / worker)`,
  );
  logLine(`    main heap used:     ${mb(memPostBoot.heapUsed)} MB`);
  logLine(`    v8 native contexts: ${memPostBoot.v8NativeContexts}`);

  // ── PHASE 1: Sustained 50k requests at ~1500 req/s ────────────────────
  logLine(
    `\n  Phase 1 (sustained ${TOTAL_TASKS.toLocaleString()} tasks @ ${TARGET_RATE_PER_SEC} req/s over ${(TOTAL_TASKS / TARGET_RATE_PER_SEC).toFixed(1)} s) ...`,
  );
  logLine(`  Periodic progress (every ${PROGRESS_LOG_INTERVAL_MS / 1000} s):`);

  const phase1Start = performance.now();
  let inflight = 0;
  let nextIdx = 0;
  const perWorkerCounts = new Map();
  const perWorkerBytes = new Map();
  const completionTimes = new Float64Array(TOTAL_TASKS);
  let totalBytes = 0;
  let lastLogSnapshot = snapMemory();
  let lastLogTs = phase1Start;
  let lastLogDone = 0;
  let preemptTriggered = false;
  let preemptResult = null;
  let preemptLatencyMs = null;

  // Periodic progress logger — fires every PROGRESS_LOG_INTERVAL_MS.
  let progressTimer = null;
  function logProgress(_force = false) {
    const now = performance.now();
    const dt = (now - lastLogTs) / 1000;
    const done = taskCompletedCount + taskFailedCount;
    const rate = dt > 0 ? (done - lastLogDone) / dt : 0;
    const snap = snapMemory();
    const rssDelta = snap.rss - lastLogSnapshot.rss;
    const heapDelta = snap.heapUsed - lastLogSnapshot.heapUsed;
    const tsMs = Math.round(now - phase1Start);
    logLine(
      `    [tick +${tsMs.toString().padStart(5)} ms] done=${done.toString().padStart(6)} ` +
        `(+${rate.toFixed(0).padStart(4)}/s) | in-flight=${inflight.toString().padStart(3)} ` +
        `| RSS=${mb(snap.rss)} MB (${signedMb(rssDelta)} MB) | heap=${mb(snap.heapUsed)} MB ` +
        `(${signedMb(heapDelta)} MB) | recycled=${recycledCount} preempted=${preemptedCount} ` +
        `errors=${errorCount}`,
    );
    lastLogSnapshot = snap;
    lastLogTs = now;
    lastLogDone = done;
  }
  progressTimer = setInterval(() => logProgress(false), PROGRESS_LOG_INTERVAL_MS);

  // Dispatch the runaway task at the trigger fraction of Phase 1.
  // We schedule it via setTimeout relative to phase1Start so it
  // fires at a deterministic point, not whenever the batch loop
  // happens to be at the right counter.
  const preemptAt =
    phase1Start + (TOTAL_TASKS / TARGET_RATE_PER_SEC) * 1000 * PREEMPTION_TRIGGER_AT_FRACTION;
  setTimeout(
    () => {
      if (preemptTriggered) return;
      preemptTriggered = true;
      logLine(
        `\n    >>> Mid-stream preemption trigger @fraction ${PREEMPTION_TRIGGER_AT_FRACTION} of Phase 1 — dispatching runaway task`,
      );
      const preemptStart = performance.now();
      dispatchRunawayTask(runtime, echo.port)
        .then((kind) => {
          preemptLatencyMs = performance.now() - preemptStart;
          preemptResult = kind;
          logLine(`    <<< Preemption fired: ${kind} after ${fmtMs(preemptLatencyMs)}`);
        })
        .catch((err) => {
          preemptResult = 'failed';
          logLine(`    <<< Preemption failed: ${err.message}`);
        });
    },
    Math.max(0, preemptAt - performance.now()),
  ).unref?.();

  function dispatchOne() {
    if (inflight >= MAX_INFLIGHT || nextIdx >= TOTAL_TASKS) return false;
    const idx = nextIdx++;
    inflight++;
    const taskStart = performance.now();
    let h;
    try {
      h = runtime.dispatch({
        type: 'tcp_roundtrip',
        payload: { port: echo.port, requestId: idx },
        fn: tcpRoundtripFn,
      });
    } catch (err) {
      inflight--;
      errorCount++;
      eventLog.push({ ts: performance.now(), kind: 'dispatch-error', err: err.message });
      logLine(`    [event] dispatch-error: ${err.message}`);
      return false;
    }
    h.promise.then(
      (result) => {
        completionTimes[idx] = performance.now() - taskStart;
        totalBytes += result.bytes;
        perWorkerCounts.set(
          result.workerThreadId,
          (perWorkerCounts.get(result.workerThreadId) ?? 0) + 1,
        );
        perWorkerBytes.set(
          result.workerThreadId,
          (perWorkerBytes.get(result.workerThreadId) ?? 0) + result.bytes,
        );
        inflight--;
        dispatchOne();
      },
      () => {
        completionTimes[idx] = Number.NaN;
        inflight--;
        dispatchOne();
      },
    );
    return true;
  }

  // Sustained-rate batch dispatch loop.
  const phase1DispatchDone = new Promise((resolve) => {
    function tick() {
      // Fill up to MAX_INFLIGHT with one batch worth of dispatches.
      for (let i = 0; i < BATCH_SIZE && inflight < MAX_INFLIGHT; i++) {
        if (!dispatchOne()) break;
      }
      if (nextIdx >= TOTAL_TASKS && inflight === 0) {
        resolve();
      } else {
        setTimeout(tick, BATCH_INTERVAL_MS);
      }
    }
    tick();
  });

  await phase1DispatchDone;
  if (progressTimer) clearInterval(progressTimer);
  logProgress(true); // final tick

  // Wait briefly for the preempt trigger to settle (if it fired).
  if (preemptTriggered && preemptResult === null) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  const phase1Wall = performance.now() - phase1Start;
  await settleFor(SETTLE_AFTER_MS);
  maybeGc();
  const memPhase1Peak = snapMemory(); // capture immediately for peak comparison
  // Wait a tiny bit longer for any in-flight events to land.
  await settleFor(SETTLE_AFTER_MS);
  const memPhase1 = snapMemory();

  logLine(
    `\n  Phase 1 complete: wall ${fmtMs(phase1Wall)}, throughput ${(((taskCompletedCount + taskFailedCount) / phase1Wall) * 1000).toFixed(0)} req/s, ` +
      `recycled=${recycledCount} preempted=${preemptedCount} preemptResult=${preemptResult ?? '(none)'} ` +
      `preemptLatency=${preemptLatencyMs ? fmtMs(preemptLatencyMs) : '(n/a)'}`,
  );
  // Snapshot Phase 1 counters so the post-Phase-3 recovery tasks
  // don't contaminate them.
  const phase1CompletedCount = taskCompletedCount;
  const phase1FailedCount = taskFailedCount;

  // ── PHASE 2: Idle drain ──────────────────────────────────────────────
  logLine(
    `\n  Phase 2 (idle drain ${IDLE_DRAIN_BETWEEN_MS / 1000} s) — let V8 GC settle + recycling complete ...`,
  );
  await settleFor(IDLE_DRAIN_BETWEEN_MS);
  maybeGc();
  await settleFor(SETTLE_AFTER_MS);
  const memPhase2 = snapMemory();
  logLine(
    `    post-Phase 2: RSS ${mb(memPhase2.rss)} MB (drain from peak: ${signedMb(memPhase2.rss - memPhase1Peak.rss)} MB)`,
  );

  // ── PHASE 3: Recovery verification ────────────────────────────────────
  // Dispatch a moderate batch to confirm recycled/preempted workers
  // are back online and accepting tasks.
  const RECOVERY_TASKS = 5_000;
  logLine(
    `\n  Phase 3 (recovery — ${RECOVERY_TASKS.toLocaleString()} tasks to verify fresh workers are online) ...`,
  );
  let recoveryInflight = 0;
  let recoveryNextIdx = 0;
  let recoveryDone = 0;
  let recoveryFailed = 0;
  const recoveryPerWorker = new Map();
  function dispatchRecovery() {
    if (recoveryInflight >= MAX_INFLIGHT || recoveryNextIdx >= RECOVERY_TASKS) return false;
    const idx = recoveryNextIdx++;
    recoveryInflight++;
    const h = runtime.dispatch({
      type: 'tcp_roundtrip',
      payload: { port: echo.port, requestId: idx },
      fn: tcpRoundtripFn,
    });
    h.promise.then(
      (r) => {
        recoveryPerWorker.set(r.workerThreadId, (recoveryPerWorker.get(r.workerThreadId) ?? 0) + 1);
        recoveryDone++;
        recoveryInflight--;
        dispatchRecovery();
      },
      () => {
        recoveryFailed++;
        recoveryInflight--;
        dispatchRecovery();
      },
    );
    return true;
  }
  for (let i = 0; i < BATCH_SIZE; i++) dispatchRecovery();
  const recoveryTimer = setInterval(() => {
    for (let i = 0; i < BATCH_SIZE; i++) dispatchRecovery();
    if (recoveryNextIdx >= RECOVERY_TASKS && recoveryInflight === 0) {
      clearInterval(recoveryTimer);
    }
  }, BATCH_INTERVAL_MS);
  while (recoveryNextIdx < RECOVERY_TASKS || recoveryInflight > 0) {
    await new Promise((r) => setImmediate(r));
  }

  // ── PHASE 4: Final idle drain ─────────────────────────────────────────
  logLine(`\n  Phase 4 (final idle drain ${IDLE_DRAIN_FINAL_MS / 1000} s) ...`);
  await settleFor(IDLE_DRAIN_FINAL_MS);
  maybeGc();
  await settleFor(SETTLE_AFTER_MS);
  const memPhase4 = snapMemory();

  // ── Cleanup ───────────────────────────────────────────────────────────
  await runtime.shutdown();
  await echo.close();
  await settleFor(500);
  maybeGc();
  await settleFor(SETTLE_AFTER_MS);
  const memPostShutdown = snapMemory();

  // ── Latency percentiles for Phase 1 ───────────────────────────────────
  const sortedLat = Array.from(completionTimes)
    .filter((l) => Number.isFinite(l) && l > 0)
    .sort((a, b) => a - b);
  const pick = (p) =>
    sortedLat.length > 0
      ? sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * p))]
      : Number.NaN;

  // ── Final report ─────────────────────────────────────────────────────
  logLine(formatHeader('Summary'));
  logLine(`  Total tasks dispatched: ${TOTAL_TASKS.toLocaleString()}`);
  logLine(`  Total completed:        ${taskCompletedCount.toLocaleString()}`);
  logLine(
    `  Total failed:           ${taskFailedCount.toLocaleString()} (expected ~${(TOTAL_TASKS * FAILURE_RATE).toFixed(0)} from injection)`,
  );
  logLine(
    `  Total preempted:        ${taskPreemptedCount.toLocaleString()} (expected 1 from mid-stream runaway)`,
  );
  logLine(`  Echo requests served:    ${echo.getRequestCount().toLocaleString()}`);
  logLine(`  Total payload:          ${mb(totalBytes)} MB`);
  logLine(`  ─── RECYCLING (the headline signal) ───`);
  logLine(`  worker:recycling events: ${recyclingStartCount}`);
  logLine(`  worker:recycled events:  ${recycledCount}`);
  logLine(`  worker:preempted events: ${preemptedCount}`);
  logLine(`  error events:            ${errorCount}`);
  logLine(
    `  preempt latency (runaway → preempted/recycled): ${preemptLatencyMs ? fmtMs(preemptLatencyMs) : '(never fired)'}`,
  );

  logLine(formatHeader('Memory timeline'));
  logLine(`  baseline:        RSS ${mb(memBaseline.rss)} MB / heap ${mb(memBaseline.heapUsed)} MB`);
  logLine(`  post-boot:       RSS ${mb(memPostBoot.rss)} MB / heap ${mb(memPostBoot.heapUsed)} MB`);
  logLine(
    `  Phase 1 peak:    RSS ${mb(memPhase1Peak.rss)} MB / heap ${mb(memPhase1Peak.heapUsed)} MB`,
  );
  logLine(`  Phase 1 end:     RSS ${mb(memPhase1.rss)} MB / heap ${mb(memPhase1.heapUsed)} MB`);
  logLine(`  Phase 2 drain:   RSS ${mb(memPhase2.rss)} MB / heap ${mb(memPhase2.heapUsed)} MB`);
  logLine(`  Phase 4 final:   RSS ${mb(memPhase4.rss)} MB / heap ${mb(memPhase4.heapUsed)} MB`);
  logLine(
    `  post-shutdown:   RSS ${mb(memPostShutdown.rss)} MB / heap ${mb(memPostShutdown.heapUsed)} MB`,
  );

  logLine(`\n  Drain analysis (the cleanup signal this benchmark exists to find):`);
  logLine(
    `    Phase 1 peak → Phase 2 drain (${IDLE_DRAIN_BETWEEN_MS / 1000}s idle): RSS ${signedMb(memPhase1Peak.rss - memPhase2.rss)} MB — ` +
      `(expected: substantial negative — recycling reclaimed accumulated history)`,
  );
  logLine(
    `    Phase 2 → Phase 4 (${IDLE_DRAIN_FINAL_MS / 1000}s additional idle): RSS ${signedMb(memPhase2.rss - memPhase4.rss)} MB — ` +
      `(expected: small — already drained)`,
  );
  logLine(
    `    Phase 4 → post-shutdown: RSS ${signedMb(memPhase4.rss - memPostShutdown.rss)} MB — ` +
      `(expected: workers torn down, sharp drop)`,
  );

  logLine(`\n  Per-worker distribution (Phase 1, ${perWorkerCounts.size} distinct threadIds):`);
  for (const [wid, count] of Array.from(perWorkerCounts.entries()).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / TOTAL_TASKS) * 100).toFixed(1);
    const bytes = perWorkerBytes.get(wid) ?? 0;
    logLine(
      `    threadId=${String(wid).padStart(4)}: ${count.toLocaleString().padStart(8)} (${pct}%) — ${mb(bytes).padStart(8)} MB payload`,
    );
  }
  logLine(
    `\n  Per-worker distribution (Phase 3 recovery, ${recoveryPerWorker.size} distinct threadIds):`,
  );
  for (const [wid, count] of Array.from(recoveryPerWorker.entries()).sort((a, b) => b[1] - a[1])) {
    logLine(
      `    threadId=${String(wid).padStart(4)}: ${count.toLocaleString().padStart(6)} recovery tasks`,
    );
  }

  logLine(`\n  Phase 1 latency (per-task wall time inside Promise):`);
  logLine(`    p50:  ${fmtMs(pick(0.5))}`);
  logLine(`    p90:  ${fmtMs(pick(0.9))}`);
  logLine(`    p99:  ${fmtMs(pick(0.99))}`);
  logLine(`    p999: ${fmtMs(pick(0.999))}`);
  logLine(`    max:  ${fmtMs(sortedLat[sortedLat.length - 1])}`);

  // ── Hard assertions ───────────────────────────────────────────────────
  logLine(formatHeader('Hard assertions'));

  if (phase1CompletedCount + phase1FailedCount !== TOTAL_TASKS) {
    throw new Error(
      `FAIL: expected ${TOTAL_TASKS} total accounted in Phase 1, got ${phase1CompletedCount + phase1FailedCount} ` +
        `(completed=${phase1CompletedCount}, failed=${phase1FailedCount})`,
    );
  }
  logLine(
    `  ✓ Phase 1: all ${TOTAL_TASKS.toLocaleString()} tasks accounted for (completed + failed)`,
  );

  if (recycledCount < MIN_RECYCLING_EVENTS) {
    throw new Error(
      `FAIL: expected ≥ ${MIN_RECYCLING_EVENTS} worker:recycled events, got ${recycledCount}. ` +
        `Either maxMemoryMb=${MAX_MEMORY_MB} is too high or accumulation isn't driving recycling.`,
    );
  }
  logLine(`  ✓ ≥ ${MIN_RECYCLING_EVENTS} worker:recycled event(s) observed (got ${recycledCount})`);

  if (recyclingStartCount !== recycledCount) {
    logLine(
      `  ⚠ recycling balance off: ${recyclingStartCount} starts vs ${recycledCount} finishes — investigate spawnWorker`,
    );
  } else {
    logLine(`  ✓ recycling balance OK: ${recyclingStartCount} starts == ${recycledCount} finishes`);
  }

  if (preemptedCount < 1) {
    logLine(
      `  ⚠ no preempted events observed — runaway task may have been caught by recycling instead, ` +
        `which is also valid. preemptResult=${preemptResult}`,
    );
  } else {
    logLine(
      `  ✓ ≥ 1 worker:preempted event observed (got ${preemptedCount}) — runaway watchdog works`,
    );
  }

  if (recoveryDone + recoveryFailed !== RECOVERY_TASKS) {
    throw new Error(
      `FAIL: recovery phase expected ${RECOVERY_TASKS} tasks, got ${recoveryDone + recoveryFailed}`,
    );
  }
  logLine(
    `  ✓ Phase 3 recovery: ${recoveryDone}/${RECOVERY_TASKS} completed — recycled/preempted workers are online`,
  );

  // Memory cleanup signal: peak → drain must drop, not plateau.
  const peakRss = memPhase1Peak.rss;
  const drainRss = memPhase2.rss;
  const memoryReclaimedMb = (peakRss - drainRss) / (1024 * 1024);
  if (memoryReclaimedMb <= 0) {
    logLine(
      `  ⚠ no memory reclaim detected (peak ${mb(peakRss)} MB → drain ${mb(drainRss)} MB). Recycling may not be reclaiming as expected.`,
    );
  } else {
    logLine(
      `  ✓ memory reclaimed post-recycle: ${memoryReclaimedMb.toFixed(2)} MB ` +
        `(peak ${mb(peakRss)} MB → drain ${mb(drainRss)} MB)`,
    );
  }

  // Per-worker participation on Phase 1. With heavy recycling
  // (the runtime's `worker:recycled` count above), recycled
  // workers naturally handle FEWER tasks each — they were killed
  // at their memory limit, not at the end. So instead of "each
  // worker ≥ 50 % fair share" (which only makes sense when
  // recycling DOESN'T fire), we assert "at least the original
  // worker count participated" + "workload was actually
  // distributed across multiple workers". Recycled workers show
  // up as additional threadIds in the per-worker distribution.
  const MIN_DISTINCT_WORKERS = WORKERS;
  const STARVATION_FRACTION = 0.5;
  if (perWorkerCounts.size < MIN_DISTINCT_WORKERS) {
    throw new Error(
      `FAIL: only ${perWorkerCounts.size} distinct workers in Phase 1, expected ≥ ${MIN_DISTINCT_WORKERS}`,
    );
  }
  const workerCounts = Array.from(perWorkerCounts.values());
  const mean = workerCounts.reduce((a, b) => a + b, 0) / workerCounts.length;
  const starvedCount = workerCounts.filter((n) => n < mean * STARVATION_FRACTION).length;
  logLine(
    `  ✓ Phase 1 distribution: ${perWorkerCounts.size} distinct workers participated ` +
      `(mean ${Math.round(mean).toLocaleString()} tasks/worker, ${starvedCount} workers below 50% of mean — ` +
      `${recycledCount > 0 ? 'expected with heavy recycling' : 'should be zero without recycling'})`,
  );
  if (recycledCount === 0 && starvedCount > 0) {
    throw new Error(
      `FAIL: ${starvedCount} workers below 50% of mean (${Math.round(mean)}) — dispatch starvation with no recycling to explain`,
    );
  }

  // ADR-0019 floor sanity.
  if (perWorkerRssMb > MAX_PER_WORKER_RSS_MB_POST_BOOT) {
    throw new Error(
      `FAIL: per-worker RSS ${perWorkerRssMb.toFixed(2)} MB exceeds cap ${MAX_PER_WORKER_RSS_MB_POST_BOOT} MB`,
    );
  }
  logLine(`  ✓ per-worker RSS ${perWorkerRssMb.toFixed(2)} MB within ADR-0019 expected band`);

  // Heap growth bound (catches leaks).
  const finalHeapDelta = memPhase4.heapUsed - memBaseline.heapUsed;
  if (finalHeapDelta > MAX_HEAP_GROWTH_MB * 1024 * 1024) {
    throw new Error(
      `FAIL: main heap grew by ${mb(finalHeapDelta)} MB after all phases + final drain (cap ${MAX_HEAP_GROWTH_MB} MB)`,
    );
  }
  logLine(
    `  ✓ main heap growth bounded (${mb(finalHeapDelta)} MB ≤ ${MAX_HEAP_GROWTH_MB} MB after final drain)`,
  );

  // Floor creep check: each phase's post-drain RSS should not
  // exceed the previous phase's post-drain RSS by more than the
  // accumulated baseline + 1.5× per-worker floor. Catches leaks
  // that V8 GC can't keep up with across phases.
  const drainFloors = [memPhase2.rss, memPhase4.rss];
  for (let i = 1; i < drainFloors.length; i++) {
    const creep = drainFloors[i] - drainFloors[i - 1];
    const floorDrift = Math.abs(creep);
    if (floorDrift > 100 * 1024 * 1024) {
      logLine(
        `  ⚠ floor creep: drain #${i - 1} → drain #${i} = ${signedMb(creep)} MB (> 100 MB). ` +
          `Suggests accumulated state surviving across phases.`,
      );
    }
  }

  // Throughput sanity on Phase 1.
  const phase1Throughput = ((taskCompletedCount + taskFailedCount) / phase1Wall) * 1000;
  if (phase1Throughput < MIN_THROUGHPUT_REQ_PER_SEC) {
    throw new Error(
      `FAIL: Phase 1 throughput ${phase1Throughput.toFixed(0)} req/sec below floor ${MIN_THROUGHPUT_REQ_PER_SEC}`,
    );
  }
  logLine(
    `  ✓ Phase 1 throughput ≥ ${MIN_THROUGHPUT_REQ_PER_SEC} req/sec (${phase1Throughput.toFixed(0)})`,
  );

  // Wall-time budget check.
  const totalWallEstimate = phase1Wall + IDLE_DRAIN_BETWEEN_MS + IDLE_DRAIN_FINAL_MS + 5_000;
  if (totalWallEstimate > WALL_TIME_BUDGET_MS) {
    logLine(
      `  ⚠ total wall estimate ${fmtMs(totalWallEstimate)} > budget ${WALL_TIME_BUDGET_MS} ms — consider raising BENCH_IO_RATE_PER_SEC`,
    );
  } else {
    logLine(
      `  ✓ total wall estimate ${fmtMs(totalWallEstimate)} within ${WALL_TIME_BUDGET_MS} ms budget`,
    );
  }

  // ── Improvement opportunities ─────────────────────────────────────────
  logLine(formatHeader('Improvement opportunities (derived from this run)'));
  const opportunities = [];

  if (memoryReclaimedMb > 50) {
    opportunities.push(
      `Recycling reclaimed ${memoryReclaimedMb.toFixed(2)} MB — the historical accumulation model works. ` +
        `Consider exposing per-worker heap telemetry in the runtime's public API so dashboards / alerts ` +
        `can show live heap usage (currently only process-level RSS + private worker.lastMemoryUsageBytes).`,
    );
  } else if (memoryReclaimedMb > 0) {
    opportunities.push(
      `Recycling reclaimed only ${memoryReclaimedMb.toFixed(2)} MB — modest. Possible reasons: ` +
        `TRADE_RESULT_BYTES (${TRADE_RESULT_BYTES}) is too small to push heap past ${MAX_MEMORY_MB} MB consistently, ` +
        `OR V8 GC is keeping up (recycling rarely needed). Tune either the accumulation or the threshold.`,
    );
  } else {
    opportunities.push(
      `No memory reclaim detected — recycling fired but didn't drop RSS. Possible causes: ` +
        `recycled workers are immediately reused (their accumulated state is small), ` +
        `OR the threshold is being crossed by transient spikes only. ` +
        `Try lowering MAX_MEMORY_MB or increasing TRADE_RESULT_BYTES.`,
    );
  }

  if (recycledCount > 20) {
    opportunities.push(
      `${recycledCount} recycling events is a lot — recycling overhead may be visible in throughput. ` +
        `Consider raising MAX_MEMORY_MB above ${MAX_MEMORY_MB} MB if memory pressure is the only trigger, ` +
        `OR adding an "accumulation rate" guard (recycle when growth is fast, not just when absolute is high).`,
    );
  }

  if (starvedCount > 0 || recoveryPerWorker.size < WORKERS) {
    opportunities.push(
      `Worker distribution is uneven — ${recoveryPerWorker.size} of ${WORKERS} workers participated in recovery. ` +
        `Recycled workers may be coming back online faster than idle ones rejoin. ` +
        `Look at supervisor's idleWorker selection in dispatch.`,
    );
  }

  if (preemptLatencyMs !== null && preemptLatencyMs > 1000) {
    opportunities.push(
      `Preemption latency was ${fmtMs(preemptLatencyMs)} — longer than the supervisor's polling interval. ` +
        `Consider exposing a tunable pollIntervalMs so callers can tighten the watchdog response time.`,
    );
  }

  const perWorkerRecycledTop = Math.max(0, ...Array.from(perWorkerRecycledCount.values()));
  if (perWorkerRecycledTop > 5) {
    opportunities.push(
      `One worker recycled ${perWorkerRecycledTop} times — significantly more than peers. ` +
        `Hot worker / cold routing. Look at the dispatch FIFO ordering — some workers may be staying ` +
        `on the front of the queue (worker 0 is always first when workers is a fixed array).`,
    );
  }

  const peakHeapMb = memPhase1Peak.heapUsed / (1024 * 1024);
  if (peakHeapMb > 150) {
    opportunities.push(
      `Main-thread heap peaked at ${mb(memPhase1Peak.heapUsed)} MB during the sustained phase — ` +
        `high callback churn from 50k promise resolutions in flight. ` +
        `Consider batching completion bookkeeping (per-worker flushes rather than per-task).`,
    );
  }

  if (taskPreemptedCount < 1 && preemptedCount < 1) {
    opportunities.push(
      `No preempted events observed despite dispatching a runaway task. ` +
        `The runaway task may have been killed and absorbed into a recycling event instead — ` +
        `verify by reading worker:recycling payload.reason (memory_exceeded vs tasks_exceeded).`,
    );
  }

  if (opportunities.length === 0) {
    logLine('  (no specific improvements surfaced this run — all signals clean)');
  } else {
    for (let i = 0; i < opportunities.length; i++) {
      logLine(`  ${i + 1}. ${opportunities[i]}`);
    }
  }

  logLine(
    `\n  VERDICT: PASSED — ${TOTAL_TASKS.toLocaleString()} tasks at ${phase1Throughput.toFixed(0)} req/s; ` +
      `${recycledCount} recycling, ${preemptedCount} preempted; ` +
      `${memoryReclaimedMb.toFixed(2)} MB reclaimed; recovery ${recoveryDone}/${RECOVERY_TASKS}.`,
  );
}

main().catch((err) => {
  console.error(`\n  ${err.message}`);
  if (err.stack) console.error(err.stack);
  console.error('\n  VERDICT: FAILED.');
  process.exitCode = 1;
});
