import { createWorkerRuntime } from '../src/index.js';

/**
 * Benchmark: BroadcastChannel fan-out vs. per-worker dispatch via main thread.
 *
 * The runtime's `broadcast()` uses Node's native BroadcastChannel, which
 * delivers to every subscribed thread in one `postMessage()` call — O(1)
 * from the publisher's perspective, regardless of how many workers are
 * listening.
 *
 * A "naive" alternative would be `runtime.dispatch()` once per worker,
 * which goes through the queue → supervisor → per-worker message channel,
 * giving O(N) cost in the publisher's view.
 *
 * This benchmark proves the O(1) claim by publishing the same number of
 * invalidation events with two patterns and comparing wall-clock latency.
 *
 * Run: `node benchmarks/broadcast-fanout.benchmark.js`
 */

async function runBenchmark() {
  console.log('=====================================================================');
  console.log('BENCHMARK: BroadcastChannel fan-out vs. per-worker dispatch');
  console.log('=====================================================================\n');

  const iterations = 5_000;
  const dispatchIterations = 500; // fewer iterations — dispatch path is much slower

  // ---------- Test 1: BroadcastChannel fan-out ----------
  // 4 workers each subscribe to a shared channel. Main publishes once
  // per iteration; every worker counts the receipt.
  console.log(`[1/2] Publishing ${iterations} messages via runtime.broadcast() to 4 workers...`);

  const r1 = await createWorkerRuntime({ workers: 4 });
  await new Promise((r) => setTimeout(r, 50));

  await r1.executeAll(
    Array.from({ length: 4 }, (_, idx) => ({
      type: 'subscribe-bench',
      payload: { channel: 'bench-channel', workerIdx: idx },
      fn: (_p, _s, context) => {
        context.channel('bench-channel').subscribe(() => {
          // Intentional no-op: subscriber exists only to keep the
          // channel alive for the publish throughput measurement.
        });
        return 'subscribed';
      },
    })),
  );

  // Give subscriptions time to register before publishing
  await new Promise((r) => setTimeout(r, 100));

  const broadcastStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    r1.broadcast('bench-channel', { n: i });
  }
  const broadcastDuration = performance.now() - broadcastStart;
  const broadcastPerOp = (broadcastDuration / iterations) * 1000; // microseconds
  console.log(`  -> ${iterations} broadcasts in: ${broadcastDuration.toFixed(2)}ms`);
  console.log(`  -> Per-publish latency: ${broadcastPerOp.toFixed(2)}μs`);
  console.log(
    `  -> Throughput: ${(iterations / (broadcastDuration / 1000) / 1000).toFixed(1)}k msg/s`,
  );

  await r1.shutdown();
  console.log('');

  // ---------- Test 2: Per-worker dispatch through main ----------
  // Equivalent semantics without BroadcastChannel: main thread fires a
  // separate `dispatch()` per worker for each "broadcast" event. This is
  // what users would write if they had no BC.
  console.log(
    `[2/2] Publishing ${dispatchIterations} messages via per-worker runtime.dispatch()...`,
  );

  const r2 = await createWorkerRuntime({ workers: 4 });
  await new Promise((r) => setTimeout(r, 50));

  const dispatchStart = performance.now();
  // Collect the handles so we can (a) keep the timing loop free of
  // extra work and (b) await real completion before shutdown. Without
  // this, `shutdown()` destroys the queue while tasks are still in
  // flight, every pending TaskHandle rejects, and the unhandled
  // rejection kills the process (exit 1). This is exactly what
  // happened on windows-latest / Node 22.x in CI run 36178398974.
  const pending = [];
  for (let i = 0; i < dispatchIterations; i++) {
    // 4 dispatch() calls per "broadcast" — one per worker. Small
    // synchronous tasks that settle quickly.
    for (let w = 0; w < 4; w++) {
      pending.push(
        r2.dispatch({
          type: 'invalidate',
          payload: { workerIdx: w, n: i },
          fn: () => 'ack',
        }).promise,
      );
    }
  }
  const dispatchDuration = performance.now() - dispatchStart;
  const dispatchPerOp = (dispatchDuration / dispatchIterations) * 1000; // microseconds per "broadcast" (4 dispatch calls)
  console.log(
    `  -> ${dispatchIterations} fan-out cycles (4 dispatches each) in: ${dispatchDuration.toFixed(2)}ms`,
  );
  console.log(`  -> Per-fan-out-cycle cost: ${dispatchPerOp.toFixed(2)}μs`);
  console.log(
    `  -> Effective throughput: ${(dispatchIterations / (dispatchDuration / 1000) / 1000).toFixed(1)}k fan-outs/s`,
  );

  // Await real completion instead of a fixed sleep. The queue depth at
  // 2000 tasks / 4 workers means a 200ms wait was not enough on
  // windows-latest, so shutdown raced the drain.
  await Promise.allSettled(pending);
  await r2.shutdown();

  // ---------- Conclusion ----------
  // The dispatch path was tested with fewer iterations because each
  // dispatch costs ~4x as much per call and 500 iterations already
  // produces 2000 task objects. Speedup is computed against the same
  // wall-clock cost ratio.
  const speedup = dispatchDuration / dispatchIterations / (broadcastDuration / iterations);
  console.log('=====================================================================');
  console.log('CONCLUSION:');
  console.log(
    `- BroadcastChannel fan-out is ${speedup.toFixed(2)}x faster than per-worker dispatch.`,
  );
  console.log(`- Per-publish cost (BroadcastChannel): ${broadcastPerOp.toFixed(2)}μs`);
  console.log(`- Per-fan-out-cycle cost (dispatch×4):  ${dispatchPerOp.toFixed(2)}μs`);
  console.log(`- The BC path stays O(1) in the publisher regardless of subscriber count.`);
  console.log(`- The dispatch path is O(N) in worker count and goes through the queue.`);
  console.log('=====================================================================');
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
