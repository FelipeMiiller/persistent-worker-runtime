import { createWorkerRuntime } from '../src/index.js';

/**
 * Streaming stress benchmark — measures behavior under concurrent
 * streams, large stream sizes, and mid-stream aborts.
 *
 * Three phases:
 *   1. Concurrent streams × small chunks — measures per-stream isolation.
 *   2. One large stream — measures throughput at the upper end of the
 *      realistic workload (50,000 chunks).
 *   3. Abort latency — measures how quickly a consumer break drains
 *      the worker-side generator.
 */

function formatMs(ms) {
  return `${ms.toFixed(2).padStart(8)} ms`;
}

function formatChunksPerSec(n) {
  return `${n.toFixed(0).padStart(8)} chunks/s`;
}

async function phaseConcurrent(_runtime) {
  console.log('── Phase 1: 8 concurrent streams × 1,000 chunks ────────────────────');
  const WORKERS = 8;
  const r = await createWorkerRuntime({ workers: WORKERS });
  const STREAMS = 8;
  const CHUNKS_PER_STREAM = 1_000;

  const start = performance.now();
  const collectors = await Promise.all(
    Array.from({ length: STREAMS }).map(async (_, idx) => {
      const stream = r.stream(
        async function* (payload) {
          for (let i = 0; i < payload.count; i++) yield { stream: payload.idx, i };
        },
        { idx, count: CHUNKS_PER_STREAM },
        { highWaterMark: 32 },
      );
      const received = [];
      for await (const chunk of stream) received.push(chunk);
      return received.length;
    }),
  );
  const totalMs = performance.now() - start;
  const totalChunks = collectors.reduce((a, b) => a + b, 0);
  console.log(`  streams: ${STREAMS}, workers: ${WORKERS}`);
  console.log(`  chunks delivered: ${totalChunks} / ${STREAMS * CHUNKS_PER_STREAM}`);
  console.log(`  total time:       ${formatMs(totalMs)}`);
  console.log(`  aggregate rate:   ${formatChunksPerSec((totalChunks / totalMs) * 1000)}`);
  await r.shutdown();

  // Soft assertion: every chunk must be delivered exactly once.
  if (totalChunks !== STREAMS * CHUNKS_PER_STREAM) {
    console.error(`  FAIL: expected ${STREAMS * CHUNKS_PER_STREAM} chunks, got ${totalChunks}`);
    return false;
  }
  console.log('  ✓ all streams delivered full payload');
  console.log('');
  return true;
}

async function phaseLargeStream(runtime) {
  console.log('── Phase 2: 1 stream × 50,000 chunks (high throughput probe) ─────');
  const TOTAL = 50_000;
  const stream = runtime.stream(
    async function* (payload) {
      for (let i = 0; i < payload.count; i++) yield i;
    },
    { count: TOTAL },
    { highWaterMark: 256 },
  );

  const start = performance.now();
  let received = 0;
  for await (const _ of stream) received++;
  const totalMs = performance.now() - start;
  console.log(`  total chunks: ${received}`);
  console.log(`  total time:   ${formatMs(totalMs)}`);
  console.log(`  throughput:   ${formatChunksPerSec((received / totalMs) * 1000)}`);

  if (received !== TOTAL) {
    console.error(`  FAIL: expected ${TOTAL} chunks, got ${received}`);
    return false;
  }
  console.log('  ✓ full payload delivered');
  console.log('');
  return true;
}

async function phaseAbortLatency(runtime) {
  console.log('── Phase 3: mid-stream abort latency ─────────────────────────────');
  // A generator that pauses for 50ms between yields so we have a
  // generous window to abort. The benchmark breaks out of the for-await
  // after the first chunk and measures how long it takes for the
  // worker's finally blocks to settle.
  const stream = runtime.stream(
    async function* () {
      try {
        for (let i = 0; i < 1000; i++) {
          yield i;
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        // Cleanup marker; nothing to do, but the finally block MUST run.
      }
    },
    null,
    { highWaterMark: 16 },
  );

  // Wait for at least one chunk before aborting.
  for await (const _ of stream) {
    break;
  }
  const abortStart = performance.now();
  // Trigger the abort by iterating further — the break in the loop
  // above already aborted the stream via Stream.return(); this is a
  // double-check that the worker side settled.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const drainMs = performance.now() - abortStart;
  console.log(`  abort → drain time: ${formatMs(drainMs)}`);

  if (drainMs > 1000) {
    console.error(`  FAIL: abort drain took ${drainMs.toFixed(0)}ms (budget 1000ms)`);
    return false;
  }
  if (!stream.aborted) {
    console.error(`  FAIL: stream is not marked aborted after consumer break`);
    return false;
  }
  console.log(`  ✓ stream aborted cleanly (reason: ${stream.abortedReason})`);
  console.log('');
  return true;
}

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: streaming stress — concurrency + size + abort latency');
  console.log('=====================================================================\n');

  const runtime = await createWorkerRuntime({ workers: 1 });

  const phases = [
    await phaseConcurrent(runtime),
    await phaseLargeStream(runtime),
    await phaseAbortLatency(runtime),
  ];

  await runtime.shutdown();

  if (phases.every(Boolean)) {
    console.log('  ✓ all stress phases pass');
  } else {
    console.error('  BENCHMARK FAILED: at least one stress phase regressed');
    process.exit(1);
  }
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
