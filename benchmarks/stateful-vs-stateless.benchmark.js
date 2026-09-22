import { createWorkerRuntime } from '../src/index.js';

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: Persistent L1 Worker-Local Memory vs. Stateless Reloading');
  console.log('=====================================================================\n');

  const runtime = await createWorkerRuntime({ workers: 2 });
  const iterations = 50;

  // 1. STATELESS MODE: Every task has to re-generate / re-parse heavy state
  console.log(
    `[1/2] STATELESS: Executing ${iterations} tasks that RE-ALLOCATE a 200,000-item dictionary each time...`,
  );
  const statelessStart = performance.now();

  for (let i = 0; i < iterations; i++) {
    await runtime.execute({
      type: 'stateless_lookup',
      payload: { queryKey: `item_${i % 1000}` },
      fn: (p) => {
        // Simulates cold loading / parsing on every execution
        const lookup = new Map();
        for (let j = 0; j < 200000; j++) {
          lookup.set(`item_${j}`, j * 2);
        }
        return lookup.get(p.queryKey);
      },
    });
  }

  const statelessDuration = performance.now() - statelessStart;
  console.log(`  -> Stateless Total Time: ${statelessDuration.toFixed(2)}ms`);
  console.log(`  -> Average Latency per task: ${(statelessDuration / iterations).toFixed(2)}ms\n`);

  // 2. STATEFUL MODE: Worker allocates state ONCE in L1 memory, subsequent tasks are instant
  console.log(
    `[2/2] STATEFUL (L1 Memory): Initializing state ONCE, then executing ${iterations} queries...`,
  );
  const statefulWorker = await runtime.createWorker({ name: 'warm-cache-worker' });
  const statefulStart = performance.now();

  // Warm-up phase: load once into L1
  await statefulWorker.executeDirectTask('__init__', null);
  const warmTask = new (await import('../src/task-handle.js')).TaskHandle({
    type: 'init_warm_cache',
    fn: (_, state) => {
      const lookup = new Map();
      for (let j = 0; j < 200000; j++) {
        lookup.set(`item_${j}`, j * 2);
      }
      state.set('large_dictionary', lookup);
      return 'initialized';
    },
  });
  await statefulWorker.executeTask(warmTask);

  // Query phase: reads directly from warm L1 memory
  for (let i = 0; i < iterations; i++) {
    const queryTask = new (await import('../src/task-handle.js')).TaskHandle({
      type: 'query_warm_cache',
      payload: { queryKey: `item_${i % 1000}` },
      fn: (p, state) => {
        const lookup = state.get('large_dictionary');
        return lookup.get(p.queryKey);
      },
    });
    await statefulWorker.executeTask(queryTask);
  }

  const statefulDuration = performance.now() - statefulStart;
  console.log(`  -> Stateful Total Time: ${statefulDuration.toFixed(2)}ms (including warm-up)`);
  console.log(`  -> Average Latency per task: ${(statefulDuration / iterations).toFixed(2)}ms`);
  console.log(`  -> Speedup: ${(statelessDuration / statefulDuration).toFixed(1)}x faster!\n`);

  await statefulWorker.terminate();
  await runtime.shutdown();

  console.log('=====================================================================');
  console.log('CONCLUSION:');
  console.log(
    `- Persistent L1 memory provides a ${(statelessDuration / statefulDuration).toFixed(1)}x latency improvement.`,
  );
  console.log('- Zero re-parsing / re-allocation overhead across tasks!');
  console.log('=====================================================================');
}

runBenchmark().catch(console.error);
