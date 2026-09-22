/**
 * Priority routing example.
 *
 * Demonstrates how to use `priority` to ensure critical work runs first
 * without blocking the Event Loop. Common use cases:
 * - Premium-tier requests before free-tier requests
 * - Live chat messages before batch analytics
 * - Time-sensitive webhooks before housekeeping jobs
 *
 * Run: `node examples/priority-routing.js`
 */

import { createWorkerRuntime } from '../src/index.js';

async function main() {
  const runtime = await createWorkerRuntime({ workers: 2 });

  const completionLog = [];

  // 1) Submit 30 "batch" (low priority) tasks first.
  for (let i = 0; i < 30; i++) {
    const handle = runtime.dispatch({
      type: 'batch_job',
      payload: { id: `batch_${i}`, work: 1 },
      priority: 0,
      fn: (p) => ({ id: p.id, priority: 0 }),
    });
    handle.onComplete((r) => completionLog.push(r));
  }

  // 2) Then submit 5 "interactive" (high priority) tasks.
  //    Even though they were submitted AFTER the batch tasks, they should
  //    be dequeued first because of higher priority.
  for (let i = 0; i < 5; i++) {
    const handle = runtime.dispatch({
      type: 'interactive_request',
      payload: { id: `interactive_${i}`, work: 1 },
      priority: 10,
      fn: (p) => ({ id: p.id, priority: 10 }),
    });
    handle.onComplete((r) => completionLog.push(r));
  }

  // 3) Wait for all to complete.
  await new Promise((r) => setTimeout(r, 2000));

  // 4) Inspect completion order.
  const firstInteractiveIdx = completionLog.findIndex((r) => r.priority === 10);
  const lastInteractiveIdx = completionLog.map((r) => r.priority).lastIndexOf(10);
  const firstBatchIdx = completionLog.findIndex((r) => r.priority === 0);

  console.log('Completion order (first 10):', completionLog.slice(0, 10));
  console.log(`First interactive completed at index: ${firstInteractiveIdx}`);
  console.log(`Last interactive completed at index:  ${lastInteractiveIdx}`);
  console.log(`First batch completed at index:       ${firstBatchIdx}`);

  if (lastInteractiveIdx < firstBatchIdx) {
    console.log('\n✅ All interactive tasks completed before any batch task.');
  } else {
    console.log('\n⚠️  Some batch tasks ran before interactive tasks completed.');
  }

  await runtime.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
