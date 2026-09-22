# Cancellation and Priority

## Cancellation via AbortController

Standard `AbortSignal` integration. Use it for HTTP request cancellation, UI-driven cancellation, and watchdog timeouts.

```javascript
const controller = new AbortController();

// Cancel after 5 seconds (e.g. user navigates away)
setTimeout(() => controller.abort(), 5000);

try {
  const result = await runtime.execute({
    type: 'generate_report',
    payload: { rows: 1_000_000 },
    signal: controller.signal,
    fn: async (p) => {
      // Long-running work — check the signal periodically for cooperative cancel
      for (let i = 0; i < p.rows; i++) {
        if (controller.signal.aborted) throw new Error('aborted');
        await renderRow(i);
      }
      return 'done';
    },
  });
} catch (err) {
  if (err.name === 'TaskAbortedError') {
    // Cleanup partial state
  }
}

// Or use the built-in timeout helper
await runtime.execute({
  type: 'slow_query',
  payload: {},
  signal: AbortSignal.timeout(2_000), // auto-abort after 2s
  fn: () => doWork(),
});
```

Cancelled tasks reject with `TaskAbortedError`.

### Hard timeout vs cooperative timeout

`timeoutMs` alone is **cooperative**: it only takes effect when the worker checks for cancellation. For tasks that may hang (ReDoS, infinite sync loops), add `forceKillOnTimeout: true`:

```javascript
await runtime.execute({
  type: 'parse_user_input',
  payload: { input: userText },
  timeoutMs: 100,
  forceKillOnTimeout: true, // SIGKILL the worker if it doesn't yield
  fn: (p) => parser.parse(p.input),
});
```

Preempted tasks reject with `TaskTimeoutError` having `preempted: true`.

## Priority Queue

Higher-priority tasks are dequeued first. Ties preserve FIFO.

```javascript
// Low-priority batch work first
runtime.dispatch({
  type: 'analytics',
  priority: 0,
  payload: {},
  fn: () => aggregate(),
});

// Critical user-facing work jumps the queue
runtime.dispatch({
  type: 'live_chat',
  priority: 10,
  payload: { userId: 42 },
  fn: serve,
});
```

### When priority matters

- Premium-tier requests before free-tier requests
- Live chat messages before batch analytics
- Time-sensitive webhooks before housekeeping jobs

`dispatch()` round-trip is sub-10 microseconds regardless of priority — priority affects **which task is dequeued next**, not the dispatch cost.

## See also

- `examples/cancel-on-disconnect.js` — manual cancel, `AbortSignal.timeout`, pre-aborted signal
- `examples/priority-routing.js` — verify priority ordering across a worker pool