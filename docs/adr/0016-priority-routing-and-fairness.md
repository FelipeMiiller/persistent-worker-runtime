# ADR-0016: Priority Routing and Fairness via Numeric Task Priority

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: priority, queue, scheduling, fairness, fairness, sla

## Context and Problem Statement

The default `TaskQueue` (ADR-0004) is a strict FIFO. In real-world workloads, callers need to discriminate between latency-sensitive and latency-tolerant work without forking into separate runtimes:

- A premium-tier HTTP request must overtake a batch analytics job queued seconds earlier.
- A live chat message must preempt nightly housekeeping.
- A time-sensitive webhook must not wait behind a long housekeeping flush.

Without an ordering signal, every task gets equal wait time regardless of business importance, causing SLA breaches on high-priority traffic and bursty head-of-line blocking.

A naive "separate runtimes per priority" approach doubles resource overhead, breaks shared L1 state, and forces developers to hand-wire dispatch. A pre-emption approach (kill the running task) is too aggressive and wastes already-consumed CPU.

## Decision Drivers

- Provide a single-knob numeric priority per task that orders admission without forking the runtime.
- Preserve FIFO order among tasks of equal priority (no random shuffling).
- Behave deterministically under load: high-priority bursts should drain quickly without starving low-priority work forever.
- Zero new dependencies; reuse the existing `TaskQueue` data structure.
- Be observable: callers can see priority on the `TaskHandle` and on telemetry.

## Considered Options

- **Option 1: Strict FIFO with no priority** — equal wait time regardless of business value; causes SLA breaches under mixed-priority load.
- **Option 2: Separate runtimes per priority tier** — clean isolation but doubles resource overhead, prevents cross-priority L1 cache reuse, and pushes complexity to every call site that has to pick a runtime.
- **Option 3: Numeric priority on `TaskHandle`, sorted insertion in `TaskQueue`** — one integer per task; insertion uses linear scan for a tiny queue (`O(n)` with `n` typically < pool size); admission and dispatch become priority-aware.

## Decision Outcome

Chosen option: **"Option 3: Numeric priority on `TaskHandle`, sorted insertion in `TaskQueue`"**, because it preserves single-runtime simplicity, costs one integer per task, and naturally extends the existing backpressure semantics from ADR-0004.

### Architectural Mechanics

1. **Per-Task Numeric Priority**
   - Every `TaskHandle` carries a `priority` integer (default `0`).
   - Higher number = higher priority. Negative values are allowed (lower than default).
   - Set via `dispatch({ priority: 10, ... })` or `execute({ priority: 10, ... })`.

2. **Sorted Insertion**
   - `TaskQueue.#insert(task)` walks the queue in reverse and inserts at the first slot whose priority is lower than the incoming task (`src/task-queue.js:126-131`).
   - Result: the queue is always sorted by descending priority, with FIFO order within each tier.

3. **Dispatch Order**
   - The supervisor pulls from `queue.dequeue()` (FIFO among equal priorities) and assigns to the next idle worker.
   - Affinity rules from ADR-0009 still apply within a priority tier.

4. **Default and Range**
   - Default `priority = 0` preserves backwards compatibility — existing callers see no behaviour change.
   - Reasonable range: `-10` (housekeeping) to `10` (interactive). The runtime does not enforce a hard range; callers are responsible for sane values.

5. **Starvation Avoidance**
   - Pure priority scheduling risks starvation of low-priority work under sustained high-priority load. The current implementation does **not** auto-age priorities; if starvation becomes a concern, a future enhancement can promote aging tasks (out of scope here).

### Positive Consequences

- Single numeric knob (`priority`) gives callers direct control over dispatch order.
- Zero new dependencies; existing `TaskQueue` absorbs the feature with one comparator.
- README §7 documents a 4-tier test (priorities 0/1/5/10) that drains in strict priority order with 30 tasks on a single worker — fully deterministic.
- Benchmark `benchmarks/priority-routing.benchmark.js` measures starvation resistance under mixed load.

### Negative Consequences

- `O(n)` insertion per enqueue; acceptable because the queue is bounded (`queueSize` defaults to a small number), but pathological cases with thousands of queued tasks pay linear cost.
- No automatic aging → low-priority tasks can starve under sustained high-priority load. Documented limitation; future enhancement if needed.
- Priority is a hint, not a guarantee — if all workers are busy and the queue is full, even a `priority: 10` task will hit `queueTimeoutMs` and reject.

## Pros and Cons of the Options

### Option 3 ✅ Chosen

- ✅ One integer per task; trivial API surface.
- ✅ Sorted insertion keeps the queue always-ready for dispatch.
- ✅ Deterministic — the same input order produces the same output order.
- ❌ `O(n)` insertion cost (acceptable given bounded queue).
- ❌ No automatic aging; risk of low-priority starvation under sustained high-priority load.

### Option 1

- ✅ Trivial to implement and reason about.
- ❌ No mechanism to express SLA differences between callers.
- ❌ Head-of-line blocking under mixed-priority load.

### Option 2

- ✅ Clean isolation between priority tiers.
- ❌ Doubles resource overhead (two pools, two supervisors).
- ❌ Breaks shared L1 state across priorities.
- ❌ Forces every caller to pick a runtime.

## Verification

- 127-line unit test suite at `test/priority-routing.test.js` covering: single-worker serial priority ordering (4 tiers, 30 tasks), dispatch priority verification, fairness under mixed load, and starvation resistance scenarios.
- Benchmark `benchmarks/priority-routing.benchmark.js` measures end-to-end SLA under mixed-priority stress.
- Example `examples/priority-routing.js` demonstrates premium-tier-vs-batch ordering in 30 lines.
- `src/task-queue.js:126-131` is the only implementation change; existing queue coverage remains intact.

## Links

- Related: [ADR-0004: Asynchronous Queue Backpressure with Timeout](0004-asynchronous-queue-backpressure-with-timeout.md) — provides the queue that now sorts by priority.
- Related: [ADR-0009: Elastic Worker Pool Auto-Scaling](0009-elastic-worker-pool-auto-scaling.md) — affinity rules apply within a priority tier.
- Implementation: `src/task-queue.js` (`#insert` at lines 126–131); `src/task-handle.js` (`priority` option).
- Tests: `test/priority-routing.test.js`; benchmark `benchmarks/priority-routing.benchmark.js`; example `examples/priority-routing.js`.
