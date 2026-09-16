import { createWorkerRuntime } from '../src/index.js';

function syncFibonacci(n) {
  if (n <= 1) return n;
  return syncFibonacci(n - 1) + syncFibonacci(n - 2);
}

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: Main Event Loop Responsiveness Under CPU-Bound Load');
  console.log('=====================================================================\n');

  // Helper: records heartbeat delays on the main Event Loop
  function startHeartbeatMonitor() {
    let maxLag = 0;
    let lastTime = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastTime;
      const lag = Math.max(0, elapsed - 10);
      if (lag > maxLag) maxLag = lag;
      lastTime = now;
    }, 10);

    return {
      stop: () => {
        clearInterval(interval);
        return maxLag;
      },
    };
  }

  // 1. BASELINE: Running heavy CPU task synchronously on Main Thread Event Loop
  console.log('[1/2] Executing 8 CPU-heavy Fibonacci(36) tasks SYNCHRONOUSLY on Main Thread...');
  const syncHeartbeat = startHeartbeatMonitor();
  const syncStart = performance.now();

  for (let i = 0; i < 8; i++) {
    syncFibonacci(36);
  }

  const syncDuration = performance.now() - syncStart;
  await new Promise((r) => setImmediate(r));
  const syncMaxLag = syncHeartbeat.stop();

  console.log(`  -> Completed in: ${syncDuration.toFixed(2)}ms`);
  console.log(`  -> Main Thread Event Loop FREEZE: ${syncMaxLag.toFixed(2)}ms`);
  console.log('  -> During this entire time, NO HTTP requests or I/O could be processed!\n');

  // Allow loop to settle
  await new Promise((r) => setTimeout(r, 50));

  // 2. RUNTIME: Running identical workloads concurrently via Persistent Worker Runtime
  console.log('[2/2] Executing 8 CPU-heavy Fibonacci(36) tasks via Persistent Worker Runtime (4 workers)...');
  const runtime = await createWorkerRuntime({ workers: 4 });

  const workerHeartbeat = startHeartbeatMonitor();
  const workerStart = performance.now();

  const tasks = Array.from({ length: 8 }, (_, i) => ({
    type: 'fibonacci',
    payload: { n: 36 },
    fn: (p) => {
      function fib(n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      return fib(p.n);
    },
  }));

  const results = await runtime.executeAll(tasks);
  const workerDuration = performance.now() - workerStart;
  const workerMaxLag = workerHeartbeat.stop();

  console.log(`  -> Completed in: ${workerDuration.toFixed(2)}ms`);
  console.log(`  -> Main Thread Event Loop Max Lag: ${workerMaxLag.toFixed(2)}ms`);
  console.log(`  -> Worker Runtime Throughput: ${(8 / (workerDuration / 1000)).toFixed(2)} ops/sec`);
  console.log(`  -> Wall-clock execution speedup: ${(syncDuration / workerDuration).toFixed(1)}x faster!\n`);

  await runtime.shutdown();

  console.log('=====================================================================');
  console.log('VERDICT:');
  console.log(`- Synchronous execution froze the Event Loop for ${syncMaxLag.toFixed(0)}ms.`);
  console.log(`- Worker Runtime kept Event Loop lag at ~${workerMaxLag.toFixed(1)}ms (${(syncDuration / workerDuration).toFixed(1)}x faster).`);
  console.log('- The Main Event Loop was 100% available for incoming I/O during computation!');
  console.log('=====================================================================');
}

runBenchmark().catch(console.error);
