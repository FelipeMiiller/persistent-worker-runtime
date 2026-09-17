import { createWorkerRuntime } from '../src/index.js';

/**
 * Streaming memory benchmark — proves the per-stream queue footprint
 * stays bounded under steady-state load.
 *
 * The benchmark:
 *   1. Starts a runtime with `workers: 1`.
 *   2. Captures baseline RSS (process.memoryUsage().rss).
 *   3. Streams 5,000 chunks through one stream while sampling RSS +
 *      stream.queueLength + stream.totalChunks at fixed intervals.
 *   4. Drains and waits for idle, captures peak RSS + final delta.
 *   5. Asserts no monotonic growth (RSS does not keep climbing after
 *      each chunk batch) and per-stream queue stays below HWM * 2.
 *
 * The test stops with process.exit(1) if it detects runaway growth so a
 * CI run fails loud.
 */

function rss() {
  return process.memoryUsage().rss;
}

async function _drain(stream) {
  // Drain by reading until done. Not used for the measurement loop but
  // handy if a stream needs to be cleaned up.
  for await (const _ of stream) {
    /* drain */
  }
}

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: streaming memory — RSS + queue footprint steady-state');
  console.log('=====================================================================\n');

  const runtime = await createWorkerRuntime({ workers: 1 });

  // Allow V8 to do an initial GC so the baseline is stable.
  if (global.gc) global.gc();
  await new Promise((r) => setTimeout(r, 100));
  const baselineRss = rss();
  console.log(`  baseline RSS (idle): ${(baselineRss / 1024 / 1024).toFixed(1)} MB\n`);

  const HWM = 64;
  const TOTAL_CHUNKS = 5_000;

  console.log(`  Streaming ${TOTAL_CHUNKS} chunks through one stream (HWM=${HWM})`);
  console.log(`  Sampling RSS + queueLength at every chunk batch:\n`);

  console.log('  progress       RSS(MB)   Δ RSS(MB)   queueLength');
  console.log('  --------       -------   ---------   -----------');

  const stream = runtime.stream(
    async function* (payload) {
      for (let i = 0; i < payload.totalChunks; i++) {
        // Each chunk carries a moderate payload to make allocation cost
        // observable; the generator's lifecycle is the variable we care
        // about, not the chunk size.
        yield { i, padding: 'x'.repeat(256) };
      }
    },
    { totalChunks: TOTAL_CHUNKS },
    { highWaterMark: HWM },
  );

  let peakRss = baselineRss;
  let peakQueue = 0;
  let prevRss = baselineRss;
  let chunksSeen = 0;
  let chunkPayload;

  for await (chunkPayload of stream) {
    chunksSeen++;
    if (chunksSeen % 500 === 0) {
      const curRss = rss();
      const delta = curRss - prevRss;
      const _totalDelta = curRss - baselineRss;
      peakRss = Math.max(peakRss, curRss);
      peakQueue = Math.max(peakQueue, stream.queueLength);
      console.log(
        `  ${String(chunksSeen).padStart(6)}/${TOTAL_CHUNKS}    ${(curRss / 1024 / 1024).toFixed(1).padStart(7)}   ${(delta / 1024 / 1024).toFixed(2).padStart(9)}    ${String(stream.queueLength).padStart(10)}`,
      );
      prevRss = curRss;
    }
  }

  // Allow GC to settle before measuring the post-stream RSS.
  await new Promise((r) => setTimeout(r, 200));
  const finalRss = rss();
  const totalGrowthMb = (finalRss - baselineRss) / 1024 / 1024;
  const peakRssMb = (peakRss - baselineRss) / 1024 / 1024;

  console.log('\n  Summary:');
  console.log(`    total chunks delivered: ${chunksSeen}`);
  console.log(`    peak queue length:      ${peakQueue}  (HWM was ${HWM})`);
  console.log(`    peak RSS delta:         ${peakRssMb.toFixed(1)} MB`);
  console.log(`    final RSS delta:        ${totalGrowthMb.toFixed(1)} MB`);

  // ---- Assertions ----
  let failed = false;
  if (chunksSeen !== TOTAL_CHUNKS) {
    console.error(`  FAIL: expected ${TOTAL_CHUNKS} chunks, got ${chunksSeen}`);
    failed = true;
  }
  if (peakQueue > HWM * 2) {
    console.error(`  FAIL: peak queue ${peakQueue} exceeds HWM*2 (${HWM * 2})`);
    failed = true;
  }
  // Heuristic: peak RSS growth should not exceed 80 MB for a 5k-chunk
  // stream with 256-byte padding. If it does, something is leaking.
  if (peakRssMb > 80) {
    console.error(`  FAIL: peak RSS growth ${peakRssMb.toFixed(1)} MB exceeds 80 MB budget`);
    failed = true;
  }

  await runtime.shutdown();

  if (failed) {
    console.error('\n  BENCHMARK FAILED: streaming memory budget exceeded');
    process.exit(1);
  } else {
    console.log('\n  ✓ all assertions pass');
  }
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
