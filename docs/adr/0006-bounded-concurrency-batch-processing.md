# ADR-0006: Bounded Concurrency Batch Processing (executeAll & dispatchAll)

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: api-design, batch-processing, concurrency, promise-all

## Context and Problem Statement

When an application receives a request that requires multiple parallel operations (for example: generating an invoice PDF, charging a payment gateway, and notifying a warehouse), developers frequently rely on `Promise.all([op1(), op2(), op3()])`. However, if those operations involve CPU-bound processing, running them uncapped on standard threads causes thread thrashing and high context switching. How can the runtime provide familiar `Promise.all` semantics while guaranteeing strictly bounded worker thread concurrency?

## Decision Drivers

- Provide an intuitive `Promise.all`-style interface (`executeAll` and `dispatchAll`).
- Bound worker thread utilization to the pool's configured capacity (e.g. 2 or 4 workers).
- Allow sequential task queue draining: if 4 tasks are submitted to 2 workers, Tasks 1 & 2 run simultaneously; as each worker finishes, Tasks 3 & 4 are picked up immediately.
- Preserve task result ordering corresponding to input indices.

## Considered Options

- **Option 1: Require users to write manual loops or userland `p-limit` / `p-map` packages**
- **Option 2: Native Bounded Batch Execution API (`runtime.executeAll` / `runtime.dispatchAll`)**

## Decision Outcome

Chosen option: **"Option 2: Native Bounded Batch Execution API (`runtime.executeAll` / `runtime.dispatchAll`)"**, because it provides zero-dependency, native `Promise.all` and `Promise.allSettled` ergonomics directly integrated with the runtime's internal priority and scheduling queue.

### Example:
```javascript
// Submits 4 tasks to a 2-worker pool:
// Workers 1 & 2 process Tasks A & B; as soon as one finishes, Task C is executed.
const [invoice, receipt, label] = await runtime.executeAll([
  { type: 'generate_invoice', payload: orderData },
  { type: 'generate_receipt', payload: orderData },
  { type: 'create_shipping_label', payload: orderData },
]);
```

### Positive Consequences

- Eliminates the need for external npm packages like `p-limit` or `p-map`.
- Guaranteed CPU boundary protection: never spawns runaway threads.
- Predictable execution order and error propagation.

### Negative Consequences

- Batch tasks that wait in queue are subject to `queueTimeoutMs` if the pool is saturated by other workloads.
