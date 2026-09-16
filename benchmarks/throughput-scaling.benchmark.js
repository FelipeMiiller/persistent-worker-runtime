import { createWorkerRuntime } from '../src/index.js';
import { availableParallelism } from 'node:os';

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: Throughput Scaling vs. Worker Count');
  console.log('=====================================================================\n');

  const tasksPerTrial = 1000;
  const workload = (p) => {
    // Simulate CPU work: tight integer math
    let acc = 0;
    for (let i = 0; i < 50000; i++) acc = (acc * 31 + i) % 9973;
    return { seed: p.seed, acc };
  };

  const cpuCount = availableParallelism();
  const workerCounts = [1, 2, 4, Math.max(8, cpuCount)];

  console.log(`System: ${cpuCount} logical cores available`);
  console.log(`Workload: ${tasksPerTrial} tasks × 50k-iteration inner loop each\n`);

  const results = [];

  for (const workers of workerCounts) {
    const runtime = await createWorkerRuntime({ workers });

    const tasks = [];
    for (let i = 0; i < tasksPerTrial; i++) {
      tasks.push({ type: 'cpu', payload: { seed: i }, fn: workload });
    }

    const start = performance.now();
    await runtime.executeAll(tasks);
    const duration = performance.now() - start;
    const throughput = tasksPerTrial / (duration / 1000);

    results.push({ workers, durationMs: duration, throughput });
    console.log(
      `  workers=${String(workers).padStart(2)}: ${duration.toFixed(0)}ms total -> ${throughput.toFixed(0)} tasks/sec`
    );

    await runtime.shutdown();
  }

  // Scaling efficiency
  const baseline = results[0].throughput;
  console.log('\nScaling efficiency (vs 1-worker baseline):');
  for (const r of results) {
    const ideal = baseline * r.workers;
    const efficiency = (r.throughput / ideal) * 100;
    console.log(
      `  ${String(r.workers).padStart(2)} workers: ${r.throughput.toFixed(0)} tasks/sec (${efficiency.toFixed(1)}% of ideal linear scaling)`
    );
  }

  console.log('\n=====================================================================');
  console.log('CONCLUSION:');
  console.log('- Throughput scales with worker count up to the CPU core limit.');
  console.log('- Beyond availableParallelism(), contention introduces diminishing returns.');
  console.log('- For I/O-bound work, oversubscription is acceptable; for CPU-bound, match core count.');
  console.log('=====================================================================');
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
