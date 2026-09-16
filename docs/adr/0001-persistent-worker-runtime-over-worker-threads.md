# ADR-0001: Persistent Worker Runtime Over worker_threads

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: architecture, concurrency, nodejs, worker_threads

## Context and Problem Statement

Node.js uses a single-threaded Event Loop that excels at asynchronous, non-blocking I/O. However, synchronous CPU-intensive tasks block the Event Loop, causing high latency spikes, queuing, and request timeouts. Creating ad-hoc `Worker` threads per task induces high memory allocation and startup overhead, while discarding valuable in-memory worker state. How can Node.js applications execute CPU-bound and background workloads without blocking the Event Loop and without paying thread startup costs on every task?

## Decision Drivers

- Must strictly preserve the Event Loop for non-blocking I/O and coordination.
- Must eliminate Event Loop starvation during CPU-heavy operations.
- Must avoid the latency of repeatedly spawning and destroying V8 Isolates.
- Must support warm, worker-local state retention between tasks.
- Must provide an intuitive, Promise-based developer experience.

## Considered Options

- **Option 1: Status Quo (Synchronous Event Loop execution with setImmediate/nextTick chunking)**
- **Option 2: Ad-hoc Worker threads spawned per request (`new Worker()`)**
- **Option 3: External microservices / Queue infrastructure (Redis + BullMQ / RabbitMQ)**
- **Option 4: Persistent Worker Runtime built atop `node:worker_threads`**

## Decision Outcome

Chosen option: **"Option 4: Persistent Worker Runtime built atop `node:worker_threads`"**, because it keeps persistent worker threads warm in a managed pool, offloading CPU-intensive workloads completely away from the main thread while preserving the Event Loop for I/O and connection handling.

### Positive Consequences

- The Main Event Loop remains completely responsive and non-blocking for HTTP/WebSocket traffic.
- Workers remain alive across executions, eliminating V8 Isolate bootstrap latency.
- Enables worker-local state (L1 heap) caching for heavy models, ASTs, and buffers.
- Eliminates the need for external Redis/queue infrastructure for in-process background tasks.

### Negative Consequences

- Requires managing inter-thread communication (IPC) via `postMessage` / `MessagePort`.
- Serialization overhead exists for data copied across thread boundaries (mitigated by `Transferable` objects and warm L1 state).
