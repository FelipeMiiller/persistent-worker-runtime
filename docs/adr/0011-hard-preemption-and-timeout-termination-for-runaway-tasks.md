# ADR-0011: Hard Preemption and Thread Termination for Runaway Tasks

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: resilience, timeouts, concurrency, preemption, supervisor

## Context and Problem Statement

JavaScript adheres to a run-to-completion, single-threaded execution model per V8 Isolate. When a worker thread encounters a non-yielding synchronous operation—such as an accidental infinite loop (`while(true)`), catastrophic regular expression backtracking (ReDoS), or an unyielding synchronous calculation—the thread never yields back to its internal event loop or microtask queue.

Cooperative cancellation patterns (such as passing an `AbortSignal` or inspecting timeout flags inside the worker) fail completely in this scenario because cooperative code can never execute once the thread is locked in an infinite sync loop. A single uncooperative task permanently captures an entire CPU core and disables that worker forever, degrading pool capacity. How can the runtime enforce strict execution SLAs and recover from runaway CPU loops?

## Decision Drivers

- Must guarantee strict SLA enforcement regardless of whether user code cooperates with cancellation tokens.
- Must prevent runaway synchronous loops or ReDoS vulnerabilities from permanently occupying CPU cores.
- Must automatically restore pool capacity by replacing terminated workers without administrative intervention.
- Must provide explicit error classification (`TaskTimeoutError` with `preempted: true`) to distinguish cooperative timeouts from forced preemptive kills.
- Must avoid proprietary native C++ addons, relying exclusively on standard Node.js APIs.

## Considered Options

- **Option 1: Cooperative Cancellation Only (`AbortController` / `AbortSignal`)**: Worker tasks must manually check `signal.aborted`. Ineffective against synchronous infinite loops or ReDoS.
- **Option 2: Native C++ Isolate Termination Addon**: Embed native bindings to call V8's `v8::Isolate::TerminateExecution()`. Violates the zero-external-dependencies and portability principles.
- **Option 3: Hard Preemptive Kill via Orchestrator `worker.terminate()`**: Main thread supervisor sets an authoritative watchdog timer. If expired, it forcibly calls `worker.terminate()` and immediately provisions a replacement.

## Decision Outcome

Chosen option: **"Option 3: Hard Preemptive Kill via Orchestrator `worker.terminate()`"**, because it provides an unbypassable safety guarantee against hung threads using native Node.js `worker_threads` capabilities.

### Architectural Mechanics

1. **Watchdog Configuration**:
   - `timeoutMs`: Maximum execution time allowed for the task before timeout triggers.
   - `forceKillOnTimeout` (default: `false` for backwards compatibility; configurable at runtime or per-task level): When `true`, enables supervisor preemption.
   - `killGracePeriodMs` (default: `500ms`): Brief grace window allowing cooperative abort cleanup before hard termination is dispatched.
2. **Supervisor Watchdog Execution**:
   - Upon task dispatch, the main-thread `WorkerHandle` arms a precision watchdog timer using unrefed `setTimeout`.
   - If the worker does not post `MSG_TASK_SUCCESS` or `MSG_TASK_ERROR` before the deadline, the supervisor initiates preemption:
     1. Rejects the pending task Promise with a `TaskTimeoutError` containing `preempted: true` and the task execution metadata.
     2. Disconnects IPC listeners to prevent dangling references.
     3. Invokes `worker.terminate()`, which immediately terminates the underlying OS thread and V8 Isolate.
3. **Autonomous Pool Healing**:
   - The supervisor intercepts the worker exit event (code `1` or termination signal).
   - Because the termination was intentional (flagged `worker.isPreempted = true`), it bypasses crash backoff delays and immediately spawns a fresh worker to maintain target concurrency.

### Positive Consequences

- Absolute SLA protection: no synchronous loop, infinite recursion, or ReDoS can permanently hang the worker pool.
- Guaranteed self-healing: worker pool capacity is autonomously restored to 100% within milliseconds.
- Strict adherence to zero-external-dependencies: implemented entirely via `worker.terminate()`.

### Negative Consequences

- Forcible termination destroys the worker's private L1 heap (`localState`), requiring the newly provisioned worker to re-initialize any local caches.
- Operating system overhead of destroying and spawning a replacement OS thread (typically 10-30ms).
