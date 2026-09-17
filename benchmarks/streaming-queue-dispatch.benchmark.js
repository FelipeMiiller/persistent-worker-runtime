/**
 * Benchmark: streaming queue-dispatch latency (T5)
 *
 * When `runtime.stream()` is called while no worker is idle, the
 * request is queued in `#pendingStreams` and dispatched as soon as
 * a worker frees. This benchmark measures the round-trip latency
 * from the second `stream()` call to the first chunk of that
 * stream arriving on the consumer side.
 *
 * Why this matters: T5 introduced both `#pendingStreams` AND the
 * WorkerHandle ordering fix (teardown before onEnd). If that
 * ordering breaks, the second stream hangs forever and this
 * benchmark fails with the symptom "queued stream never delivers".
 * This benchmark is the only place in the test suite that exercises
 * the queued→active transition end-to-end with a measurement.
 *
 * Phase 1: First stream holds the worker for HOLD_MS; second stream
 *           is queued and starts dispatching on a free worker.
 * Phase 2: Same as Phase 1 but with a longer hold (1s) to verify
 *           the dispatch latency scales with the hold time, not the
 *           stream count.
 */

import { createWorkerRuntime } from '../src/index.js';

function formatMs(ms) {
  return `${ms.toFixed(2).padStart(8)} ms`;
}

async function phaseQueuedDispatch(holdMs) {
  console.log(`── Phase: queued dispatch with hold=${formatMs(holdMs)} ───────────────────`);
  const r = await createWorkerRuntime({ workers: 1 });

  // First stream — holds the only worker for `holdMs` via setTimeout.
  // While it's parked here, the second stream() call goes into
  // #pendingStreams.
  //
  // `holdMs` is passed via payload (NOT closure) because the worker
  // reconstructs the generator via `new Function(fnCode)`, which does
  // not transport closure scope — see ADR-0012 "Implementation Notes".
  const firstStart = performance.now();
  const first = r.stream(
    async function* ({ holdMs }) {
      yield 'A1';
      yield 'A2';
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      yield 'A3';
    },
    { holdMs },
  );

  // Second stream — queued, will dispatch when first finishes.
  // We start iterating immediately so the consumer is parked in
  // next() awaiting the first chunk; the time between calling
  // stream() and receiving that first chunk is the dispatch latency.
  const secondStart = performance.now();
  const second = r.stream(async function* () {
    yield 'B1';
    yield 'B2';
  });

  let firstChunks = 0;
  let secondChunks = 0;
  let firstChunkOfSecondAt = null;

  const drainFirst = (async () => {
    for await (const _chunk of first) firstChunks++;
  })();
  const drainSecond = (async () => {
    for await (const _chunk of second) {
      if (firstChunkOfSecondAt === null) firstChunkOfSecondAt = performance.now();
      secondChunks++;
    }
  })();

  await Promise.all([drainFirst, drainSecond]);
  const firstTotalMs = performance.now() - firstStart;
  const dispatchLatencyMs = firstChunkOfSecondAt - secondStart;

  console.log(`  first stream:  ${firstChunks} chunks in ${formatMs(firstTotalMs)}`);
  console.log(
    `  second stream: ${secondChunks} chunks; dispatch latency ${formatMs(dispatchLatencyMs)}`,
  );
  console.log(
    `  expected:      dispatch latency ≈ holdMs (worker freed at holdMs, then sub-ms dispatch)`,
  );

  // Latency is measured from stream() call to first chunk arrival.
  // The second stream is queued; the worker freed at holdMs; dispatch
  // is sub-ms. So latency ≈ holdMs. We accept a tolerance of ±50 ms
  // to absorb OS jitter while still failing loudly if #pendingStreams
  // is broken (latency would jump to seconds or hang).
  const dispatchOverhead = dispatchLatencyMs - holdMs;
  const success =
    firstChunks === 3 &&
    secondChunks === 2 &&
    dispatchOverhead >= -5 && // not before the worker freed
    dispatchOverhead <= 50; // dispatch itself is sub-ms, allow jitter

  if (!success) {
    console.error(
      `  FAIL: dispatch overhead ${formatMs(dispatchOverhead)} is outside [-5ms, +50ms] — likely T5 regression`,
    );
  } else {
    console.log(
      `  ✓ second stream dispatched ${formatMs(dispatchOverhead)} after the worker freed`,
    );
  }
  console.log('');
  await r.shutdown();
  return success;
}

async function main() {
  console.log(
    '=====================================================================\n' +
      'BENCHMARK: streaming queue-dispatch latency (T5 #pendingStreams)\n' +
      '=====================================================================',
  );

  const ok1 = await phaseQueuedDispatch(80);
  const ok2 = await phaseQueuedDispatch(200);

  if (!(ok1 && ok2)) {
    console.error('BENCHMARK FAILED');
    process.exit(1);
  }
  console.log('All phases passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
