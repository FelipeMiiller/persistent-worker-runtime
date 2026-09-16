# ADR-0004: Asynchronous Queue Backpressure with Timeout and AsyncResource

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: backpressure, queue, diagnostics, async_hooks, performance

## Context and Problem Statement

Under high traffic spikes, task ingestion can outpace worker processing capacity. Unbounded queues cause process memory to swell, eventually triggering Out-Of-Memory (OOM) crashes. Conversely, immediate fast-fail rejection under burst loads causes premature failures and loses trace context. Furthermore, crossing thread boundaries without proper diagnostic plumbing breaks APMs (OpenTelemetry, Datadog) and `AsyncLocalStorage`.

## Decision Drivers

- Prevent uncontrolled queue growth and OOM crashes.
- Never block the main Event Loop with synchronous loops or busy-waiting.
- Provide traceable errors when backpressure capacity cannot be resolved within a configured SLA.
- Preserve asynchronous context across main thread and worker threads using Node.js native APIs.

## Considered Options

- **Option 1: Unbounded Queue** (Severe risk of process OOM crashes)
- **Option 2: Immediate Fast-Fail Rejection (`QueueOverflowError`)** (Spikes failure rates on brief bursts; difficult to trace)
- **Option 3: Asynchronous Non-Blocking Waiting with `queueTimeoutMs` and native `AsyncResource`**

## Decision Outcome

Chosen option: **"Option 3: Asynchronous Non-Blocking Waiting with Timeout and AsyncResource"**, because it absorbs natural traffic spikes gracefully without blocking the Event Loop. If a worker frees up within `queueTimeoutMs`, the task executes seamlessly. If the timeout expires, the task rejects with a rich `TaskQueueTimeoutError` carrying queue depth and timing metrics for telemetry.

### Diagnostics Guarantee:
Each `TaskHandle` encapsulates an `AsyncResource` instance from `node:async_hooks`, ensuring:
1. `triggerAsyncId` is captured upon submission.
2. Worker result / error resolution executes inside `asyncResource.runInAsyncScope()`.
3. Distributed tracing and OpenTelemetry Spans propagate seamlessly across thread boundaries.

### Positive Consequences

- System remains stable under heavy bursts without crashing or dropping tasks prematurely.
- Full observability: timeout errors contain exact wait duration, queue depth, and task metadata.
- 100% compliant with Node.js diagnostic standards.

### Negative Consequences

- Tasks that exceed `queueTimeoutMs` are rejected, requiring callers or Outbox sweepers to handle retries.
