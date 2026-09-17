import { createWorkerRuntime } from '../src/index.js';

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: streaming throughput — chunks/sec by stream length + HWM');
  console.log('=====================================================================\n');

  const runtime = await createWorkerRuntime({ workers: 1 });

  // The matrix below intentionally uses SMALL stream lengths so the
  // benchmark runs in seconds. A production-scale benchmark lives in
  // benchmarks/streaming-stress.benchmark.js (separate file).
  const matrix = [
    { length: 100, hwm: 16 },
    { length: 100, hwm: 256 },
    { length: 1_000, hwm: 16 },
    { length: 1_000, hwm: 256 },
    { length: 10_000, hwm: 64 },
    { length: 10_000, hwm: 1024 },
  ];

  console.log(`stream length × highWaterMark — measuring chunks/sec + first-chunk latency\n`);
  console.log('  length       HWM       first-chunk(ms)  total(ms)   chunks/sec');
  console.log('  -----------  --------  --------------  ---------  -----------');

  const results = [];
  for (const { length, hwm } of matrix) {
    const stream = runtime.stream(
      async function* (payload) {
        for (let i = 0; i < payload.length; i++) yield { i, padding: 'x'.repeat(64) };
      },
      { length },
      { highWaterMark: hwm },
    );

    const t0 = performance.now();
    let firstChunkAt = null;
    let count = 0;
    for await (const _ of stream) {
      if (firstChunkAt === null) firstChunkAt = performance.now() - t0;
      count++;
    }
    const totalMs = performance.now() - t0;
    const chunksPerSec = (count / totalMs) * 1000;
    results.push({ length, hwm, firstChunkMs: firstChunkAt, totalMs, chunksPerSec });
    console.log(
      `  ${String(length).padStart(10)}  ${String(hwm).padStart(8)}  ${firstChunkAt.toFixed(2).padStart(14)}  ${totalMs.toFixed(2).padStart(10)}  ${chunksPerSec.toFixed(0).padStart(10)}`,
    );
  }

  console.log('\nObservations:');
  const smallest = results.find((r) => r.length === 100);
  const largest = results.find((r) => r.length === 10_000);
  if (smallest && largest) {
    const scaleFactor = largest.chunksPerSec / smallest.chunksPerSec;
    console.log(`  - chunks/sec ratio (10k / 100 streams): ${scaleFactor.toFixed(2)}x`);
  }
  const lowHwm = results.find((r) => r.length === 1_000 && r.hwm === 16);
  const highHwm = results.find((r) => r.length === 1_000 && r.hwm === 256);
  if (lowHwm && highHwm) {
    console.log(
      `  - highWaterMark impact (1k stream): low HWM=${lowHwm.chunksPerSec.toFixed(0)} chunks/s, high HWM=${highHwm.chunksPerSec.toFixed(0)} chunks/s`,
    );
  }

  await runtime.shutdown();
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
