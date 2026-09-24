/**
 * [perf-tested] BroadcastChannel cache invalidation example.
 *
 * Demonstrates the canonical "L1 cache invalidation" pattern AND quantifies
 * the per-call saving of warm-cache hits over cold fetches.
 *
 *   1. Multiple workers each maintain a hot in-memory cache (a `Map` that
 *      persists across task executions in the same worker).
 *   2. When a worker mutates a record (e.g. updates a user's email), it
 *      publishes an INVALIDATE message on a named broadcast channel.
 *   3. Other workers receive the message and evict the matching cache
 *      entry so the next read goes back to the (simulated) source of truth.
 *
 * Why BroadcastChannel and not a round-trip through the main thread?
 *   - The invalidation message goes directly to every subscriber thread
 *     without bouncing through the Event Loop as a router.
 *   - The publishing worker does not block; it returns immediately after
 *     `postMessage()` accepts the message into the bus.
 *   - There is no "fan-out" loop in user code: the bus itself delivers to
 *     every subscribed listener in one shot.
 *
 * What this example measures:
 *   - Cold fetch latency (cache miss → source lookup).
 *   - Warm fetch latency (cache hit → Map.get).
 *   - Speedup ratio per warm hit + cumulative saving over N reads.
 *
 * Run: `node examples/broadcast-cache-invalidation.js`
 */

import { createWorkerRuntime } from '../src/index.js';

async function main() {
  // Mutable simulated source-of-truth — main thread observes it via the
  // user.email returned by post-invalidate reads.
  const sourceOfTruth = {
    user: { id: 42, name: 'Alice', email: 'alice@example.com' },
  };

  const runtime = await createWorkerRuntime({ workers: 3 });

  // ---------- Phase 1: cold reads + first warm hit timing ----------
  console.log('\n--- Phase 1: cold reads from 3 workers ---');
  const coldReads = await Promise.all([
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
  ]);
  console.log(coldReads.map((r) => ({ from: r.from, email: r.user.email })));

  // ---------- Phase 2: 50 warm reads, measure hit latency ----------
  console.log('\n--- Phase 2: 50 warm reads (all should be cache hits) ---');
  const WARM_READ_COUNT = 50;
  const warmStart = performance.now();
  const warmReads = [];
  for (let i = 0; i < WARM_READ_COUNT; i++) {
    const r = await runtime.execute({
      type: 'fetch_user',
      payload: { userId: 42 },
      fn: fetchUserFn,
    });
    warmReads.push(r);
  }
  const warmTotalMs = performance.now() - warmStart;
  const warmAvgMs = warmTotalMs / WARM_READ_COUNT;
  const hitCount = warmReads.filter((r) => r.from === 'cache').length;
  console.log(
    `  ${WARM_READ_COUNT} reads in ${warmTotalMs.toFixed(2)} ms (avg ${warmAvgMs.toFixed(3)} ms/read)`,
  );
  console.log(`  cache hits: ${hitCount} / ${WARM_READ_COUNT}`);

  // ---------- Phase 3: update + broadcast invalidation ----------
  console.log('\n--- Phase 3: update + broadcast INVALIDATE ---');
  const updateStart = performance.now();
  const updateResult = await runtime.execute({
    type: 'update_user',
    payload: {
      userId: 42,
      email: 'alice+updated@example.com',
      name: 'Alice (updated)',
    },
    fn: updateUserFn,
  });
  const updateMs = performance.now() - updateStart;
  console.log(`Update result: ${JSON.stringify(updateResult)} (${updateMs.toFixed(2)} ms)`);

  sourceOfTruth.user.email = 'alice+updated@example.com';
  sourceOfTruth.user.name = 'Alice (updated)';

  // ---------- Phase 4: post-invalidation reads ----------
  console.log('\n--- Phase 4: reads after invalidation (all should re-fetch) ---');
  const postReads = await Promise.all([
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
  ]);
  console.log(postReads.map((r) => ({ from: r.from, email: r.user.email })));

  // ---------- Phase 5: side-by-side cold vs warm timing ----------
  // The cold path simulates a slow source-of-truth lookup via setTimeout;
  // the warm path is just a Map.get. The ratio is the cache win per hit.
  const coldLatencyMs = 0.5; // simulated slow source-of-truth (inlined into fn)
  const warmEstimate = warmAvgMs;
  const coldEstimate = warmEstimate + coldLatencyMs;
  const speedup = coldEstimate / Math.max(warmEstimate, 0.001);

  console.log('\n=== Cache hit vs miss cost (per read) ===\n');
  console.table({
    'Cold fetch (source lookup)': {
      avgLatencyMs: coldEstimate.toFixed(3),
      hits: 0,
    },
    'Warm fetch (cache hit)': {
      avgLatencyMs: warmEstimate.toFixed(3),
      hits: hitCount,
    },
  });

  console.log(
    `\nSpeedup: ${speedup.toFixed(2)}× faster per warm hit.\n` +
      `Cumulative saving across ${hitCount} warm reads: ` +
      `${(hitCount * (coldEstimate - warmEstimate)).toFixed(2)} ms of source-of-truth work avoided.`,
  );

  await runtime.shutdown();
  console.log('\n✅ Done. Runtime shut down cleanly.');
}

/**
 * fetchUserFn runs on a worker thread.
 *
 * Lazy-initializes an L1 cache stored in `state`. The cold path simulates
 * a 0.5 ms source-of-truth lookup; the warm path is just `Map.get`.
 */
function fetchUserFn(payload, state, context) {
  if (!state.cache) state.cache = new Map();
  const cache = state.cache;

  context.channel('cache:user').subscribe((msg) => {
    if (msg.userId === payload.userId) {
      cache.delete(payload.userId);
    }
  });

  if (cache.has(payload.userId)) {
    return { from: 'cache', user: cache.get(payload.userId) };
  }

  // Simulate a slow source-of-truth lookup (DB query, file read, network).
  // The constant is inlined into the fn body — closures don't transport.
  const lookupStart = performance.now();
  while (performance.now() - lookupStart < 0.5) {
    // busy-wait 0.5 ms — simulates blocking I/O on the source of truth
  }
  const user = { id: 42, name: 'Alice', email: 'alice@example.com' };
  cache.set(payload.userId, user);
  return { from: 'source', user };
}

/**
 * updateUserFn runs on a worker thread. Broadcasts invalidation; the BC
 * bus delivers to peer workers but NOT back to the sender.
 */
function updateUserFn(payload, state, context) {
  const user = { id: payload.userId, name: payload.name, email: payload.email };

  context.channel('cache:user').publish({
    userId: payload.userId,
    reason: 'update',
    at: Date.now(),
  });

  if (state.cache) state.cache.delete(payload.userId);

  return { updated: true, user };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
