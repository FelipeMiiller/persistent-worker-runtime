import { createWorkerRuntime } from '../src/index.js';

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: Transactional Outbox Background Dispatch Ingestion');
  console.log('=====================================================================\n');

  const runtime = await createWorkerRuntime({ workers: 4, maxQueueSize: 5000 });
  const count = 2000;

  console.log(`Dispatching ${count} background outbox tasks concurrently...`);

  const dispatchStart = performance.now();
  const confirmations = [];

  for (let i = 0; i < count; i++) {
    const handle = runtime.dispatch({
      type: 'outbox_email',
      payload: { outboxId: i, to: `user_${i}@domain.com` },
      fn: (p) => ({ sent: true, outboxId: p.outboxId }),
    });

    confirmations.push(
      new Promise((resolve) => {
        handle.onComplete((res) => resolve(res));
      }),
    );
  }

  const dispatchIngestionTime = performance.now() - dispatchStart;
  console.log(
    `  -> Main Thread Ingestion Time (non-blocking): ${dispatchIngestionTime.toFixed(2)}ms`,
  );
  console.log(
    `  -> Ingestion Rate: ${(count / (dispatchIngestionTime / 1000)).toFixed(0)} tasks dispatched/second`,
  );
  console.log('  -> Main thread was immediately free to return HTTP 201 responses!\n');

  console.log('Waiting for background workers to complete all outbox confirmations...');
  const processStart = performance.now();
  await Promise.all(confirmations);
  const totalProcessTime = performance.now() - processStart;

  console.log(
    `  -> All ${count} tasks processed and confirmed in: ${totalProcessTime.toFixed(2)}ms`,
  );
  console.log(
    `  -> Worker Processing Throughput: ${(count / (totalProcessTime / 1000)).toFixed(0)} jobs/sec\n`,
  );

  await runtime.shutdown();

  console.log('=====================================================================');
  console.log('CONCLUSION:');
  console.log(
    `- Main Thread in-memory dispatch rate exceeds ${(count / (dispatchIngestionTime / 1000)).toFixed(0)} jobs/sec.`,
  );
  console.log(
    '- Enables instant HTTP response times while workers process outbox tasks off-thread.',
  );
  console.log('=====================================================================');
}

runBenchmark().catch(console.error);
