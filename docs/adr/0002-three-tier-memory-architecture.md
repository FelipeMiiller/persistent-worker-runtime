# ADR-0002: Three-Tier Memory Architecture (L1 / L2 / L3)

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: architecture, memory, state-management, concurrency

## Context and Problem Statement

Worker threads running inside the same OS process have separate V8 Isolates and memory heaps. Generic worker pool libraries treat workers as disposable executors of pure functions, forcing data re-parsing or reloading on every task. How should memory and state ownership be structured across the runtime to balance extreme execution speed, optional zero-copy sharing, and crash resilience?

## Decision Drivers

- Zero synchronization locks for the dominant execution path.
- Enable high-speed reuse of large warmed objects (ML models, tokenizers, AST caches).
- Avoid premature complexity of raw shared mutable memory where message passing suffices.
- Provide a clear conceptual boundary for crash survival.

## Considered Options

- **Option 1: Purely Stateless Workers (Default in most npm pools)**
- **Option 2: Immediate SharedArrayBuffer + Atomics for all data structures**
- **Option 3: Three-Tier Memory Model: L1 (Worker-Local Heap) / L2 (Shared Memory) / L3 (Durable Storage)**

## Decision Outcome

Chosen option: **"Option 3: Three-Tier Memory Model"**, because it provides the fastest, lock-free memory model by default (L1), reserves high-performance binary sharing (L2) for proven bottlenecks, and decouples crash recovery (L3).

### Memory Tiers:
1. **L1 (Worker-Local Heap):** Private to each worker. Standard V8 speed, zero locks. Survives between tasks on the same worker; destroyed on thread crash.
2. **L2 (Shared Memory):** `SharedArrayBuffer` + `Atomics`. Strictly opt-in for zero-copy binary streaming and high-frequency counters.
3. **L3 (Durable Storage):** External to the worker heap (e.g. `node:sqlite`, filesystem, WAL). Survives thread and process crashes.

### Positive Consequences

- L1 is blazing fast and requires zero lock contention or mutexes.
- Large datasets or initialized WASM modules stay warm in L1 memory.
- Clear separation between worker lifetime persistence (L1) and durability across crashes (L3).

### Negative Consequences

- If a worker crashes, its L1 heap is lost and must be re-initialized upon restart.
- Developers must design tasks to be idempotent if recovery replays them.
