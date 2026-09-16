# ADR-0010: Automatic Worker Recycling and Heap Rejuvenation

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: memory, lifecycle, garbage-collection, reliability, supervisor

## Context and Problem Statement

Long-running worker threads in 24/7 production Node.js services process hundreds of thousands or millions of tasks over days or weeks. Over extended runtimes, V8 heaps can suffer from memory fragmentation, slow closure retention leaks in user-provided task functions, or unmanaged native memory creep in third-party C++ addons and WebAssembly (WASM) modules. 

Without proactive worker lifecycle management, memory consumption grows monotonically until an Out-Of-Memory (OOM) error terminates the worker process abruptly. Such sudden crashes drop in-flight tasks and induce latency spikes during supervisor crash recovery. How can the Persistent Worker Runtime guarantee bounded memory consumption and prevent gradual degradation without interrupting active workloads?

## Decision Drivers

- Must prevent unbounded V8 heap growth and fragmentation in 24/7 background worker threads.
- Must operate with zero disruption to in-flight tasks (graceful retirement after task completion).
- Must provide configurable thresholds for both task count throughput (`maxTasksPerWorker`) and resident heap consumption (`maxMemoryMb`).
- Must guarantee zero-downtime pool capacity by provisioning replacement workers before shutting down retired instances.
- Must maintain full transparency to the caller without requiring manual pool lifecycle management in application code.

## Considered Options

- **Option 1: Status Quo (Infinite Worker Lifespan)**: Rely entirely on V8 Garbage Collection and supervisor crash-restart upon fatal OOM.
- **Option 2: Hard Periodic Kill on Timer**: Terminate and restart workers on a fixed interval (e.g., every 30 minutes), regardless of task state.
- **Option 3: Explicit Manual Recycling API**: Expose `runtime.recycleWorker(workerId)` and require user application code to track memory and invoke restarts.
- **Option 4: Autonomous Graceful Worker Recycling**: Supervisor automatically monitors task counts and worker heap statistics, executing non-disruptive retirement and replacement once thresholds are exceeded.

## Decision Outcome

Chosen option: **"Option 4: Autonomous Graceful Worker Recycling"**, because it provides deterministic memory rejuvenation without user intervention, preserves task reliability, and prevents cold-start pool capacity drops.

### Architectural Mechanics

1. **Configurable Thresholds**:
   - `maxTasksPerWorker` (default: `Infinity`): Maximum number of tasks a worker may execute before being scheduled for retirement.
   - `maxMemoryMb` (default: `Infinity`): Maximum V8 heap size in megabytes before a worker is marked for recycling.
2. **Health Check & State Tracking**:
   - The `WorkerHandle` tracks `tasksExecuted` and samples `v8.getHeapStatistics()` or `process.memoryUsage()` after task execution.
   - When either threshold is reached, the worker state transitions from `'IDLE'` to `'RECYCLING'`.
3. **Graceful Succession**:
   - A replacement worker is provisioned and bootstrapped into the pool to preserve target concurrency.
   - The recycling worker completes any active task, rejects new task assignment, and exits gracefully via `worker.terminate()`.
   - All associated resources (event listeners, channels, ports) are cleanly unreferenced and disposed.

### Positive Consequences

- Predictable, bounded memory usage across indefinite service runtimes.
- Mitigates micro-leaks in user code, native libraries, and WASM memory spaces before OOM crashes occur.
- Zero dropped tasks: retirement occurs exclusively between task completions.
- Zero pool starvation: replacement workers are spawned concurrently with the retiring worker.

### Negative Consequences

- Retiring a worker clears its warm L1 in-memory heap (`localState`), requiring the new replacement worker to re-warm its local cache on subsequent tasks.
- Minor CPU overhead for periodic V8 heap sampling (mitigated by sampling only on task boundaries rather than continuous polling).
