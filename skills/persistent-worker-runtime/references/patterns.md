# Patterns — Production-Ready Use Cases

Six battle-tested patterns, each with runnable code. Copy, adapt, ship.

---

## Pattern 1: Transactional Outbox (Express HTTP server)

The canonical "don't lose the email if the DB is down" pattern. HTTP request writes to the outbox table in a transaction; the runtime drains the outbox in the background and dispatches the work; the worker thread does the slow IO without blocking the event loop; the result is confirmed back to the outbox row.

```javascript
import express from 'express';
import { createWorkerRuntime } from 'persistent-worker-runtime';
import { Pool } from 'pg';

const db = new Pool({ /* ... */ });
const runtime = await createWorkerRuntime({ workers: 4 });

const app = express();
app.use(express.json());

// POST /signup — write to outbox atomically, return 202 immediately
app.post('/signup', async (req, res) => {
  const { email } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Same transaction: insert the user AND the outbox row.
    await client.query('INSERT INTO users (email) VALUES ($1)', [email]);
    await client.query(
      "INSERT INTO outbox (type, payload, status) VALUES ($1, $2, 'pending')",
      ['send_welcome_email', JSON.stringify({ email })]
    );
    await client.query('COMMIT');
    res.status(202).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Drain the outbox: every 1s, dispatch pending jobs
setInterval(async () => {
  const { rows } = await db.query(
    "SELECT id, payload FROM outbox WHERE status = 'pending' LIMIT 100"
  );
  for (const row of rows) {
    const handle = runtime.dispatch({
      type: 'send_welcome_email',
      payload: { ...JSON.parse(row.payload), outboxId: row.id },
      retries: 5,
      retryDelayMs: 2000,
      fn: async (p) => mailer.sendWelcome(p.email),
    });
    handle.onComplete(async () => {
      await db.query("UPDATE outbox SET status='done' WHERE id=$1", [p.outboxId]);
    });
    handle.onError(async (err) => {
      await db.query(
        "UPDATE outbox SET status='failed', error=$2 WHERE id=$1",
        [p.outboxId, err.message]
      );
    });
  }
}, 1000);

app.listen(3000);
process.on('SIGTERM', () => runtime.shutdown());
```

---

## Pattern 2: Image Resize Batch

Process 1000s of uploads with bounded concurrency and zero-copy transfer.

```javascript
import { createWorkerRuntime } from 'persistent-worker-runtime';
import sharp from 'sharp'; // do not import on main thread

const runtime = await createWorkerRuntime({
  workers: 4,
  maxMemoryMb: 1024, // recycle after 1GB heap
});

// Submit the batch
const handles = runtime.dispatchAll(
  uploadedFiles.map((file) => ({
    type: 'resize',
    payload: {
      buffer: file.buffer, // DetachedBuffer (zero-copy)
      targetWidth: 800,
    },
    transferList: [file.buffer],
    retries: 2,
    fn: async ({ buffer, targetWidth }) => {
      const resized = await sharp(buffer).resize(targetWidth).toBuffer();
      await uploadToS3(resized);
      return { size: resized.length };
    },
  }))
);

// Wait for all to settle
const results = await Promise.all(handles.map((h) => h.promise));
const failed = results.filter((r) => r.status === 'rejected');

await runtime.shutdown();
```

---

## Pattern 3: Persistent AI Model (L1 Warm Cache)

Run an LLM embedding model in a single worker for sub-millisecond per-call latency.

```javascript
import { createWorkerRuntime, WorkerRuntime } from 'persistent-worker-runtime';

const runtime = await createWorkerRuntime({ workers: 1 });

// Warm-up: load model into L1 heap (one-time cost)
await runtime.execute({
  type: 'warmup',
  fn: async () => {
    const { pipeline } = await import('@xenova/transformers');
    const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    return 'warm';
  },
});

// Production: 1000s of fast embedding calls
async function embed(text) {
  return runtime.execute({
    type: 'embed',
    payload: { text },
    fn: async (p) => {
      // The model is already in L1 heap — no reload cost.
      // (Use a dedicated worker handle for direct L1 access in advanced cases.)
      return generateEmbedding(p.text);
    },
  });
}

const vectors = await Promise.all(
  documents.map((doc) => embed(doc.text))
);
```

For finer control over persistent state, use `runtime.createWorker()` to get a `WorkerHandle` that exposes `setState`, `getState`, `clearState` directly.

---

## Pattern 4: Priority Routing for Tiered API

Premium users' requests jump the queue over free-tier batch work.

```javascript
const runtime = await createWorkerRuntime({ workers: 8 });

function handleRequest(user, payload) {
  const priority = user.tier === 'premium' ? 10 : user.tier === 'pro' ? 5 : 0;
  return runtime.execute({
    type: 'api_call',
    payload,
    priority,
    timeoutMs: 5000,
    fn: async (p) => api.process(p),
  });
}

// Premium requests land first even when free-tier is saturating the pool
await Promise.all([
  handleRequest({ tier: 'free' }, { x: 1 }),
  handleRequest({ tier: 'free' }, { x: 2 }),
  handleRequest({ tier: 'premium' }, { x: 3 }), // runs before either of the above
]);
```

---

## Pattern 5: Cancellation on Client Disconnect

Cancel a long-running worker task when the HTTP client disconnects.

```javascript
app.get('/export.csv', async (req, res) => {
  const controller = new AbortController();
  req.on('close', () => controller.abort()); // client disconnected

  try {
    const csv = await runtime.execute({
      type: 'csv_export',
      payload: { queryId: req.query.id },
      signal: controller.signal,
      fn: async (p) => {
        // Stream rows to res
        const stream = db.queryStream(`SELECT * FROM ${p.queryId}`);
        for await (const row of stream) {
          if (controller.signal.aborted) throw new Error('aborted');
          res.write(csvRow(row));
        }
        res.end();
      },
    });
  } catch (err) {
    if (err.name === 'TaskAbortedError') {
      // Client already disconnected — nothing to do
    } else {
      res.status(500).end();
    }
  }
});
```

---

## Pattern 6: Streaming Results (LLM Token Stream)

Stream LLM tokens to the HTTP response as they're generated, with low TTFB.

```javascript
app.post('/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    // Note: streaming via runtime.stream() requires the runtime
    // version that ships ADR-0012 (see .specs/features/streaming-results/).
    // Until then, use execute() with manual chunking:
    let buffer = '';
    while (!controller.signal.aborted) {
      const chunk = await runtime.execute({
        type: 'next_token',
        payload: { prompt: req.body.prompt, buffer },
        signal: controller.signal,
        fn: async (p) => llm.nextToken(p.prompt, p.buffer),
      });
      if (chunk.done) break;
      res.write(`data: ${JSON.stringify({ token: chunk.text })}\n\n`);
      buffer += chunk.text;
    }
    res.end();
  } catch (err) {
    if (err.name !== 'TaskAbortedError') res.status(500).end();
  }
});
```

---

## Anti-patterns to avoid

1. **Naive `Promise.all(tasks.map(runtime.execute))` for 10k tasks** — saturates the pool with unbounded queue. Use `executeAll` instead, or `runtime.createWorker` with controlled enqueue.
2. **Sharing mutable state across tasks** — the L1 heap is per-worker. Tasks on the same worker share it; tasks on different workers do not. Use affinity (`affinityKey`) to pin related tasks.
3. **Putting closures in `fn`** — `fn` is serialized via `fnCode` and runs in the worker thread with no closure access. Pass data via `payload`.
4. **Forgetting to call `shutdown()`** — without it, the Node.js process hangs because workers hold the event loop open.
5. **Catching `TaskAbortedError` and silently retrying** — if the client cancelled, retrying wastes resources. Surface the cancellation.
