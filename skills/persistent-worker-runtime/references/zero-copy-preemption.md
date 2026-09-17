# Zero-Copy Transfer, Retries, and Preemption

## Zero-Copy Binary Transfer

For multi-megabyte payloads (images, video, ML tensors), use `transferList` to move the buffer without copying:

```javascript
const imageBuffer = new ArrayBuffer(3840 * 2160 * 4); // ~31MB

await runtime.execute({
  type: 'process_image',
  payload: { buffer: imageBuffer, width: 3840, height: 2160 },
  transferList: [imageBuffer], // buffer detached from sender after transfer
  fn: (p) => applyFilter(p.buffer),
});
// 5x faster than structured clone (see benchmarks/zero-copy-transfer.benchmark.js)
```

Multiple buffers, TypedArray views, and `Uint8Array.buffer` references all work — anything that's an `ArrayBuffer` can go in `transferList`.

**Warning:** after `transferList` delivery, the buffer is **detached** on the sender. Storing a reference to it and reusing it will throw `TypeError: Cannot perform operations on a detached ArrayBuffer`.

## Retries with Backoff

Background retries do NOT block the worker — the delay happens on the main thread's queue scheduler.

```javascript
runtime.dispatch({
  type: 'call_webhook',
  payload: { url: 'https://partner.example.com', data },
  retries: 5,
  retryDelayMs: 100,
  backoff: 'exponential', // 'exponential' or 'linear'
  fn: async (p) => fetch(p.url, { method: 'POST', body: JSON.stringify(p.data) }),
});
```

| Backoff | Schedule with `retryDelayMs: 100, retries: 4` |
| --- | --- |
| `'fixed'` | 100ms, 100ms, 100ms, 100ms |
| `'linear'` | 100ms, 200ms, 300ms, 400ms |
| `'exponential'` | 100ms, 200ms, 400ms, 800ms |

## Cooperative + Hard Preemption

Two layers of timeout enforcement:

| Layer | Setting | Behavior |
| --- | --- | --- |
| Cooperative | `timeoutMs: 5000` | Worker can `await` cancellation; clean shutdown |
| Hard | `timeoutMs: 5000, forceKillOnTimeout: true` | Main thread forcibly `worker.terminate()`s the worker if it doesn't yield; spawns replacement |

```javascript
await runtime.execute({
  type: 'parse_user_input',
  payload: { input: userText },
  timeoutMs: 100,
  forceKillOnTimeout: true,
  fn: (p) => parser.parse(p.input),
});
```

Preempted tasks reject with `TaskTimeoutError` having `preempted: true`. The runtime automatically spawns a replacement worker so pool capacity is preserved.

### When to use hard preemption

Use `forceKillOnTimeout: true` for any untrusted input where the parser might have a known-bad case (ReDoS, pathological AST, infinite recursion in user code). For trusted, well-tested code, cooperative timeout is enough.

## See also

- `examples/zero-copy-image.js` — 30MB raw image buffer via `transferList`
- `examples/cancel-on-disconnect.js` — `AbortSignal.timeout` + cooperative cancellation
- `benchmarks/preemption-recovery.benchmark.js` — pool healing under forced kills