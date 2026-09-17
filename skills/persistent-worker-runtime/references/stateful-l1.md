# Stateful Workers (L1 Memory) and Bounded Concurrency

Workers stay alive across tasks. Use the worker's L1 heap as a warm cache — no re-loading per request.

## L1 state via the `state` argument

The second argument to every fn is `state` — a per-worker object preserved across all tasks running on the same worker. Initialize lazily; mutate freely.

```javascript
// First call: worker loads the model from disk (slow)
await runtime.execute({
  type: 'warm_model',
  fn: async (_p, state) => {
    state.model = await loadHugeModelFromDisk();   // persisted on this worker
    state.initialized = true;
    return 'ready';
  },
});

// Subsequent calls: model is already in L1 (fast)
for (let i = 0; i < 1000; i++) {
  await runtime.execute({
    type: 'predict',
    payload: { input: i },
    fn: ({ input }, state) => state.model.predict(input),  // 33x faster than reloading
  });
}
```

`state` is reset on:
- Worker recycle (`maxTasksPerWorker` or `maxMemoryMb` exceeded) — see `references/observability.md`
- Worker crash (replacement worker starts with empty `state`)

Always design stateful code to gracefully re-warm.

## Worker affinity

A task dispatched multiple times may run on different workers. To pin a logical "session" to one worker, use `affinityKey`:

```javascript
// All three dispatches route to the SAME worker
const handle1 = runtime.dispatch({ type: 'session_step', affinityKey: `user:${userId}`, payload: { ... }, fn: ... });
const handle2 = runtime.dispatch({ type: 'session_step', affinityKey: `user:${userId}`, payload: { ... }, fn: ... });
const handle3 = runtime.dispatch({ type: 'session_step', affinityKey: `user:${userId}`, payload: { ... }, fn: ... });
```

The supervisor tracks which worker holds each affinity key; new tasks with the same key route there. Useful for: per-user session state, per-tenant model caches, per-connection dedup.

## Bounded concurrency (`executeAll` / `dispatchAll`)

`Promise.all` floods the Event Loop with microtasks and lets N requests each spin up a worker. The runtime's `executeAll` enforces pool-level concurrency instead:

```javascript
// 1000 tasks, only 4 running in parallel
await runtime.executeAll(
  Array.from({ length: 1000 }, (_, i) => ({
    type: 'image_thumbnail',
    payload: { id: i },
    fn: async ({ id }) => makeThumbnail(id),
  }))
);
```

Returns `Promise<results[]>` for `executeAll` or `Promise<TaskHandle[]>` for `dispatchAll`.

### Why not raw `Promise.all`?

| | `Promise.all` | `runtime.executeAll` |
| --- | --- | --- |
| Worker pool size | unbounded | bounded to `workers` config |
| Memory pressure | unbounded queue growth | queue parked at `maxQueueSize` |
| Backpressure | none — caller blocks forever if worker pool stalls | `queueTimeoutMs` rejects excess tasks with `TaskQueueTimeoutError` |
| Priority across calls | not honored | preserved within each call's array |

## Memory hygiene (automatic recycling)

Workers are recycled after `maxTasksPerWorker` or `maxMemoryMb` to prevent heap fragmentation:

```javascript
const runtime = await createWorkerRuntime({
  workers: 4,
  maxTasksPerWorker: 500, // recycle after 500 tasks
  maxMemoryMb: 512,       // recycle if heap exceeds 512MB
});
```

Recycled workers lose their L1 cache — design stateful code to gracefully re-warm.

## See also

- `examples/persistent-ai-model.js` — full LLM-inference L1 cache demo
- `examples/image-resizer-batch.js` — bounded batch processing