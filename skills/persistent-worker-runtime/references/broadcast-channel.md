# Inter-Worker BroadcastChannel

Workers publish / subscribe to **named channels** without involving the main-thread Event Loop as a router. Backed by Node's native `BroadcastChannel` (web-standard API, zero dependencies).

The canonical use case: when one worker mutates a record, every other worker's hot L1 cache needs to evict its stale copy. The runtime gives you a bus-style API for that.

## When to use this

- L1 cache invalidation across workers (record mutated in worker A → workers B, C, D evict their cached copy)
- Configuration reload signals (main → all workers)
- Coordination messages that should not block any thread
- Telemetry / metrics fan-out

If you need **delivery guarantees** or **replay**, do NOT use BroadcastChannel — use the runtime's `dispatch()` with retries instead.

## Worker-side API: `context.channel(name)`

Inside a worker fn, the third argument (`context`) exposes `channel(name)`. It returns a wrapper with `publish`, `subscribe`, `unsubscribe`, and `close`. The wrapper is per-worker: each worker has its own `ChannelRegistry` instance.

**fnCode runs as a string** in the worker, so closures from the main module are NOT available. **Inline the channel name as a literal.**

```javascript
async function fetchUser(payload, state, context) {
  const cache = (state.cache ||= new Map());

  // Subscribe ONCE per worker. The wrapper is idempotent across calls;
  // the bus does not deliver to the sender.
  context.channel('cache:user').subscribe((msg) => {
    if (msg.userId === payload.userId) cache.delete(payload.userId);
  });

  if (cache.has(payload.userId)) return { from: 'cache', user: cache.get(payload.userId) };

  const user = await db.fetchUser(payload.userId);
  cache.set(payload.userId, user);
  return { from: 'source', user };
}

async function updateUser(payload, _state, context) {
  await db.updateUser(payload);

  // Broadcast invalidation. Returns IMMEDIATELY — does not wait for peers.
  context.channel('cache:user').publish({
    userId: payload.userId,
    reason: 'update',
  });
}
```

## Main-thread API: `runtime.broadcast / subscribe / unsubscribe / hasSubscribers`

```javascript
// Subscribe for observability
runtime.subscribe('cache:user', (msg) => {
  metrics.incr('cache.invalidate', { reason: msg.reason });
});

// Broadcast a control signal to all workers
runtime.broadcast('system:reload', { at: Date.now() });

// Idempotent unsubscribe
runtime.unsubscribe('cache:user', observerHandler);

// Predicate: any subscribers currently?
runtime.hasSubscribers('cache:user'); // → boolean
```

After `runtime.shutdown()`, `broadcast()` throws `WorkerRuntimeError('Runtime is shutting down')`. The runtime closes every main-thread-owned BC during shutdown; `FinalizationRegistry` is a GC safety net for worker-side wrappers that lose their strong reference.

## Semantics (important)

| Property | Value |
| --- | --- |
| Backed by | `node:worker_threads` `BroadcastChannel` (built-in, zero deps) |
| Topology | O(1) per publish — native BC delivers to all listeners across threads |
| Loop-back | **No** — a thread does NOT receive its own publishes |
| Per-name caching | Yes — multiple `context.channel('ch')` calls share one underlying BC |
| Message serialization | Structured clone (Dates, Maps, Sets, ArrayBuffers, TypedArrays, RegExps) |
| One bad subscriber | Does NOT break the others (try/catch per handler) |
| After shutdown | `broadcast()` throws `WorkerRuntimeError`; subscribers fire one last time then close |

## Structured clone caveats

- Functions, DOM nodes, symbols → dropped (not supported by structured clone)
- Cyclic references → `DataCloneError` thrown synchronously
- Practical size limit ~1MB; larger payloads throw

## Defensive subscriber pattern

A throwing subscriber does not break peers, but production callers usually want to log inside the handler:

```javascript
context.channel('cache:user').subscribe((msg) => {
  try {
    cache.delete(msg.userId);
  } catch (err) {
    log.error({ err, msg }, 'cache eviction failed');
  }
});
```

## See also

- `examples/broadcast-cache-invalidation.js` — full runnable end-to-end demo
- `benchmarks/broadcast-fanout.benchmark.js` — BC vs per-worker dispatch (~18x faster)
- `src/broadcast-channel.js` — implementation (`ChannelRegistry` class)