# ADR-0003: Dual Execution Model (execute vs. dispatch) and Transactional Outbox Support

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: api-design, background-jobs, outbox-pattern, developer-experience

## Context and Problem Statement

Applications perform two fundamentally distinct kinds of off-thread work:
1. **Interactive Computation:** Operations whose result is immediately needed by the caller to formulate an HTTP response (e.g., image resizing, heavy validation).
2. **Background Side-Effects / Outbox Jobs:** Operations triggered by an event (e.g., user registered) where the HTTP response must be returned immediately (e.g. `201 Created`), while the side-effect (e.g., email dispatch, provisioning, audit logging) runs concurrently in the background with asynchronous completion confirmation.

How should the runtime API expose both paradigms cleanly?

## Decision Drivers

- Immediate HTTP response times for transactional endpoints.
- Seamless compatibility with the Transactional Outbox Pattern without requiring Kafka or Redis.
- Asynchronous confirmation tracking via callbacks and events without blocking the caller.
- Unified scheduling and thread management across both modes.

## Considered Options

- **Option 1: Only Promise-based `execute()`** (Forces callers to attach unmonitored `.catch()` handlers for background tasks)
- **Option 2: Separate libraries for Worker Pools and Background Queues**
- **Option 3: Dual Execution Model: `runtime.execute()` and `runtime.dispatch()` on the same core engine**

## Decision Outcome

Chosen option: **"Option 3: Dual Execution Model"**, because it unifies synchronous-wait requests and asynchronous fire-and-track background workloads under one resource-managed pool.

### API Capabilities:
* **`runtime.execute(task)`**: Returns a Promise resolving to the worker's result.
* **`runtime.dispatch(task)`**: Returns a `TaskHandle` immediately. Caller completes HTTP response; the `TaskHandle` provides `.onComplete(cb)` and `.onError(cb)` to update the Outbox table or trigger logs asynchronously.

### Positive Consequences

- Enables instant sub-5ms HTTP responses on user creation while offloading template rendering and email sending to worker threads.
- Direct alignment with the Transactional Outbox Pattern: the outbox record is updated upon `onComplete` or `onError` without external broker dependencies.
- Full trace context and error isolation preserved.

### Negative Consequences

- Developers must remember to use `dispatch()` when they don't want to wait, and `execute()` when they do.
