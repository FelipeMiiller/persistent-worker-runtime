# Feature Specification: Persistent Worker Runtime

- **Feature Name:** `persistent-worker-runtime`
- **Specification Format:** EARS (Easy Approach to Requirements Syntax)
- **Status:** Approved / Implemented

---

## 1. Overview & System Scope

The **Persistent Worker Runtime** provides a concurrent execution layer atop `node:worker_threads`. It eliminates Event Loop starvation during CPU-bound processing and enables in-process background job dispatching (Transactional Outbox pattern) while maintaining persistent, warm worker-local memory heaps.

---

## 2. Functional Requirements (EARS Notation)

### 2.1 Ubiquitous Requirements (Always Active)

* **REQ-UBI-001:** The runtime **shall** maintain the Main Event Loop completely free for non-blocking I/O during all task executions.
* **REQ-UBI-002:** The runtime **shall** be authored in pure vanilla JavaScript (ESM) with zero third-party runtime dependencies.
* **REQ-UBI-003:** The runtime **shall** associate each submitted task with an `AsyncResource` to ensure distributed tracing context propagates across thread boundaries.

### 2.2 Event-Driven Requirements (Triggered by Actions)

* **REQ-EVT-001:** When a caller invokes `runtime.execute(task)`, the runtime **shall** offload execution to a persistent worker thread and return a Promise resolving to the worker's computation result.
* **REQ-EVT-002:** When a caller invokes `runtime.executeAll(tasks)`, the runtime **shall** schedule all tasks across available workers in parallel up to the pool capacity, resolving an array of results in corresponding input index order.
* **REQ-EVT-003:** When a caller invokes `runtime.dispatch(task)`, the runtime **shall** return a `TaskHandle` immediately without awaiting execution, exposing `.onComplete(callback)` and `.onError(callback)` for asynchronous confirmation.
* **REQ-EVT-004:** When a task specifies `transferList`, the runtime **shall** transfer ownership of specified `ArrayBuffer` objects to the worker thread without memory copying.
* **REQ-EVT-005:** When a task specifies `retries > 0` and fails, the runtime **shall** re-enqueue the task non-blockingly using exponential backoff without tying up the worker thread during the delay.

### 2.3 State-Driven Requirements (Conditional on Runtime State)

* **REQ-STA-001:** While a dedicated stateful worker is alive, it **shall** preserve its private in-memory L1 heap (`localState` Map) across consecutive executions.
* **REQ-STA-002:** While task ingestion exceeds worker processing capacity, the `TaskQueue` **shall** accept tasks up to `maxQueueSize` without blocking the Event Loop.
* **REQ-STA-003:** While the queue is at capacity (`queueDepth >= maxQueueSize`), incoming tasks **shall** wait asynchronously up to `queueTimeoutMs`.

### 2.4 Unwanted Behavior & Error Handling (Negative Scenarios)

* **REQ-UNW-001:** If a task waits in queue longer than `queueTimeoutMs`, the runtime **shall** reject the task Promise with `TaskQueueTimeoutError` containing queue depth and wait duration.
* **REQ-UNW-002:** If a worker thread crashes unexpectedly or exits with a non-zero code, the Supervisor **shall** immediately reject the active task with `WorkerCrashError` and automatically spawn a replacement worker.
* **REQ-UNW-003:** If a caller triggers an `AbortSignal`, the runtime **shall** reject the task Promise with `TaskAbortedError`.
