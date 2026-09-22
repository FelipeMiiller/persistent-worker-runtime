/**
 * BroadcastChannel cache invalidation example.
 *
 * Demonstrates the canonical "L1 cache invalidation" pattern:
 *
 *   1. Multiple workers each maintain a hot in-memory cache (a `Map`
 *      that persists across task executions in the same worker).
 *   2. When a worker mutates a record (e.g. updates a user's email),
 *      it publishes an INVALIDATE message on a named broadcast channel.
 *   3. Other workers receive the message and evict the matching cache
 *      entry so the next read goes back to the (simulated) source of
 *      truth.
 *
 * Why BroadcastChannel and not a round-trip through the main thread?
 *   - The invalidation message goes directly to every subscriber thread
 *     without bouncing through the Event Loop as a router.
 *   - The publishing worker does not block; it returns immediately after
 *     `postMessage()` accepts the message into the bus.
 *   - There is no "fan-out" loop in user code: the bus itself delivers
 *     to every subscribed listener in one shot.
 *
 * Run: `node examples/broadcast-cache-invalidation.js`
 */

import { createWorkerRuntime } from '../src/index.js';

// Cache invalidation channel name. Main thread and workers MUST agree on
// this literal — fnCode runs as a string in the worker, so closures from
// the main module are not available there.
const _CACHE_CHANNEL = 'cache:user';

async function main() {
  // Mutable simulated source-of-truth — main thread observes it via the
  // user.email returned by post-invalidate reads. In a real app this
  // would be a DB query; here we just mutate the in-memory object so
  // subsequent reads see the new value.
  const sourceOfTruth = {
    user: { id: 42, name: 'Alice', email: 'alice@example.com' },
  };

  const runtime = await createWorkerRuntime({ workers: 3 });

  // ---------- 1. Cold reads ----------
  // Three workers each load user 42 — first read on each worker is a
  // cache miss because each worker has its own L1 cache.
  console.log('\n--- Phase 1: cold reads from 3 workers ---');
  const coldReads = await Promise.all([
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
  ]);
  console.log(coldReads.map((r) => ({ from: r.from, email: r.user.email })));

  // ---------- 2. Warm reads ----------
  // Dispatch several reads; reads routed to the same worker will hit the
  // cache; reads routed to a different worker will miss again.
  console.log('\n--- Phase 2: warm reads ---');
  const warmReads = await Promise.all([
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
  ]);
  console.log(warmReads.map((r) => ({ from: r.from, email: r.user.email })));

  // ---------- 3. Update + broadcast invalidation ----------
  console.log('\n--- Phase 3: update + broadcast INVALIDATE ---');
  const updateResult = await runtime.execute({
    type: 'update_user',
    payload: {
      userId: 42,
      email: 'alice+updated@example.com',
      name: 'Alice (updated)',
    },
    fn: updateUserFn,
  });
  console.log('Update result:', updateResult);

  // Update the main-thread view of the source of truth so phase-4
  // reads can be observed in the demo output. The worker fn also
  // mutates its own in-fn literal copy so workers see the new value.
  sourceOfTruth.user.email = 'alice+updated@example.com';
  sourceOfTruth.user.name = 'Alice (updated)';

  // ---------- 4. Post-invalidation reads ----------
  // After the broadcast, every worker's L1 cache for user 42 is empty,
  // so reads hit the source of truth again.
  console.log('\n--- Phase 4: reads after invalidation ---');
  const postReads = await Promise.all([
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
    runtime.execute({ type: 'fetch_user', payload: { userId: 42 }, fn: fetchUserFn }),
  ]);
  console.log(
    postReads.map((r) => ({
      from: r.from,
      email: r.user.email,
    })),
  );

  // ---------- 5. Shut down ----------
  await runtime.shutdown();
  console.log('\n✅ Done. Runtime shut down cleanly.');
}

/**
 * fetchUserFn runs on a worker thread.
 *
 * - Lazy-initializes an L1 cache stored in `state` (preserved across
 *   executions on the same worker).
 * - Subscribes to the invalidation channel ONCE per worker; subsequent
 *   calls reuse the same handler.
 * - Returns a hit/miss indicator so the demo can show the cache working.
 *
 * NOTE: fnCode is compiled with `new Function('payload', 'state', 'context', code)`
 * inside the worker, so closures from the main module are NOT available.
 * The channel name must be inlined as a literal in the function body.
 */
function fetchUserFn(payload, state, context) {
  // Lazy cache init (per-worker, persistent across tasks on the same worker)
  if (!state.cache) state.cache = new Map();
  const cache = state.cache;

  // Subscribe to invalidation. The wrapper is idempotent per-channel,
  // and the bus only delivers to subscribers in OTHER threads, so this
  // worker will not receive its own publishes.
  context.channel('cache:user').subscribe((msg) => {
    if (msg.userId === payload.userId) {
      cache.delete(payload.userId);
    }
  });

  // Cache hit
  if (cache.has(payload.userId)) {
    return { from: 'cache', user: cache.get(payload.userId) };
  }

  // Cache miss — fetch from source of truth (simulated as a literal in
  // the fn body — closures from the main module are not available) and
  // store the snapshot in the cache.
  const user = { id: 42, name: 'Alice', email: 'alice@example.com' };
  cache.set(payload.userId, user);
  return { from: 'source', user };
}

/**
 * updateUserFn runs on a worker thread.
 *
 * - Updates the source of truth (simulated).
 * - Broadcasts an INVALIDATE message so peer workers evict their cached
 *   copy.
 * - Evicts its own cache too (BC does not deliver to the sender).
 *
 * NOTE: fnCode runs as a string, so closures aren't available — the
 * channel name is inlined.
 */
function updateUserFn(payload, state, context) {
  // In a real app this would UPDATE the source of truth via a DB call.
  // Here we just return the new value to demonstrate the broadcast.
  const user = { id: payload.userId, name: payload.name, email: payload.email };

  // Broadcast invalidation to peer workers. Returns immediately.
  context.channel('cache:user').publish({
    userId: payload.userId,
    reason: 'update',
    at: Date.now(),
  });

  // Evict own cache too — BroadcastChannel does not loop back to the
  // sender thread.
  if (state.cache) state.cache.delete(payload.userId);

  return { updated: true, user };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
