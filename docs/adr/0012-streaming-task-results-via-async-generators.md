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
