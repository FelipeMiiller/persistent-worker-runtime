---
name: pwr-examples
description: Author `examples/*.js` for persistent-worker-runtime that prove the runtime works AND measure the performance win. Use when creating a new demo, refactoring an existing one to add a metric, picking the right header tag, or deciding which perf metric applies to a given feature. Triggers on "create example", "add demo", "new example", "perf-tested example", "tag example", "[correctness]/[perf-tested]/[api-surface]", "what metric for X", "example for feature". Always-on companion rule: `.agents/rules/perf-first-authoring.md` — examples MUST demonstrate the perf win with a measurable number OR be explicitly tagged `[correctness]` / `[api-surface]` with a rationale paragraph.
license: MIT
metadata:
  author: Felipe Miiller
  version: 1.0.0
  applies-to: persistent-worker-runtime
---

# pwr-examples — Authoring Examples for Persistent Worker Runtime

Examples are the **first thing a new user runs**. If `node examples/<feature>.js` doesn't end with a printed number that justifies why this feature exists, the user leaves. This skill covers the four decisions every example author makes:

1. **Which header tag** — `[perf-tested]` / `[correctness]` / `[api-surface]`.
2. **Which perf metric** — what's measurable for this feature.
3. **What the comparison is** — vs what baseline (sequential, copy, no-priority, no-cache, etc.).
4. **What pitfalls to dodge** — closure transport, default `timeoutMs`, MaxListenersExceededWarning.

Companion rule: `.agents/rules/perf-first-authoring.md`. Examples must show the win.

## When to load this skill

- Adding a new `examples/*.js` file.
- Refactoring an existing example to add a missing perf metric (an audit found a `[correctness]` example where a metric IS measurable).
- Picking a header tag for an example whose perf claim is unclear.
- Deciding what side-by-side baseline to run against a new feature.
- Reviewing a PR that touches `examples/`.

## The 4 mandatory commands after creating/modifying an example

```bash
npm run lint                          # biome must pass — examples/ is linted
node examples/<new-or-edited>.js     # must exit 0 and print the metric
```

`npm test` does not run examples (they're demos, not tests). If you touched `src/`, run the full pipeline:

```bash
npm run validate                      # lint + test (husky pre-push runs this)
```

Do **not** commit if lint fails. Do **not** claim "works on my machine" without running on Windows + Linux + macOS — at least one of those is your CI matrix.

## The 3 header tags (taxonomy)

Every example MUST be tagged with exactly one of these, as the first content of the JSDoc block:

| Tag | When | Metric required? |
| --- | --- | --- |
| `[perf-tested]` | The example demonstrates a runtime feature that improves throughput / latency / Event-Loop responsiveness | **YES** — `console.table` or equivalent side-by-side at the end |
| `[correctness]` | The example proves a runtime contract (cancellation, error type, lifecycle guard, sizing shape) where no perf claim applies | NO — but the rationale paragraph must explain why |
| `[api-surface]` | The example shows how to use a feature (EventTarget patterns, custom handler signature, multi-routing) without a perf claim | NO — but the rationale paragraph must explain why |

Examples in the current inventory as of 2026-09-24: see **[references/inventory.md](references/inventory.md)** — kept in sync by re-running `ls examples/*.js` and updating tags whenever an example changes scope.

## The 5 always-apply patterns for example structure

### 1. JSDoc header — first line is the tag

```js
/**
 * [perf-tested] Example: <feature name>.
 *
 * Demonstrates <what> AND quantifies the win against <baseline>.
 *
 * Use cases:
 *   - <bullet 1>
 *   - <bullet 2>
 *
 * What this example measures:
 *   - <metric 1> (units)
 *   - <metric 2> (units)
 *
 * Run: `node examples/<file>.js`
 */
```

If the example is `[correctness]` or `[api-surface]`, add a "Why [tag]:" paragraph at the end of the JSDoc explaining why no metric applies (workload too small to drive the controller, the property is binary, etc.).

### 2. Configuration block — top-of-file constants

```js
// === Configuration ===
const TASK_COUNT = 50;
const PER_TASK_MS = 20;
// ...
```

Use `UPPER_SNAKE_CASE`. Comments explain any non-obvious choice (why `workers: 2`, why `concurrency: 'auto'` vs `'fixed'`). Configuration drives the workload — changing it should make the metric obvious.

### 3. Worker fn closure rule (ADR-0012)

**Worker fns are serialized via `new Function(fnCode)` — closures from the main module are NOT transported.** Constants from the configuration block cannot be referenced by name inside a worker fn.

Two options:

```js
// Option A: inline the constant into the fn body (simplest)
fn: () => new Promise((resolve) => setTimeout(resolve, 20)),  // PER_TASK_MS inlined

// Option B: pass via payload (cleaner for many constants)
runtime.execute({
  payload: { delayMs: 20 },
  fn: ({ delayMs }) => new Promise((resolve) => setTimeout(resolve, delayMs)),
})
```

Option B scales better. Use A only when there's literally one constant. If you reference a main-module constant by name inside a worker fn, you get `ReferenceError: X is not defined` at runtime — and the error message doesn't surface in your code, so check by reading the diff.

### 4. Side-by-side metric print — `console.table`

The metric MUST end with a `console.table` that compares the scenarios. Single-number prints are acceptable only when there's literally one configuration.

```js
console.table({
  'A. With optimization': { elapsedMs: autoMs.toFixed(2), ... },
  'B. Without (baseline)': { elapsedMs: fixedMs.toFixed(2), ... },
});

const speedup = fixedMs / Math.max(autoMs, 0.001);
console.log(`Speedup: ${speedup.toFixed(2)}× faster with the runtime.`);
```

The speedup / ratio line is mandatory — it forces the reader to read both numbers, not pick a winner from the table alone.

### 5. Error handler — `main().catch(...)` at bottom

```js
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Examples that throw an uncaught rejection pollute the CI log and look broken. Don't rely on `process.on('unhandledRejection')` — explicit is better.

## The metric matrix — which metric for which pattern

| Runtime feature | Baseline | Metric | Notes |
| --- | --- | --- | --- |
| `transferList` (zero-copy) | omit `transferList` (structured-clone copy) | `elapsedMs` per scenario, sender `byteLength` post-call | Use a buffer ≥ 1 MB or the difference is noise |
| `state` / L1 cache | rebuild model inside fn body every call | total wall-clock for N queries | Model size matters — small model = small win |
| `runtime.dispatch` (async offload) | `await fn()` inline on main thread | HTTP handler duration (NOT worker task duration) | The win is HTTP responsiveness, not throughput |
| `priority` | all tasks at `priority: 0` | first-interactive completion index in completion log | Use slow batch + fast interactive to create queue backlog |
| `executeAll` (bounded pool) | inline await loop on main thread | setInterval tick count during burst | Win is Event Loop responsiveness, not throughput |
| `concurrency: 'auto'` | `concurrency: 'fixed', workers: 1` | total wall-clock + peak `effectiveWorkers` | The adaptive controller should grow the pool under load |
| `AbortController` cancel | run task to completion | wall-clock until worker is free | Worker freed in ~100 ms vs ~5000 ms |
| EventTarget `{ signal }` | manual `removeEventListener × N` | cleanupMs + apiCalls | Wall-clock is comparable; the metric is API surface area |
| `worker:recycling` cycle | (no baseline — recycling has no throughput win) | per-cycle `worker:recycled.timestamp - worker:recycling.timestamp` | The metric IS the overhead; honest framing |
| Backpressure (`stream:backpressure`) | consumer faster than producer | paused/resumed event counts + throughput | Producer must outrun consumer for backpressure to fire |
| BroadcastChannel invalidation | (no baseline — peer-to-peer has no main-thread round-trip) | cold (source lookup) vs warm (cache hit) `avgLatencyMs` per read | Cache hit latency is the win |

Full table with worked examples: **[references/perf-metric-table.md](references/perf-metric-table.md)**.

## Common pitfalls (each has cost me a CI run before)

### 1. Closure not transported to worker

Symptom: `ReferenceError: X is not defined` at runtime, inside the worker fn.
Cause: Worker fn is compiled via `new Function(fnCode)` — main-module scope is gone.
Fix: Either inline the constant, or pass it via `payload`.

### 2. Default `timeoutMs: 5000` racing with simulated work

Symptom: `TaskTimeoutError` for a 5 s task that was supposed to complete.
Cause: HARDEN-01 default is 5000 ms — your simulated 5000 ms task races with it.
Fix: Pass `timeoutMs: 10000` (or higher than your simulated work).

### 3. `MaxListenersExceededWarning` from EventTarget

Symptom: Warning floods stdout when registering > 10 listeners on one event.
Cause: Node's EventTarget hard limit is 10 per event name; no public API to raise it.
Fix: Cap listener count at 10 in the example, or distribute listeners across multiple event names. Don't use `process.setMaxListeners` — it doesn't apply to EventTarget.

### 4. `priority` test with no queue backlog

Symptom: `firstInteractiveIdx = 0` for both with-priority and without-priority scenarios.
Cause: All tasks complete too fast — there's no queue for priority to reorder.
Fix: Make the baseline tasks slow (50 ms each) so they actually queue behind the fast interactive tasks. The metric only works when there's contention.

### 5. `executeAll` doesn't trigger the controller

Symptom: Adaptive controller shows `effectiveWorkers = 1` after a 50-task burst.
Cause: EWMA needs sustained signal across multiple ticks (debounce). One burst isn't enough.
Fix: Either run the burst in a sustained loop (e.g. 5 rounds of 50 tasks) OR reference `benchmarks/adaptive-controller-tick.benchmark.js` for the focused measurement.

### 6. `getWorkers()` shows nothing in 'recycling' status

Symptom: `capturedStatus = null` — never observed the recycled worker.
Cause: `setInterval(50)` may miss the ~200 ms backoff window if the worker terminates quickly.
Fix: Set interval to 5–10 ms for the sampler, or capture the snapshot inside the `worker:recycling` event handler (status is 'recycling' at event time).

## Anatomy template — copy-paste skeleton

```js
/**
 * [perf-tested] Example: <feature>.
 *
 * Demonstrates <what> AND quantifies the win against <baseline>.
 *
 * Use cases:
 *   - <bullet 1>
 *   - <bullet 2>
 *
 * What this example measures:
 *   - <metric 1>
 *   - <metric 2>
 *
 * Run: `node examples/<file>.js`
 */

import { createWorkerRuntime } from '../src/index.js';

// === Configuration ===

const TASK_COUNT = 50;
const PER_TASK_MS = 20;

/** Worker fn — keep small, inline constants, no closure references. */
const workFn = () =>
  new Promise((resolve) => setTimeout(resolve, PER_TASK_MS_INLINED));

async function scenarioA() { /* ... */ }
async function scenarioB() { /* baseline */ }

async function main() {
  console.log(`--- EXAMPLE: <feature> ---\n`);
  console.log(`Workload: <description>.\n`);

  const aMs = await scenarioA();
  const bMs = await scenarioB();

  console.log('\n=== Results ===\n');
  console.table({
    'A. With optimization': { elapsedMs: aMs.toFixed(2) },
    'B. Without (baseline)': { elapsedMs: bMs.toFixed(2) },
  });

  const speedup = bMs / Math.max(aMs, 0.001);
  console.log(`\nSpeedup: ${speedup.toFixed(2)}× — <one-line take-away>.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Full skeleton with header tag, configuration block, side-by-side metric, take-away line: **[references/anatomy-template.md](references/anatomy-template.md)**.

## References

- **[`.agents/rules/perf-first-authoring.md`](../../../rules/perf-first-authoring.md)** — the always-on rule this skill extends. Read first.
- **[references/perf-metric-table.md](references/perf-metric-table.md)** — full matrix of metric × feature × baseline.
- **[references/anatomy-template.md](references/anatomy-template.md)** — copy-paste skeleton with header tag, configuration block, side-by-side metric.
- **[references/inventory.md](references/inventory.md)** — current `examples/*.js` with their header tag, last-update, and metric.

## Adding new pitfalls

When a new pitfall costs a CI run, a debug session, or a wrong metric in a PR:

1. **Write the fix** in the example.
2. **Add the pitfall entry** to this skill's "Common pitfalls" section with: symptom, root cause, fix pattern, citation (commit hash, PR #).
3. **Update `references/inventory.md`** if the affected example changed scope.

The catalog grows by 1 entry per real-world bug caught. Resist the urge to add speculative pitfalls — wait for empirical evidence.
