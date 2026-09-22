# ADR-0013: Worker Inter-Communication via Native BroadcastChannel

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: ipc, broadcast-channel, coordination, pub-sub, actor-model

## Context and Problem Statement

In standard worker pool designs, workers operate as isolated silos communicating strictly upstream with the main thread (a star network topology). However, when workers maintain warm L1 state (such as cached database models, compiled WASM modules, localized tokenizers, or configuration snapshots), changes in one worker or in the main thread often need to be propagated to all other workers.

In a naive architecture, invalidating or updating L1 cache entries across workers requires sending a message to the main thread, which must then iterate over all active worker handles and forward the invalidation message to each one individually. This design introduces two major problems:
1. **Main Thread Event Loop Contention**: The main thread spends CPU cycles acting as an unnecessary router for inter-worker notifications.
2. **Coordination Latency**: Point-to-point forwarding increases notification latency and can cause race conditions or inconsistent cache states across workers.

How can workers communicate and synchronize state directly with zero mediation or overhead on the main Event Loop?

## Decision Drivers

- Must eliminate main-thread Event Loop routing overhead for inter-worker notifications and cache invalidations.
- Must use zero-dependency, standard Node.js APIs supported in Node.js >= 22.
- Must support named pub/sub channels (e.g. `'cache-invalidation'`, `'config-sync'`).
- Must provide ergonomic APIs accessible directly from within the worker execution context (`state`).

## Considered Options

- **Option 1: Star Routing via Main Thread**: All coordination messages flow Worker $\to$ Main Thread $\to$ All Workers. High Event Loop contention.
- **Option 2: Point-to-Point `MessageChannel` Mesh**: Main thread creates $O(N^2)$ bidirectional `MessagePort` pairs connecting every worker directly to every other worker. Extremely complex lifecycle management, high memory overhead, and fragile during worker crashes/restarts.
- **Option 3: Bus Topology via Native `BroadcastChannel`**: Utilize Node.js's native `node:worker_threads` / global `BroadcastChannel` implementation.

## Decision Outcome

Chosen option: **"Option 3: Bus Topology via Native `BroadcastChannel`"**, because `BroadcastChannel` provides a native, zero-dependency, multi-producer multi-consumer messaging bus across threads in the same process with $O(1)$ setup complexity and zero main-thread routing.

### Architectural Mechanics

1. **Native Bus Architecture**:
   - `BroadcastChannel` is a web-standard API built into Node.js (and `node:worker_threads`).
   - Messages sent to a `BroadcastChannel` are dispatched directly to all other listeners on the same channel across thread boundaries, completely bypassing the main thread's Event Loop.
2. **Worker Context Integration**:
   - The runtime passes a channel accessor via the worker execution context:
     ```js
     // Inside a worker task:
     const channel = context.channel('l1-cache');
     
     // Invalidate a key across all workers:
     channel.publish({ action: 'INVALIDATE', key: 'user:123' });
     ```
   - Workers can register continuous background subscribers during initialization or first run:
     ```js
     channel.subscribe((msg) => {
       if (msg.action === 'INVALIDATE') {
         state.delete(msg.key);
       }
     });
     ```
3. **Orchestrator Broadcast API**:
   - The main-thread runtime also exposes `runtime.broadcast(channelName, message)` to allow the main application to broadcast events (e.g. feature flag updates, schema migrations) to all workers simultaneously without iterating pool arrays.
4. **Lifecycle & Cleanup**:
   - Worker channels are unrefed or automatically closed when workers are recycled or shut down, preventing open handles from blocking thread exit.

### Positive Consequences

- Zero Event Loop overhead on the main thread during high-frequency inter-worker coordination.
- $O(1)$ configuration complexity: no need to manage complex $N \times N$ `MessagePort` matrices.
- Eliminates stale cache reads across workers when L1 state is updated.
- Web-standard API: familiar and portable across standard JavaScript runtimes.

### Negative Consequences

- Messages are broadcast to all subscribers on the channel (no private point-to-point addressing; point-to-point still uses `MessagePort`).
- Payload data is cloned via the structured clone algorithm (structured serialization overhead applies unless using `SharedArrayBuffer`).
