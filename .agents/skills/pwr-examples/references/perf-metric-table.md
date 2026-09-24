# Perf Metric Table — Which metric for which pattern

Source of truth for picking the metric when authoring a new example or auditing an existing one. If a runtime feature is missing from this table, the example probably needs `[correctness]` or `[api-surface]` instead — and the rationale paragraph must explain why.

## Decision tree

```
Is the runtime feature claiming throughput, latency, or Event-Loop responsiveness?
├─ Yes → pick the metric row below; baseline is "the same workload WITHOUT the feature"
└─ No  → is the runtime feature a correctness contract (error type, lifecycle guard)?
    ├─ Yes → `[correctness]` tag; no metric
    └─ No  → `[api-surface]` tag; the example shows how to use it, not how fast it is
```

## Full matrix

### Zero-copy transfer (`transferList`)

- **Baseline:** same buffer, omit `transferList` → structured-clone copy
- **Metric:** `elapsedMs` per scenario + sender `byteLength` after the call
- **Why:** Copy encodes the buffer on sender side AND decodes on worker side; transfer moves ownership.
- **Workload:** Buffer ≥ 1 MB. Below ~1 KB the structured-clone path is actually faster.
- **See:** `examples/zero-copy-image.js`

### State / L1 cache

- **Baseline:** rebuild the cache inside the fn body every call
- **Metric:** total wall-clock for N queries
- **Why:** Persistent worker loads the model once into L1; baseline rebuilds per call.
- **Workload:** Model size matters — bigger model = bigger win. 5 000 entries shows ~1.5× speedup; 50 000 entries shows much more.
- **See:** `examples/persistent-ai-model.js`

### Async offload (`runtime.dispatch`)

- **Baseline:** `await fn()` inline on main thread
- **Metric:** HTTP handler duration (NOT worker task duration)
- **Why:** The win is HTTP responsiveness, not throughput. Inline blocks the handler for the full task duration; dispatch returns in microseconds.
- **Workload:** Any task that takes ≥ 10 ms. The win grows linearly with task duration.
- **See:** `examples/express-outbox-email.js`

### Priority routing

- **Baseline:** all tasks at `priority: 0` (FIFO queue)
- **Metric:** first-interactive completion index in completion log
- **Why:** Priority routing reorders the queue; baseline doesn't.
- **Workload:** Slow baseline tasks (≥ 50 ms each) + fast interactive tasks. Need a queue backlog for priority to cut the line.
- **Watch out:** If everything completes in < 1 ms, there's no backlog and the metric is identical between scenarios.
- **See:** `examples/priority-routing.js`

### Bounded pool (`executeAll`)

- **Baseline:** inline `await` loop on main thread
- **Metric:** `setInterval(5 ms)` tick count during the burst
- **Why:** Win is Event Loop responsiveness, not throughput. Inline blocks the loop; workers keep it free.
- **Workload:** CPU-bound tasks that take ≥ 10 ms each.
- **See:** `examples/image-resizer-batch.js`

### Adaptive concurrency controller (`concurrency: 'auto'`)

- **Baseline:** `concurrency: 'fixed', workers: 1`
- **Metric:** total wall-clock + peak `effectiveWorkers` reached
- **Why:** Adaptive grows from 1 to N under load; fixed stays at 1.
- **Workload:** 50+ tasks × 20+ ms each. The controller needs sustained ELU/p99 signal across multiple debounce ticks (default 100 ms cadence, 3-tick debounce = 300 ms before grow fires).
- **Watch out:** On a single-shot burst, the controller may not fire grow in time. Run multiple rounds OR drive a long-running workload.
- **See:** `examples/adaptive-concurrency.js`

### Cancellation (`AbortController`, `AbortSignal.timeout`)

- **Baseline:** let the same task run to completion
- **Metric:** wall-clock until worker is free (or until error throws)
- **Why:** Cancel frees the worker in ~signal-delay ms; baseline blocks for full task duration.
- **Watch out:** Default `timeoutMs: 5000` races with simulated 5 s work — pass explicit `timeoutMs` if your simulation is near 5 s.
- **See:** `examples/cancel-on-disconnect.js`

### EventTarget `{ signal }` cleanup

- **Baseline:** manual `removeEventListener` × N
- **Metric:** cleanup wall-clock + API call count
- **Why:** `abort()` is 1 call; manual cleanup is N. Wall-clock is comparable; API surface area differs 10×.
- **Watch out:** Node EventTarget has a hard limit of 10 listeners per event name. Cap `LISTENER_COUNT` at 10 in the demo.
- **See:** `examples/event-target-pattern.js`

### Worker recycling cycle

- **Baseline:** (no throughput baseline — recycling has no throughput win)
- **Metric:** per-cycle `worker:recycled.timestamp - worker:recycling.timestamp`
- **Why:** The metric IS the overhead. Honest framing: ~recycleBackoffMs grace + ~50 ms terminate.
- **Watch out:** `executeAll` resolves before recycle backoff timers fire. Wait for `EXPECTED_RECYCLES` worker:recycled events, NOT for executeAll to resolve.
- **See:** `examples/worker-recycling.js`

### Backpressure (`stream:backpressure`)

- **Baseline:** consumer faster than producer (no backpressure fires)
- **Metric:** `stream:backpressure` event counts (paused / resumed) + throughput
- **Why:** Baseline has 0 backpressure events; throttled scenario has many.
- **Workload:** Producer must outrun consumer. Use `HWM < consumer.delay × producer.rate`.
- **See:** `examples/streaming-csv-export.js`

### Streaming TTFT (`runtime.stream`)

- **Baseline:** non-streaming — `await runtime.execute(...)` returns the full result at once
- **Metric:** TTFT (time-to-first-token) + total wall-clock
- **Why:** Streaming yields chunks; non-streaming waits for completion.
- **See:** `examples/streaming-llm.js`

### BroadcastChannel cross-worker invalidation

- **Baseline:** (no obvious baseline — peer-to-peer has no main-thread round-trip)
- **Metric:** cold (source lookup) vs warm (cache hit) `avgLatencyMs` per read
- **Why:** Cache hit avoids the source-of-truth lookup; invalidate propagates to peers.
- **See:** `examples/broadcast-cache-invalidation.js`

## Pattern: when NO metric is appropriate

Some features are binary contracts where wall-clock is noise. Tag these `[correctness]`:

- `TaskAbortedError` thrown on cancellation → binary: yes/no
- `PersistentWorkerRuntimeDefaultSizing` warning fires on default sizing → binary: yes/no
- `transferList` correctly detaches the buffer → binary: yes/no
- Stream `pushError()` throws on consumer `next()` → binary: yes/no

For these, the metric is "did the contract hold". Use asserts / error catching; no wall-clock needed.

Some features are API usage patterns where the win is API ergonomics, not raw speed. Tag these `[api-surface]`:

- EventTarget observation patterns (correctness + API surface)
- Custom handler module signature
- Multi-routing via `affinityKey`

For these, the metric (if any) is "calls required" or "lines of code" — wall-clock is in the noise. Be honest about it.
