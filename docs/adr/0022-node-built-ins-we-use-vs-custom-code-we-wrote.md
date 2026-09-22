# ADR-0022: Node Built-Ins We Use vs Custom Code We Wrote

- **Date**: 2026-09-18
- **Status**: Accepted
- **Deciders**: Mavis (assistant) + Felipe (maintainer)
- **Tags**: meta, architecture, dependencies, zero-deps

## Context and Problem Statement

The runtime is built on `node:worker_threads` with **zero external runtime dependencies** (ADR-0005). This raises a recurring question from reviewers: **what code do we write ourselves that Node already provides, vs what code do we write because Node doesn't provide it?**

Without an explicit answer, future contributors will guess — some will assume the runtime has reinvented Node core and propose ripping out custom code. Others will assume everything custom is necessary and refuse to evaluate external alternatives (e.g., Piscina, BullMQ). Both are wrong.

This ADR is the authoritative answer. It maps every significant piece of the runtime to either a Node built-in (we use it as-is) or a custom module (we wrote it because Node doesn't have it). External library alternatives are noted for completeness but do **not** change the zero-deps stance (ADR-0005).

## Decision Drivers

- **Reviewer clarity**: a new contributor can `git blame` this ADR to understand what's intentional vs what's a candidate for replacement.
- **Zero-deps invariant**: ADR-0005 makes external deps a non-starter. The decision to *not* use Piscina, BullMQ, etc. is intentional, not oversight.
- **Document the why**: when Node DOES provide something, we use it. When Node DOESN'T, we build the smallest viable abstraction. The boundary matters.
- **External alternatives**: still listed for readers who maintain forks or who evaluate whether to switch to a library-rich stack.

## The Map

### ✅ Node built-ins we use as-is (no custom layer)

| Node API | Where | Why |
|---|---|---|
| `node:worker_threads` | `WorkerHandle`, `worker-thread-entry.js` | The foundation. Node's primitive for parallel V8 isolates. |
| `node:os.availableParallelism()` | `worker-runtime.js` | CPU detection (Node 22+). |
| `node:perf_hooks.monitorEventLoopDelay()` | `SignalMonitor` (adaptive-controller.js) | The histogram we read p99 from. Node built-in. |
| `performance.eventLoopUtilization()` | `SignalMonitor` | Native delta-based ELU measurement. |
| `node:worker_threads.BroadcastChannel` | ADR-0013 (inter-worker comms) | Web-standard cross-thread pub/sub. |
| `worker.postMessage(message, [transferList])` | ADR-0008 (zero-copy) | Structured clone with transferable buffers. |
| `AsyncGenerator` (JS language) | ADR-0012 (streaming results) | Native language feature; Node runtime honors it across `postMessage`. |
| `Promise`, `AbortSignal`, `AbortController` | task handles (ADR-0017), `execute()` / `dispatch()` | Language / Web-standard primitives. |

### ❌ Node DOES NOT provide — we built it custom

| Custom code | What it does | Why Node doesn't have it |
|---|---|---|
| `TaskQueue` + `maxQueueSize` + `queueTimeoutMs` (ADR-0004) | Backpressure-bounded queue with SLA timeout | Node has no in-process task queue with backpressure. `Promise.all` is unbounded; `events.EventEmitter` has no delivery SLA. |
| `Ewma` smoothing primitive (T2) | Exponential weighted moving average for noisy signals | Math primitive, not Node's concern. |
| `DebounceCounter` state machine (T3) | Counts consecutive same-direction signals; fires on threshold | Algorithmic primitive. Could use `lodash.debounce` but that's a debounce of *function calls*, not a counter of direction changes. |
| `SignalMonitor` (T2) | Combines `eventLoopUtilization()` + `monitorEventLoopDelay().percentile(99)` into a single dual-channel read | Adapters are always custom. |
| `classifyTickDirection` (T5) | Maps signals → `'grow' \| 'shrink' \| 'noop'` with strict thresholds | Auto-tuning policy is application-specific. |
| `WorkerHandle` (lifecycle wrapper) | Adds recycle + drain + retire semantics on top of `Worker` | `worker.terminate()` is hard kill. No built-in "drain in-flight then retire" path. |
| `Supervisor` (pool + crash recovery) | Pool sizing, auto-respawn, watchdog, recycling | `node:cluster` covers multi-process but not in-process pool management. |
| Retry policy with exponential backoff (ADR-0007) | Background-task retry with TTL | Node has no retry primitive. |
| L1 worker-local state + L2/L3 memory tiers (ADR-0002) | Persistent in-worker heap state | By design — workers are isolated. The abstraction is ours. |
| Priority routing + starvation resistance (ADR-0016) | Queue ordering with fairness guarantees | Not a Node concern; application policy. |
| Hard preemption watchdog (ADR-0011) | `worker.terminate()` after timeout | Node has no task-deadline enforcement. |
| Streaming via AsyncGenerator + structured IPC (ADR-0012) | Producer-side push of chunks | Pure JS async generator; the *structured-chunk IPC* design is ours. |

### 🔄 External libraries that COULD replace some custom code (NOT adopted)

Per ADR-0005 (zero external runtime deps), these are noted for completeness — not candidates for adoption unless the zero-deps stance changes.

| Library | Could replace | Why we don't use it |
|---|---|---|
| **Piscina** | `WorkerRuntime` core | Has pool + dispatch + transferList, but no adaptive concurrency, no drain semantics, no L1/L2/L3 tiers, no streaming, no priority. We'd still build our own layer on top. |
| **BullMQ** | `TaskQueue` (Redis-backed) | Has retry + priority + backoff for *Redis-backed* queues. ADR-0020 plans to use Postgres-backed instead (we already operate Postgres). |
| **threads.js** | `worker_threads` wrapper | Just a Promise wrapper. Doesn't add features we'd use. |
| **overload-protection** | Our adaptive controller | Less customizable than the threshold + debounce design we built. |
| **p-queue** | Simple async concurrency limit | No backpressure timeout, no SLA, no priority. |
| **async-retry** | ADR-0007 retry | Trivial to inline; spec already documents the policy. |

### ⚠️ Node built-ins we are NOT currently using but could

| Node API | Status | Notes |
|---|---|---|
| `node:cluster` | Not adopted | Mentioned in DR plan §3 as future work for multi-process supervision (analogous to Gunicorn). Out of scope for current zero-deps in-process runtime. |
| `EventTarget` | Not adopted | We use `EventEmitter` (slightly different API). Migration possible but no functional gain. |
| `Atomics.wait` / `SharedArrayBuffer` | Not adopted | Useful for shared-state coordination between workers; current design uses `postMessage` exclusively (simpler, no race conditions, but higher latency for hot loops). |
| `perf_hooks.Histogram` | Partial | We use `monitorEventLoopDelay` for p99, which IS a histogram. We don't yet expose our own `Histogram` for user-facing stats (T8 may add). |
| `structuredClone` | Not adopted | Native structured clone for cross-realm. Could simplify some IPC payloads but our current `postMessage` does the same thing. |

## Decision Outcome

**The boundary is clear and intentional.** Node built-ins are used as primitives; everything above them is application policy. We do not replace Node with re-implementations, and we do not introduce external libraries to replace what we built (zero-deps invariant from ADR-0005).

When Node DOES provide something, we use it. When Node DOES NOT, we build the smallest viable abstraction. The line is:

- **Node primitive** (worker_threads, perf_hooks, BroadcastChannel, transferList, AsyncGenerator, AbortSignal) → used directly.
- **Application policy** (queue sizing, retry strategy, adaptive tuning, drain semantics, memory tiers, priority routing) → built on top of the primitives.

## Pros and Cons of This Boundary

### ✅ Chosen

- ✅ Zero external deps means the runtime ships with Node.js itself and could become part of `node:` core (the project is positioned as a Node RFC proposal — see `NODEJS_RFC_PROPOSAL_DRAFT.md`).
- ✅ Every custom module has a focused test suite (currently 401 tests, 113 suites). External libs would hide those surfaces behind their own abstractions.
- ✅ The runtime's design is publicly auditable: read 8 ADRs + 8 modules and you understand everything.

### ⚠️ Trade-offs

- ❌ Reinventing wheels (Piscina-style pool, BullMQ-style queue). Acceptable cost given the zero-deps constraint and the audit benefits.
- ❌ Higher maintenance burden than "npm install piscina bullmq". Mitigated by small focused modules + comprehensive tests.

## When This ADR Should Be Updated

- When a new Node built-in becomes available that overlaps with our custom code (e.g., a future `node:queue` proposal).
- When we add a new custom module that should be listed in the "Node DOES NOT provide" table.
- When ADR-0005 (zero deps) is reconsidered.

## Links

- ADR-0005 — Pure ESM, zero external deps (the constraint this ADR documents the implications of).
- ADR-0014 — Adaptive concurrency (T5's `classifyTickDirection` is a "Node doesn't have it" case).
- ADR-0004 — Bounded queue backpressure (the `TaskQueue` is a "Node doesn't have it" case).
- `NODEJS_RFC_PROPOSAL_DRAFT.md` — the proposal to upstream parts of this runtime into Node core.
- Supersedes: none.
