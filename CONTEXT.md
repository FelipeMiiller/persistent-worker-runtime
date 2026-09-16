# Node.js Persistent Worker Runtime

## 1. Document Objective

This document contains the entire architectural context discussed to date regarding the creation of a concurrent execution engine for Node.js.

The purpose is to allow any AI or engineer to continue the investigation and implementation without needing prior knowledge of previous discussions.

This document **does not imply that all architectural aspects are definitively finalized**.

Some parts represent proposed architectural decisions, while others are hypotheses that require investigation, prototyping, and benchmark validation.

---

# 2. Problem Statement

Node.js features an Event Loop-based concurrency model that excels at asynchronous operations and non-blocking I/O.

The fundamental issue arises when an application must execute CPU-bound work.

Example:

```js
async function processData() {
  const result = expensiveCalculation();

  return result;
}
```

Even though the function is declared `async`, if `expensiveCalculation()` consumes CPU synchronously, it executes directly on the thread driving the Event Loop.

This leads to event loop starvation:

```text
HTTP Request
     ↓
Event Loop
     ↓
CPU-heavy task
     ↓
Event Loop blocked
     ↓
All other requests queued / timing out
```

The primary goal of this project is to eliminate this bottleneck.

---

# 3. Non-Goals (What We Are NOT Doing)

* We are NOT replacing the Node.js Event Loop.
* We are NOT abandoning the asynchronous model of Node.js.
* We are NOT turning every operation into a Worker.
* We are NOT spawning a brand-new process for each task.
* We are NOT blindly copying Go's goroutines model.
* We are NOT sharing arbitrary mutable JavaScript objects between threads.

The core principle:

> Keep the Event Loop exactly where it is most efficient (I/O, coordination) and create a complementary layer to execute CPU-bound workloads off-thread.

---

# 4. Core Concept

The foundational concept is a:

> **Persistent Worker Runtime**

built atop Node.js native concurrency primitives (`node:worker_threads`).

Conceptually:

```text
                    NODE APPLICATION
                           │
                           ▼
                    ┌─────────────┐
                    │ Event Loop  │
                    └──────┬──────┘
                           │
                     submit(task)
                           │
                           ▼
                  ┌──────────────────┐
                  │  Worker Runtime  │
                  │                  │
                  │  Task Queue      │
                  │       ↓          │
                  │  Scheduler       │
                  │       ↓          │
                  │  Worker Thread   │
                  │       ↓          │
                  │  Worker Memory   │
                  └────────┬─────────┘
                           │
                           ▼
                        result
                           │
                           ▼
                    Event Loop
```

* The Event Loop coordinates.
* The Worker executes.
* The Worker preserves its own private state.
* The result returns asynchronously via Promises.

---

# 5. Target Developer Experience (DX)

The application should be able to write idiomatic code such as:

```js
const result = await runtime.execute(task);
```

or:

```js
const task = runtime.spawn(() => {
  return expensiveOperation();
});

const result = await task.result();
```

Users of this runtime should not have to manage low-level plumbing directly:

```js
new Worker(...)
worker.postMessage(...)
worker.on('message', ...)
worker.terminate(...)
```

All lifecycle and IPC mechanics must be abstracted within the Runtime.

---

# 6. Task Execution Flow

The desired execution flow:

```text
Application
    │
    ▼
Event Loop
    │
    │ submit
    ▼
Task Queue
    │
    ▼
Scheduler
    │
    ▼
Persistent Worker
    │
    ▼
Execute Task
    │
    ▼
Result
    │
    ▼
Promise Resolution
    │
    ▼
Application
```

The Event Loop must never execute the CPU-heavy segment of the task. It strictly acts as the coordinator.

---

# 7. Why a Persistent Worker?

A traditional, ad-hoc worker setup operates as follows:

```text
create Worker
      ↓
execute task
      ↓
return result
      ↓
terminate Worker
```

This discards a vital capability:

```text
Worker State
```

Our architecture maintains worker threads alive across consecutive executions:

```text
Worker
│
├── Task A
├── Task B
├── Task C
├── Task D
└── Task N
```

Each persistent worker possesses its own dedicated V8 Isolate and private memory heap that stays warm between tasks.

---

# 8. Persistent Worker State

The term "persistent" in this context has two distinct meanings:

## 8.1 Persistent During Worker Lifetime (Worker-Local State)

Example:

```js
const cache = new Map();
```

* **Task A:** `cache.set("user:123", user);`
* **Task B:** `cache.get("user:123");`

The state remains available because the worker process/thread remains alive.

This is defined as:

> **Worker-local persistent state (L1 Heap).**

---

## 8.2 Persistent Across Crashes (Durable State)

If:

```text
Worker
   ↓
CRASH (OOM / Fatal Error)
```

the JavaScript heap of that specific worker is destroyed.

Therefore, an in-memory `Map` cannot be considered durable across crashes.

For state to survive a crash, it must reside outside the worker's volatile heap:

```text
Worker
   │
   ├── Local State (L1 Heap)
   │
   └── Durable State (L3 Storage)
             │
             ├── database (node:sqlite)
             ├── Write-Ahead Log (WAL)
             ├── filesystem
             └── embedded storage
```

---

# 9. Three-Tier Memory Architecture

```text
              Worker Runtime
                    │
       ┌────────────┼────────────┐
       │            │            │
       ▼            ▼            ▼
    L1 Memory    L2 Shared     L3 Durable
  (Local Heap)     Memory       Storage
```

## L1 — Worker Local Memory (Private Heap)

Private memory dedicated to a specific worker.

Examples:
* `Map`, `Set`, `Array`, plain objects
* In-memory cache
* Loaded machine learning models / embeddings
* Pre-compiled WASM modules or ASTs
* Buffers and runtime scratchpads

Characteristics:
* Extremely fast (standard V8 access speeds).
* Requires zero cross-thread locking or synchronization.
* Strictly owned by that worker.
* Disappears when the worker dies.

**This is the default memory model.**

---

# 10. L2 — Shared Memory

Used when high-frequency data must be shared across threads with minimal serialization overhead.

Candidate technologies:
* `SharedArrayBuffer`
* `Atomics`

Architecture:

```text
              Shared Memory
          ┌──────────────────┐
          │                  │
          │     Buffer       │
          │                  │
          └──────────────────┘
             ▲            ▲
             │            │
          Worker A     Worker B
```

**CRITICAL PRINCIPLE:**
We are NOT aiming to create "shared JavaScript objects". The goal is controlled binary data structures (e.g., ring buffers, counters, memory-mapped slabs).

---

# 11. L3 — Durable Storage

Data that must not be lost upon thread crash or process restart:
* `node:sqlite` (native in Node.js 22+)
* LMDB / RocksDB
* WAL (Write-Ahead Log)
* Local filesystem

Technology choice remains open and will be decided based on durability and recovery requirements.

---

# 12. Inter-Thread Communication (IPC)

Primary communication between the Event Loop and Workers utilizes standard message passing.

Native Node.js candidate primitives:
* `MessagePort`
* `MessageChannel`
* `postMessage`

Model:

```text
Main Thread
     │
     │ Task Message
     ▼
MessagePort
     │
     ▼
Worker Thread
     │
     │ Result Message
     ▼
MessagePort
     │
     ▼
Main Thread
```

Message payload structure:
* `taskId` (UUID or incremental int)
* `taskType`
* `payload`
* `metadata`
* `result`
* `error`
* `status`

---

# 13. Inspiration from Go

The project draws architectural inspiration from concurrency models in other ecosystems, particularly Go.

We are NOT attempting to reimplement goroutines in Node.js.

Go distinguishes:
* Execution (`goroutines`)
* Communication (`channels`)
* Scheduling (`M:N scheduler`)

The key insight is separating **execution**, **communication**, and **state ownership**, rather than allowing arbitrary threads to mutate shared state concurrently.

In Node.js, the mapped adaptation is:
> `Promise` + `Worker Threads` + `MessagePort` + `Task Queue` + `Persistent Worker State`.

---

# 14. Inspiration from the Actor Model

Another guiding concept is the Actor Model (Erlang, Akka):

```text
Actor
│
├── private state
├── mailbox (queue)
└── sequential execution
```

A persistent worker acts as an actor:
* Private state is protected from external tampering.
* Messages arrive in its mailbox.
* The worker processes tasks sequentially, mutating its own state safely without locks.

---

# 15. Inspiration from Java ExecutorService

The Java `ExecutorService` model abstracts thread management:

```text
Executor
   ↓
submit(task)
   ↓
Future
   ↓
result
```

Our Runtime provides a similar abstraction for Node.js, augmented with:
* Persistent warm worker state
* Worker affinity
* Supervisor with auto-recovery
* Integrated diagnostics (`AsyncResource`)

---

# 16. Worker Pool vs. Persistent Worker Runtime

A conventional worker pool:
* Recycles threads purely to avoid creation overhead.
* Treats all tasks as stateless and interchangeable.

Our Persistent Worker Runtime adds:
* **Worker Affinity:** Ability to route related tasks back to the same worker holding specific warm state.
* **Supervisor:** Crash detection, heartbeats, and replacement.
* **State Ownership:** Clear boundary between ephemeral and stateful task execution.

---

# 17. Specialized Workers

Workers can be dedicated to specialized domains:

```text
Application
    │
    ├── HTTP / I/O (Main Event Loop)
    │
    └── Worker Runtime
           │
           ├── AI / Embeddings Worker
           ├── Image Processing Worker
           ├── Data Transformation (ETL) Worker
           └── Compression Worker
```

An AI Worker loads a multi-megabyte model into L1 memory once at startup, subsequently processing tasks with near-zero latency.

---

# 18. Supervisor

The Runtime features a Supervisor component:

```text
                    Supervisor
                        │
           ┌────────────┼────────────┐
           ▼            ▼            ▼
        Worker A      Worker B      Worker C
```

Responsibilities:
* Spawning and provisioning workers.
* Monitoring worker health and heartbeats.
* Detecting unexpected terminations and crashes.
* Restarting failed workers automatically.
* Managing pool capacity and task draining.
* Exposing metrics and diagnostic signals.

---

# 19. Fault Recovery

When a worker thread crashes:
* The active in-flight task's Promise rejects with a clear `WorkerCrashError`.
* The Supervisor provisions a fresh replacement worker to maintain configured capacity.
* Unhandled queued tasks are rescheduled.
* Retries must account for idempotency (non-idempotent tasks should not be retried automatically).

---

# 20. Resource Isolation

Worker threads run within the same OS process:
* They share the total process memory and CPU allotment.
* While Node.js provides `resourceLimits` for V8 heaps, thread crashes can still impact process stability if unhandled.
* Worker threads provide **logical execution isolation**, not hard kernel-level process sandboxing.

---

# 21. Task Classifications

Two primary task categories:

### 21.1 Ephemeral Tasks
```js
const result = await runtime.execute(task);
```
Stateless. Can run on any available worker in the general pool.

### 21.2 Stateful Tasks
```js
const workerHandle = runtime.createStatefulWorker("model-engine");
const res1 = await workerHandle.execute(task1);
const res2 = await workerHandle.execute(task2);
```
Stateful. Tasks are pinned to a specific worker that preserves local L1 state between calls.

---

# 22. Backpressure and Queue Management

Unbounded queues lead to Out-Of-Memory (OOM) failures under heavy load.

The Runtime must enforce backpressure:
* `maxQueueSize`: Configurable maximum queue depth.
* Strategies upon queue saturation:
  * `reject` (Fast-fail with `QueueOverflowError`).
  * `wait` (Backpressure pausing task ingestion).
  * `timeout` (Tasks expire if waiting too long in queue).

---

# 23. Task Cancellation

Cancelation must be supported cleanly via standard Node.js APIs:
* `AbortSignal` / `AbortController` integration.
* Cooperative cancellation: Tasks periodically check `signal.aborted`.
* Uncooperative / runaway tasks: Worker termination as a last resort.

---

# 24. Single-Task Concurrency per Worker

Initial architectural rule:
> **One CPU-bound task per worker thread at a time.**

Processing tasks sequentially per worker simplifies:
* State ownership.
* Cancellation.
* Crash attribution.
* Debugging and profiling.

---

# 25. Golden Rule: Message Passing over Shared Mutable Memory

> Prefer message passing (`postMessage`, `MessagePort`) by default.  
> Reserve shared mutable memory (`SharedArrayBuffer`) strictly for proven bottlenecks.

---

# 26. Mandatory Benchmarks

We never assume an abstraction improves performance without measurement.

Comparative test matrix:
1. **Scenario A:** Pure synchronous execution on the Main Event Loop.
2. **Scenario B:** Ad-hoc `new Worker()` per task.
3. **Scenario C:** Generic userland worker pool (`piscina`).
4. **Scenario D:** Persistent Worker Runtime (Ephemeral tasks).
5. **Scenario E:** Persistent Worker Runtime (Stateful warm L1 tasks).

Core Metrics:
* Event Loop delay / lag (`perf_hooks.monitorEventLoopDelay`)
* Request latency (p50, p95, p99)
* Throughput (operations per second)
* Memory usage (RSS, heapUsed)
* IPC serialization overhead

---

# 27. Key Question to Answer Experimentally

> *Is it possible to build a concurrent execution layer atop `node:worker_threads` that preserves the Event Loop for non-blocking I/O, moves CPU-bound tasks off-thread, and enables workers to maintain warm private state between tasks without introducing communication overhead that negates the benefit?*

---

# 28. Instructions for Next Implementations

1. Keep the entire codebase in **idiomatic, modern pure JavaScript (ESM)**.
2. Target **Node.js >= 24.0.0** (using built-in `node:test`, `node:worker_threads`, `node:async_hooks`, `node:perf_hooks`).
3. Zero external runtime dependencies (essential for Node.js Core submission).
4. Prove the core execution pipeline first:
   ```text
   submit → queue → worker → execute → result
   ```
   while keeping the main Event Loop responsive.

---

# 29. Advanced Architectural Roadmap (ADR-0010 to ADR-0014)

The runtime roadmap incorporates five enterprise-grade architectural pillars:

1. **Automatic Worker Recycling (ADR-0010)**: Prevents V8 heap fragmentation and gradual closure leaks via graceful worker retirement after `maxTasksPerWorker` or `maxMemoryMb`.
2. **Hard Preemption Watchdog (ADR-0011)**: Protects the system against synchronous runaway loops (`while(true)`) and ReDoS via main-thread orchestrator termination (`forceKillOnTimeout`).
3. **Streaming Results via AsyncGenerator (ADR-0012)**: Constant $O(1)$ memory consumption for multi-gigabyte outputs and LLM token streaming via `runtime.stream()` and `for await...of`.
4. **Inter-Worker Broadcast Bus (ADR-0013)**: Direct worker-to-worker and orchestrator-to-all-worker pub/sub coordination using native `BroadcastChannel` with zero main-thread routing.
5. **Adaptive Concurrency via ELU (ADR-0014)**: Dynamic worker scaling and queue throttling driven by `performance.eventLoopUtilization()` (ELU) to protect HTTP/I/O latency under peak load.

