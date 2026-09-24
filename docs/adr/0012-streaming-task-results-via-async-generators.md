# ADR-0012: Streaming Task Results via Async Generators and Structured IPC

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: streaming, async-generator, backpressure, memory-efficiency, api

## Context and Problem Statement

Data-intensive applications frequently process workloads that produce large or continuous result sets: parsing multi-gigabyte CSV/JSON files, generating LLM tokens/embeddings in progressive increments, processing audio/video frame chunks, or streaming filtered database exports.

The current `runtime.execute()` API operates on a monolithic request-response pattern. The worker must aggregate the entire result set into an in-memory array or object before transmitting it over IPC via a single `postMessage`. This design creates three severe bottlenecks:
1. **Memory Inflation**: Worker V8 heap must buffer the entire dataset, risking OOM for large outputs.
2. **IPC Spikes**: Transmitting massive objects at once leads to high serialization latency and Event Loop stalls on deserialization.
3. **High Time-to-First-Byte (TTFB)**: Downstream consumers (such as HTTP chunked responses or WebSocket clients) cannot begin processing or serving data until the entire worker task concludes.

How can the runtime support progressive, streaming computation while maintaining ergonomic JavaScript syntax and backpressure?

## Decision Drivers

- Must support progressive chunk streaming without requiring workers to buffer full datasets in memory.
- Must provide native JavaScript idioms for consumption (such as `for await (const chunk of runtime.stream(...))`).
- Must support consumer-driven backpressure and early cancellation (e.g. `break` in a loop should abort worker processing).
- Must maintain zero external dependencies and operate over standard `MessagePort` IPC.

## Considered Options

- **Option 1: Status Quo (Monolithic Batch Slicing)**: Require user application code to chunk datasets manually into hundreds of small tasks. Creates high queuing overhead and loses worker-local stream context.
- **Option 2: Node.js `Readable` Stream Wrapper**: Expose standard `node:stream` `Readable` instances over IPC events. Functional, but less ergonomic for modern async/await patterns and introduces stream event listener boilerplate.
- **Option 3: First-Class `runtime.stream()` with Native `AsyncGenerator`**: Provide `runtime.stream(taskFn, payload, options)` returning an `AsyncIterableIterator` backed by structured IPC chunk framing.

## Decision Outcome

Chosen option: **"Option 3: First-Class `runtime.stream()` with Native `AsyncGenerator`"**, because it provides the most natural JavaScript developer experience (`for await`), constant memory utilization, and native backpressure semantics.

### Architectural Mechanics

1. **Worker-Side Generator Execution**:
   - The worker execution loop detects whether `taskFn` is a generator function (`AsyncGeneratorFunction` or `GeneratorFunction`).
   - For each yielded chunk, the worker sends a structured message:
     ```js
     port.postMessage({ type: 'MSG_STREAM_CHUNK', taskId, seq, chunk });
     ```
   - When the generator finishes, it emits `MSG_STREAM_END` with the optional return value.
2. **Main-Thread Async Generator Pipeline**:
   - `runtime.stream()` returns an `AsyncGenerator` object.
   - Incoming chunks are enqueued into a bounded async queue for that task.
   - The consumer pulls chunks via `await stream.next()` or `for await (const chunk of stream)`.
3. **Bidirectional Backpressure & Cancellation**:
   - If the main thread async queue exceeds high-watermark bounds, an IPC pause signal is sent to the worker.
   - If the consumer breaks out of the loop early or calls `stream.return()`, the main thread sends an `MSG_STREAM_ABORT` message to the worker, triggering generator cleanup (`finally` blocks) and freeing worker resources immediately.

### Positive Consequences

- Constant $O(1)$ memory consumption in both worker and main thread, regardless of total dataset size.
- Drastically reduced Time-to-First-Chunk (TTFC) for LLM streaming and real-time HTTP server-sent events (SSE).
- Clean, standard language syntax (`for await...of`) without external stream libraries.
- Immediate cancellation propagation when the consumer aborts or disconnects.

### Negative Consequences

- Higher total IPC message count compared to a single monolithic `postMessage` (mitigated by batching micro-chunks when chunk frequency is extremely high).
- Requires careful handling of sequence numbers and error propagation across the async generator protocol.

## Implementation Notes (post-T7)

The T1–T7 implementation surfaced five concrete lessons that shaped the final wire protocol and runtime semantics. Each is non-obvious from the high-level design above and worth documenting alongside the decision.

### 1. `new Function(fnCode)` strips generator identity

The zero-deps invariant forces the worker to reconstruct the generator via `new Function('payload', 'state', 'context', fnCode)`. That constructor parses the source in global (non-module) scope and produces a plain `Function` object — `fn.constructor.name === 'AsyncGeneratorFunction'` returns `false`. The implementation detects generators via a regex fallback on the source string (`/\b(?:async\s+)?function\s*\*/`).

**Corollary**: closure variables do NOT survive serialization. Worker functions must receive everything via `payload` or the L1 `state` Map. The two streaming examples (`examples/streaming-llm.js`, `examples/streaming-csv-export.js`) document this constraint in inline comments and pass tokens / row counts / per-token delays via payload.

### 2. `WorkerHandle` ordering: free the worker slot BEFORE notifying the runtime

When the worker posts `MSG_STREAM_END`, the `WorkerHandle` must call `#teardownStream()` (sets `status = 'idle'`) BEFORE invoking `streamTask.onEnd(...)`. Reversed order causes `runtime.#scheduleNext()` to see no idle workers and any queued stream hangs forever. Same trap applies to `MSG_STREAM_ERROR`.

This bug was caught by the integration test "queues a second stream when workers=1 is busy" — the first stream completes, the second stream is queued, the test hangs.

### 3. Backpressure semantics: strict `<` for the resume crossing

Pause fires once on the upward crossing (`length >= HWM`); resume fires once when the buffer drops strictly below `floor(HWM / 2)`. Spec wording "below" is interpreted as strict `<` (not `<=`) so that `length === HWM/2` is unambiguously in the backpressured state. The pause event uses the same name as the resume event with a `state` field — one event, two payloads.

### 4. Emit runtime events BEFORE guarded push*() methods

`Stream.pushAbortEnd()` / `Stream.pushEnd()` / `Stream.pushError()` are guarded by `if (this._settled) return;`. When the consumer-facing path (`Stream.return()` for break, `Stream._abort()` for external signal) already settled the stream, the push is a no-op. If `runtime.emit('stream:aborted')` runs AFTER the no-op, observers never see the abort. The implementation emits BEFORE every push.

### 5. `runtime.stream()` queues when no worker is idle

Streams hold a worker for their full lifetime (1:1, not multiplexed — stateful L1 caching makes multiplexing uneconomic). When the pool is saturated, `stream()` pushes the request to `#pendingStreams` and returns immediately; the consumer can iterate while waiting. The pending queue is drained from `#scheduleNext()` (after the worker becomes idle) in FIFO order. A pre-aborted queued request is dropped without dispatch (the queue-cleanup listener also emits `stream:aborted`).

## Runtime-Level Events (T6)

For observability, the runtime's EventEmitter surfaces the following lifecycle transitions on every stream. The Stream class itself still emits its own per-stream events; the runtime events carry the `taskId` so observers can correlate across streams.

| Event | Payload | When |
|---|---|---|
| `stream:created` | `{ taskId }` | Synchronously from `runtime.stream()`, before dispatch / queue insertion |
| `stream:chunk` | `{ taskId, seq }` | Each delivered chunk (seq is the worker's per-stream counter) |
| `stream:end` | `{ taskId, totalChunks, returnValue }` | Natural completion |
| `stream:aborted` | `{ taskId, reason }` | Consumer break (`reason: 'consumer-return'`), external signal, queued-drop, runtime-shutdown drain, or generator throw |
| `stream:backpressure` | `{ taskId, state, queueLength }` | HWM crossing upward (`state: 'paused'`) or downward (`state: 'resumed'`) |

`runtime.stats()` also gains `activeStreams` (count of dispatched streams) and `pendingStreams` (count of queued requests).

## Validation Artifacts

- 565 unit tests across 50 suites (`node:test`) — see `package.json` `scripts.test`
- 10 dedicated benchmarks (CPU saturation, adaptive controller, default sizing, recycling, preemption, streaming throughput/memory/stress/abort)
- **12 runnable examples** in `examples/` — every one carries a `[perf-tested]` header tag and ends with a measured metric that justifies the feature. See `.agents/rules/perf-first-authoring.md` and `.agents/skills/pwr-examples/SKILL.md` for the authoring convention.
- ADR-0019 default pool size benchmark (`benchmarks/default-sizing-memory.benchmark.js`) — proves the 1:1 stream-to-worker model is viable at default worker counts
