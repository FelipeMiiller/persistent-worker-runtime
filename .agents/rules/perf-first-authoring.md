---
title: "Perf-First Authoring (examples + tests + benchmarks)"
category: rule
summary: "Any artifact that motivates a runtime feature — example, perf-test, benchmark — must DEMONSTRATE the performance win with a measurable number. Showing that the API runs is insufficient."
---

# Perf-First Authoring

The runtime exists because it improves performance on the Event Loop, IPC, and worker-heap dimensions. **An example, test, or benchmark that does not show the improvement does not justify the feature.** Authoring work in this project that touches a perf-relevant feature must make the win visible.

This rule fires on every one of these:

1. Adding a new `examples/*.js` file.
2. Adding a new `benchmarks/*.js` file.
3. Adding a test for a perf-relevant API (zero-copy, streaming, priority routing, recycling, broadcasting, adaptive concurrency, `executeAll`, etc.).
4. Writing a tutorial / README section that motivates a perf feature.

**Companion skill:** `.agents/skills/pwr-examples/SKILL.md` covers the **how** (header tag taxonomy, anatomy template, perf-metric table, common pitfalls). This rule covers the **why**. Load both when creating an example.

## Three contexts, one rule

### 1. Examples (`examples/*.js`)

Every example must end with a measurable output that quantifies the win in **units the user cares about**:

| Pattern                | Required metric(s)                                                              |
| ---------------------- | ------------------------------------------------------------------------------ |
| Zero-copy transfer     | wall-clock time + `byteLength === 0` post-transfer (transfer semantics)        |
| State / L1 cache       | first-access ("cache miss") vs subsequent ("cache hit") latency in ms          |
| Persistent worker      | cold vs warm task latency (the saving when reusing L1 state)                  |
| Outbox / async dispatch | HTTP path duration + worker-side task duration (proves the fast-path is fast) |
| Priority routing       | first-interactive completion index vs first-batch index (proves the cut-line) |
| Streaming              | TTFT + total stream time + throughput (rows/sec, tokens/sec, MB/sec)           |
| Backpressure           | `paused` + `resumed` event counts + throughput (proves the consumer isn't the bottleneck) |
| Recycle lifecycle      | recycled count vs total task count (proves recycling actually engages)         |
| EventTarget observation | memory/perf gain over `events.on()` if comparing; otherwise OK to skip metric |
| BroadcastChannel       | per-receive latency or fan-out cost vs same-thread equivalent                  |

**Examples that only show "the API runs" without measuring its benefit are not allowed unless explicitly marked as `[correctness]` in the header.** Correctness demos (Abortion, TypeError paths, lifecycle guards) are exempt from the metric requirement.

### 2. Tests (`test/*.test.js`)

Tests for a perf-relevant behavior must assert **the win**, not just **"doesn't break"**:

- ✅ `expectedLatencyMs < 100` when L1 cache hits
- ✅ `expectedQueueLength === 0` after consumer catch-up (backpressure recovered)
- ✅ `expectedSpeedupRatio > 1.5×` vs unstructured alternative
- ❌ `assert.equal(typeof transferList, 'object')` (just type, no win)

If the perf claim is hard to test (e.g. Event Loop lag reduction), write the **invariant** the perf claim depends on (e.g. "the main thread must remain responsive while the worker is busy") — assert the invariant, not the absolute number.

### 3. Benchmarks (`benchmarks/*.js`)

Every benchmark must compare to a baseline:

- ✅ Same workload, two configurations (with/without optimization).
- ✅ Workload that exercises the feature's bottleneck (not a trivial loop).
- ✅ Output that reports `speedup` or `delta` in the user's units (ms saved, ops/sec gained, MB transferred cheaply).
- ❌ Single-shot timing with no baseline (no way to know if it's fast).

Existing benchmarks already follow this — see `benchmarks/stateful-vs-stateless.benchmark.js`, `benchmarks/cpu-saturation.benchmark.js`. New benchmarks must follow the same shape.

## Required metric format

When printing a perf number, include the **delta vs baseline** explicitly:

```text
// ✅ good
Elapsed (sequential):  1.42s
Elapsed (parallel):    0.18s
Speedup:               7.9×

// ❌ bad
Elapsed: 0.18s   ← against what? on what hardware? with what workload?
```

Use `console.table` for side-by-side comparisons; humans spot the ratio faster.

## Anti-patterns (mark for upgrade or delete)

The following examples currently lack the perf-first metric and need either an upgrade or to be marked `[correctness]`:

| Example                          | Missing                                    | Action                                                  |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `adaptive-concurrency.js`        | no before/after, no load to fire controller | mark `[correctness]` AND add `benchmarks/adaptive-controller-tick` reference |
| `broadcast-cache-invalidation.js`| no wall-clock for cache hit vs miss        | add `console.time` around cold/warm fetch               |
| `cancel-on-disconnect.js`        | (none — pure correctness demo)              | mark header `[correctness]`                             |
| `event-target-pattern.js`        | no perf vs `events.on()`                    | mark header `[api-surface]`                             |
| `express-outbox-email.js`        | `httpDuration` printed but no worker cost vs same-task-on-event-loop | compare to a sequential `await fn(...)` baseline       |
| `image-resizer-batch.js`         | no throughput number                       | add rows/sec + p99                                      |
| `persistent-ai-model.js`         | cold vs warm latency unmarked               | wrap each query with `performance.now()` and report cold/warm split |
| `priority-routing.js`           | no wall-clock vs sequential baseline        | add a "no priority" baseline run for delta              |
| `streaming-csv-export.js`        | ✅ already has throughput + backpressure    | (good)                                                  |
| `streaming-llm.js`              | TTFT ✅ but no vs-non-streaming comparison  | add a "buffered await" baseline                         |
| `worker-recycling.js`            | no task throughput before/after recycle    | add per-window throughput comparison                    |
| `zero-copy-image.js`             | has pixel throughput but no vs-copy baseline| add a "structured-clone copy" baseline                  |

## Quick checklist — paste into PR description

```text
Perf-first rule (`.agents/rules/perf-first-authoring.md`):
- [ ] Example / benchmark / perf-test demonstrates the perf win with a measurable number
- [ ] Number is in user units (ms saved, ops/sec, MB transferred cheaply), not micro-benchmark noise
- [ ] Baseline present (sequential, with-copy, no-priority, no-cache, etc.) OR explicitly marked `[correctness]` / `[api-surface]`
- [ ] Hardware / config notes attached (concurrency=auto? workers=4? HWM=8?) so results are comparable
```

## When the rule conflicts with "just show the API runs"

It doesn't. Showing the API runs is the **floor**. The rule raises the floor to "showing the API runs AND runs better than the alternative". Both are cheap to write; only the second justifies the feature.

If a feature genuinely has no measurable performance win (rare), mark the example header `[correctness]` and document why in the spec's `completion-checklist.md`. Honesty about a feature's lack of perf claim is acceptable; silence about it is not.
