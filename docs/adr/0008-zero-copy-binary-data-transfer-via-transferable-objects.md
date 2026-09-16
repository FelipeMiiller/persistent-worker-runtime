# ADR-0008: Zero-Copy Binary Data Transfer via Transferable Objects

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: performance, memory, zero-copy, buffers

## Context and Problem Statement

When passing large binary payloads (e.g. 50MB audio files, high-resolution images, large JSON strings as byte buffers, or vector embeddings) between the main thread and worker threads, the default `structuredClone` algorithm copies the memory byte-for-byte. For multi-megabyte payloads, this serialization and copying creates significant GC pressure and latency. How can the runtime achieve near-zero transfer overhead for large binary data?

## Decision Drivers

- Near-zero latency for transferring large buffers across thread boundaries.
- Zero external dependencies; must leverage Node.js native V8 transfer primitives.
- Explicit developer opt-in to prevent accidental buffer detachment.

## Considered Options

- **Option 1: Structured Clone Copying Only** (Significant memory and CPU overhead for large buffers)
- **Option 2: SharedArrayBuffer by default** (Requires lock synchronization and atomic coordination)
- **Option 3: Support for `transferList` (Transferable Objects)**

## Decision Outcome

Chosen option: **"Option 3: Support for `transferList`"**, using the native `postMessage(message, [transferList])` capability of `node:worker_threads`. By transferring ownership of underlying `ArrayBuffer` instances, data is moved in sub-millisecond time (< 0.05ms) regardless of buffer size, without allocating duplicate memory.

### Usage:
```javascript
const largeBuffer = new ArrayBuffer(50 * 1024 * 1024); // 50MB

const result = await runtime.execute({
  type: 'process_audio',
  payload: { buffer: largeBuffer },
  transferList: [largeBuffer], // Ownership transferred instantly without copying
});
```

### Positive Consequences

- 50MB+ binary transfers take < 0.1ms instead of 50ms+ of copying.
- Eliminates memory spikes and garbage collection pauses.
- Standard Web and Node.js native mechanism.

### Negative Consequences

- The transferred `ArrayBuffer` is detached and emptied on the sending thread after transfer.
