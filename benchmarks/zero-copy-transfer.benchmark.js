import { createWorkerRuntime } from '../src/index.js';

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: Zero-Copy ArrayBuffer Transfer vs. Structured Clone');
  console.log('=====================================================================\n');

  const bufferSizeMb = 16;
  const bufferBytes = bufferSizeMb * 1024 * 1024;
  const iterations = 50;

  const runtime = await createWorkerRuntime({ workers: 2 });
  await new Promise((r) => setTimeout(r, 50));

  // === Test 1: Zero-copy via transferList ===
  console.log(`[1/2] Transferring ${bufferSizeMb}MB ArrayBuffer via transferList (zero-copy)...`);
  const transferStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const buf = new ArrayBuffer(bufferBytes);
    const result = await runtime.execute({
      type: 'sum_bytes',
      payload: { buffer: buf },
      transferList: [buf],
      fn: (p) => {
        const view = new Uint8Array(p.buffer);
        let sum = 0;
        for (let j = 0; j < view.length; j += 4096) sum += view[j];
        return { byteLength: view.byteLength, sum };
      },
    });
    if (result.byteLength !== bufferBytes) throw new Error('size mismatch');
  }
  const transferDuration = performance.now() - transferStart;
  const transferPerOp = transferDuration / iterations;
  console.log(`  -> ${iterations} transfers in: ${transferDuration.toFixed(2)}ms`);
  console.log(`  -> Per-op latency: ${transferPerOp.toFixed(3)}ms`);
  console.log(`  -> Throughput: ${((bufferBytes * iterations) / (1024 * 1024) / (transferDuration / 1000)).toFixed(2)} MB/s\n`);

  // === Test 2: Structured clone (default; copies the buffer) ===
  console.log(`[2/2] Transferring ${bufferSizeMb}MB ArrayBuffer via structured clone (copy)...`);
  const cloneStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const buf = new ArrayBuffer(bufferBytes);
    const result = await runtime.execute({
      type: 'sum_bytes',
      payload: { buffer: buf },
      // No transferList -> structured clone copies the buffer
      fn: (p) => {
        const view = new Uint8Array(p.buffer);
        let sum = 0;
        for (let j = 0; j < view.length; j += 4096) sum += view[j];
        return { byteLength: view.byteLength, sum };
      },
    });
    if (result.byteLength !== bufferBytes) throw new Error('size mismatch');
  }
  const cloneDuration = performance.now() - cloneStart;
  const clonePerOp = cloneDuration / iterations;
  console.log(`  -> ${iterations} copies in: ${cloneDuration.toFixed(2)}ms`);
  console.log(`  -> Per-op latency: ${clonePerOp.toFixed(3)}ms`);
  console.log(`  -> Throughput: ${((bufferBytes * iterations) / (1024 * 1024) / (cloneDuration / 1000)).toFixed(2)} MB/s\n`);

  await runtime.shutdown();

  const speedup = cloneDuration / transferDuration;
  console.log('=====================================================================');
  console.log('CONCLUSION:');
  console.log(`- Zero-copy transferList is ${speedup.toFixed(2)}x faster than structured clone for ${bufferSizeMb}MB buffers.`);
  console.log(`- Per-op cost drops from ${clonePerOp.toFixed(3)}ms to ${transferPerOp.toFixed(3)}ms.`);
  console.log(`- For multi-megabyte payloads (audio, video, ML tensors), transferList is mandatory.`);
  console.log('=====================================================================');
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
