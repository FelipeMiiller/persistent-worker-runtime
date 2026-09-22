# Quickstart — Copy-Pasteable Examples

Five short, focused snippets. Each one is self-contained and runnable. Copy, paste, adapt.

---

## 1. Minimal HTTP server with CPU work

```javascript
// server.js
import { createWorkerRuntime } from 'persistent-worker-runtime';
import http from 'node:http';

const runtime = await createWorkerRuntime({ workers: 4 });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const n = Number(url.searchParams.get('n') ?? '40');

  try {
    const result = await runtime.execute({
      type: 'fib',
      payload: { n },
      timeoutMs: 5000,
      fn: ({ n }) => {
        // CPU-heavy: never block the event loop
        let a = 0, b = 1;
        for (let i = 0; i < n; i++) [a, b] = [b, a + b];
        return a;
      },
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ n, result }));
  } catch (err) {
    res.writeHead(500);
    res.end(err.message);
  }
});

server.listen(3000, () => console.log('http://localhost:3000'));
process.on('SIGTERM', () => runtime.shutdown().then(() => process.exit(0)));
```

Run with `node server.js`. Hit `http://localhost:3000?n=40`. The event loop stays responsive during the Fibonacci calculation.

---

## 2. Background job with retry and outbox confirmation

```javascript
// jobs.js
import { createWorkerRuntime } from 'persistent-worker-runtime';

const runtime = await createWorkerRuntime({ workers: 2 });

function dispatchWebhook(url, payload) {
  const handle = runtime.dispatch({
    type: 'webhook',
    payload: { url, payload },
    retries: 5,
    retryDelayMs: 200,
    backoff: 'exponential',
    fn: async ({ url, payload }) => {
      const res = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status };
    },
  });

  handle.onComplete((result) => console.log('done', handle.id, result));
  handle.onError((err) => console.error('failed permanently', handle.id, err.message));

  return handle;
}

// Fire 100 webhooks in the background
for (let i = 0; i < 100; i++) {
  dispatchWebhook('https://httpbin.org/post', { id: i, data: `payload-${i}` });
}

// Don't shutdown immediately — let them drain
setTimeout(() => runtime.shutdown(), 30_000);
```

---

## 3. Stateful worker with persistent in-memory model

```javascript
// stateful.js
import { createWorkerRuntime } from 'persistent-worker-runtime';

const runtime = await createWorkerRuntime({ workers: 1 });
const worker = await runtime.createWorker({ name: 'embeddings' });

// Warm-up: load the model into L1 heap (one-time, slow)
await worker.setState('ready', await loadHugeModel());

// Fast-path: thousands of calls reuse the in-memory model
async function embed(text) {
  const ready = await worker.getState('ready');
  if (!ready) throw new Error('model not loaded');

  return runtime.execute({
    type: 'embed',
    payload: { text, workerId: worker.id },
    fn: (p) => ready.model.embed(p.text),
  });
}

const start = Date.now();
const vectors = await Promise.all(
  Array.from({ length: 1000 }, (_, i) => embed(`document ${i}`))
);
console.log(`1000 embeddings in ${Date.now() - start}ms`);

await runtime.shutdown();
```

---

## 4. Priority + cancellation

```javascript
// priority-cancel.js
import { createWorkerRuntime } from 'persistent-worker-runtime';

const runtime = await createWorkerRuntime({ workers: 2 });

// Low-priority work first
for (let i = 0; i < 10; i++) {
  runtime.dispatch({
    type: 'background',
    priority: 0,
    payload: { id: `bg-${i}` },
    fn: async (p) => {
      await new Promise((r) => setTimeout(r, 100));
      return p.id;
    },
  });
}

// High-priority jumps the queue
runtime.dispatch({
  type: 'urgent',
  priority: 10,
  payload: { id: 'urgent-1' },
  fn: (p) => p.id,
}).onComplete((r) => console.log('urgent finished first:', r));

// Cancellation with timeout
const controller = new AbortController();
setTimeout(() => controller.abort(), 50); // cancel after 50ms

try {
  await runtime.execute({
    type: 'long_task',
    payload: {},
    signal: controller.signal,
    fn: async () => {
      await new Promise((r) => setTimeout(r, 10_000)); // 10s task
      return 'unreachable';
    },
  });
} catch (err) {
  console.log('cancelled:', err.name); // TaskAbortedError
}

await runtime.shutdown();
```

---

## 5. Zero-copy image processing

```javascript
// image-batch.js
import { createWorkerRuntime } from 'persistent-worker-runtime';
import sharp from 'sharp';

const runtime = await createWorkerRuntime({ workers: 4 });

// Simulate 50 uploaded images
const uploads = Array.from({ length: 50 }, (_, i) => {
  // Each "upload" is a 4MB raw RGBA buffer
  const buf = new ArrayBuffer(4 * 1024 * 1024);
  new Uint8Array(buf).fill(i & 0xff); // gradient pattern for testing
  return { id: i, buffer: buf };
});

// Process in parallel (bounded by 4 workers)
const tasks = uploads.map((u) => ({
  type: 'thumbnail',
  payload: { id: u.id, buffer: u.buffer },
  transferList: [u.buffer], // moved to worker, not copied
  fn: async (p) => {
    // sharp runs inside the worker thread, not on main
    const png = await sharp(p.buffer, { raw: { width: 1024, height: 1024, channels: 4 } })
      .resize(128, 128)
      .png()
      .toBuffer();
    return { id: p.id, size: png.length };
  },
}));

const results = await runtime.executeAll(tasks);
console.log(`Processed ${results.length} images`);

await runtime.shutdown();
```

Run with `node image-batch.js` (after `npm install sharp`).
