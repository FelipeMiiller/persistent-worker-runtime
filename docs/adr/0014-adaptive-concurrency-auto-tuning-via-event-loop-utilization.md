# ADR-0014: Adaptive Concurrency Auto-Tuning via Event Loop Utilization (ELU)

- **Date**: 2026-09-18 (refined; supersedes the 2026-09-16 simplified version)
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: concurrency, auto-scaling, elu, perf_hooks, adaptive-control, observability, ewma, debounce

> **Note**: This revision supersedes the original 2026-09-16 ADR-0014, which described a single-signal throttle (ELU-only with a fixed `targetElu: 0.75`). The present version captures the production-grade controller design that emerged from the spec session: **two complementary signals** (ELU + `monitorEventLoopDelay` p99), **EWMA smoothing**, **debounce window**, **explicit grow/shrink policy**, **telemetry block**, and **explicit opt-out via `concurrency: 'fixed'`**. The full requirements, edge cases, and acceptance criteria live in `.specs/features/adaptive-concurrency/spec.md` (local scratchpad).

## Context and Problem Statement

ADR-0019 reduced the **default** worker pool from `availableParallelism() - 1` to `1` to protect the Event Loop from starvation on multi-core hosts (1 GB → 40 MB baseline RSS on a 28-core machine). The trade-off was deliberate: low default, opt up. But "opt up" requires the user to **know what number to set**, which means measuring their own workload. Most users do not measure — they default and ship.

Static pool sizing is also brittle under container cgroup quotas, shared-host CPU pressure, and bursty traffic. Today there is no runtime signal that the loop is being squeezed; operators discover it via HTTP timeouts or animation jank, after the fact.

How can the runtime **dynamically resize** the worker pool within a user-supplied `[min, max]` band, using the Event Loop itself as the authoritative signal, while:

1. Preserving the ADR-0019 conservative default (floor = 1).
2. Respecting explicit user overrides (`concurrency: 'fixed'` or numeric `workers: N`).
3. Never starving the main loop (the original ADR-0001 invariant).
4. Not oscillating at signal boundaries (hysteresis / debounce).

## Decision Drivers

- **Main Event Loop responsiveness is non-negotiable** — adaptive MUST shrink under pressure, not just throttle dispatch.
- **Two signal sources, not one** — a single ELU ratio averages over the tick window and can miss short worker-tickling spikes; pairing it with a tail-latency p99 closes the gap.
- **Signal noise is real** — raw per-tick values jitter; EWMA smoothing is the minimum acceptable hygiene.
- **Heuristic must not thrash** — a debounce window (consecutive-tick counter) prevents oscillation at threshold boundaries.
- **Opt-out path must be zero-cost** — `concurrency: 'fixed'` MUST produce bitwise-identical behavior to today's static model.
- **Telemetry must be first-class** — operators cannot tune what they cannot observe; `runtime.stats.adaptive` exposes the controller state for debuggability.

## Considered Options

- **Option 1: Static concurrency (no adaptive)** — status quo of ADR-0019. Forces every user to size manually. Rejected: defeats the "low default, opt up" promise.
- **Option 2: OS load average (`os.loadavg()`)** — kernel-aggregated, OS-updated every 1-5 min. Rejected: too lagging to respond to sub-second pressure; conflates other processes with our workers.
- **Option 3: `monitorEventLoopDelay` only (event-loop lag)** — measures delay between scheduled timer executions. Better than `os.loadavg()` but only fires *after* the lag has occurred and is distorted by timer jitter. Rejected as sole signal; **kept as secondary signal** for tail-latency spikes.
- **Option 4: Dual-signal adaptive (ELU + `monitorEventLoopDelay` p99, EWMA + debounce)** — **Chosen**. Combines the ELU averaging ratio (steady-state pressure) with the delay p99 (transient spikes), smoothed to avoid oscillation.

## Decision Outcome

Chosen option: **"Option 4: Dual-signal adaptive controller"**.

### Architectural Mechanics

The adaptive controller is a supervisor-tick component that **samples, smooths, debounces, and decides** on a fixed cadence. It can issue one of three actions per tick: **grow** (spawn a worker), **shrink** (retire the lowest-load worker), or **noop**.

#### 1. Signal sources

| Signal | Source | Smoothing | Purpose |
| --- | --- | --- | --- |
| Primary | `perf_hooks.performance.eventLoopUtilization()` | EWMA α = 0.3 | Steady-state loop pressure ratio `[0, 1]` |
| Secondary | `perf_hooks.monitorEventLoopDelay({ resolution: 20 })` p99 | EWMA α = 0.3 | Tail-latency spikes (worker tickled the loop briefly) |

ELU is updated by calling `performance.eventLoopUtilization(prev)` each tick to get a delta against the previous tick; `monitorEventLoopDelay` exposes `histogram.percentile(99)` directly.

#### 2. Tick cadence and overhead budget

- **Cadence**: 100 ms per supervisor tick (10 Hz).
- **Per-tick overhead budget**: < 1 ms (sample two metrics, two EWMA updates, two debounce increments, one branchy decision). At 10 Hz × 0.5 ms ≈ 0.5 % main-thread CPU.
- The tick piggybacks on the existing supervisor heartbeat — no new timer.

#### 3. Threshold + debounce policy

| Action | Trigger | Cooldown |
| --- | --- | --- |
| **Shrink** | `ELU_EWMA > 0.85` OR `latency.p99 > 50 ms` | 5 consecutive ticks (~500 ms) |
| **Grow** | `ELU_EWMA < 0.5` AND `latency.p99 < 10 ms` AND `queue has pending tasks` | 5 consecutive ticks (~500 ms) |
| **Noop** | Anything else, or debounce not yet satisfied, or pool at boundary | — |

The debounce counter **resets** if the signal crosses back to the opposite side within the 5-tick window. This is the standard exponential half-life ~250-350 ms smoothing pattern from control-systems literature (same scale as TCP retransmit timeout ~500 ms).

#### 4. Resize actions

- **Grow**: spawn a new worker (idle until first task dispatched), then `effectiveWorkers++`. Total capacity never dips below the previous size; the new worker is added before any worker is retired.
- **Shrink**: pick the worker with the **lowest current load** (least recently used), mark it `draining`, wait for the in-flight task to **complete naturally** (no `worker.terminate()` — that would break streams and L1 state), then retire → `effectiveWorkers--`.
- **In-flight streams** on a draining worker are unaffected: the streaming protocol's existing `MSG_STREAM_ABORT` cleanup runs only when the consumer breaks, not on worker retirement.

#### 5. Pool band and opt-out

- **Default band**: `[1, maxWorkers]` if user set `maxWorkers`; `[1, os.availableParallelism() - 1]` otherwise (matches the ADR-0019 legacy cap).
- **Opt-out**: `createWorkerRuntime({ concurrency: 'fixed', workers: N })` disables adaptive entirely. The controller still samples for telemetry (operators can debug why their fixed pool is starving) but never fires a resize.
- **Explicit numeric `workers: N`** is treated the same as `concurrency: 'fixed'` — numeric is unambiguous and we honor user intent.
- **Validation**: `minWorkers < 1` throws `RangeError`; `minWorkers > maxWorkers` throws `RangeError`.

#### 6. Telemetry

A new block on `runtime.stats`:

```js
runtime.stats.adaptive = {
  enabled: boolean,              // false if concurrency: 'fixed'
  elu: number | null,            // EWMA-smoothed ELU [0,1]; null if disabled
  latencyP99Ms: number | null,   // EWMA-smoothed p99 (ms); null if disabled
  effectiveWorkers: number,      // current pool size (post-resize)
  ticksSinceResize: number,      // 0 right after a resize
  lastResizeReason: 'grow' | 'shrink' | null,
  lastResizeAt: number | null    // performance.now() ms
};
```

The shape mirrors existing `runtime.stats` blocks (counters, timestamps, reason enums) — no breaking change to other fields.

#### 7. Integration with ADR-0019

The floor of the band is `1` by default. Adaptive grows **up to** `maxWorkers` (or `cores - 1`), never beyond. Users who accept the ADR-0019 default of `workers: 1` get a runtime that starts at 1 and grows only when safe — preserving the conservative intent while letting throughput recover when the loop has headroom. Users who opt up explicitly (`workers: 8`) get either fixed-size behavior (`concurrency: 'fixed'`) or bounded adaptive (`concurrency: 'adaptive'`).

### Positive Consequences

- **Default users get auto-tuning for free** — they keep the ADR-0019 low-memory baseline and recover throughput automatically when the loop is idle.
- **Container / cgroup parity** — adaptive responds to actual Event Loop pressure (which matches cgroup-imposed CPU throttling automatically) instead of pretending the host has 28 cores.
- **Two-signal robustness** — ELU catches steady-state pressure; p99 catches transient spikes where a worker briefly monopolized the loop. Either alone is incomplete.
- **EWMA + debounce** — proven stability pattern from control systems; no oscillation at thresholds, no over-reaction to single-tick spikes.
- **Zero API surface growth for opt-out** — `concurrency: 'fixed'` is an additional option value; existing callers unaffected.
- **Observability** — `runtime.stats.adaptive` lets operators correlate throughput regressions with the actual signal state.
- **Backwards compatible** — apps that pass `workers: N` or `concurrency: 'fixed'` get exactly today's behavior.

### Negative Consequences

- **Sampling overhead** — ~0.5 % main-thread CPU at 10 Hz with both signals. Negligible in practice but visible on `process.cpuUsage()` if measured.
- **Grow response time** — ~500 ms (debounce window) + worker spawn (~20-100 ms for V8 init). Bursts that resolve within 500 ms will not trigger a grow that would have helped.
- **Shrink is conservative** — drains the lowest-load worker (waits for in-flight task). A pathological 10-minute task blocks shrink for 10 minutes; mitigation is the existing preemption watchdog (ADR-0011 `forceKillOnTimeout: true`).
- **Decision complexity** — operators now have one more knob (`concurrency: 'fixed' | 'adaptive'`) plus `min` / `max` band. Default is sensible but the knob is exposed.
- **Telemetry writes every tick** — `runtime.stats.adaptive` is updated on every supervisor tick (10 Hz); cheap but not free. Negligible compared to the IPC cost of the existing stats path.

## Pros and Cons of the Options

### Option 4 ✅ Chosen

- ✅ Two complementary signals cover steady-state + transient pressure.
- ✅ EWMA + debounce prevent oscillation.
- ✅ Grow AND shrink (Option 3 was throttle-only — never restored throughput after recovery).
- ✅ Respects ADR-0019 conservative floor; respects explicit user overrides.
- ✅ First-class telemetry.
- ❌ ~0.5 % main-thread overhead at 10 Hz.
- ❌ ~500 ms response time to sustained signal changes.

### Option 1 (static)

- ✅ Zero overhead.
- ✅ Bitwise-identical behavior — no surprises.
- ❌ Forces every user to size manually; defeats the ADR-0019 "low default, opt up" promise.

### Option 2 (`os.loadavg()`)

- ✅ Already in Node stdlib.
- ❌ 1-5 minute lag — useless for sub-second pressure.
- ❌ Conflates our workers with other host processes.

### Option 3 (`monitorEventLoopDelay` only)

- ✅ Catches tail latency directly.
- ❌ Triggers only *after* lag has occurred (no leading indicator).
- ❌ Single signal misses steady-state pressure.
- ✅ Still useful — kept as secondary signal in Option 4.

## Verification

- **Unit tests** (`test/adaptive-controller.test.js`):
  - EWMA correctness for α = 0.3.
  - Debounce counter increments / resets / fires correctly.
  - Resize decision matrix (every signal combination → expected action).
  - Opt-out detection (`concurrency: 'fixed'` and explicit numeric `workers: N`).
  - Telemetry shape (all 7 fields, correct types, nulls when disabled).
- **Integration tests** (`test/adaptive-concurrency-runtime.test.js`):
  - P1: Boot with `workers: 1`, push idle-loop workload, verify `effectiveWorkers` grows toward `maxWorkers` within debounce + spawn budget.
  - P2: Boot with `workers: 4`, simulate main-loop pressure, verify `effectiveWorkers` shrinks toward `minWorkers` and main-thread ELU recovers.
  - P3: `concurrency: 'fixed'` mode produces identical dispatch behavior to today's static model (regression via existing test suite — no new test required).
  - P5: `runtime.stats.adaptive` reflects grow + shrink events with correct `lastResizeReason` and `lastResizeAt`.
- **Benchmark** (`benchmarks/adaptive-concurrency.benchmark.js`):
  - Phase A: synthetic ELU pressure → expect shrink + main-thread ELU recovery.
  - Phase B: synthetic ELU idle + queue pressure → expect grow.
  - Phase C: opt-out mode → verify no resize under same conditions.
  - Phase D: `runtime.stats.adaptive` populated.
  - Asserts supervisor tick overhead `< 1ms`.
- **Full suite**: `npm run validate` → 0 lint, 100 % existing tests pass.

## Follow-ups (deferred to a future chat / spec)

1. **Per-task EWMA history** — emit `adaptive.eluHistory` / `latencyHistory` rolling buffer (last N samples) for trend visualization.
2. **Adaptive `maxOldGenerationSizeMb`** — when user passes `resourceLimits`, scale `maxOldGenerationSizeMb` down proportionally to `effectiveWorkers` (each worker should get a smaller heap as the pool grows, holding total pool memory constant).
3. **Adaptive streaming `highWaterMark`** — when the queue is starving workers, auto-grow the per-stream queue to reduce pause/resume churn. Separate concern but same controller architecture.
4. **Cross-runtime pool federation** — coordinate adaptive sizing across multiple `WorkerRuntime` instances in the same process. Deferred; out of scope per the project mission (single-process runtime).

## Links

- **Spec**: `.specs/features/adaptive-concurrency/spec.md` (local, gitignored) — full 5 user stories, 20 requirements (ADAPTIVE-01..20), edge cases, success criteria.
- **Tasks**: `.specs/features/adaptive-concurrency/tasks.md` (local, gitignored) — implementation breakdown into 12 tasks across 6 phases.
- **Related ADRs**:
  - [ADR-0001](0001-persistent-worker-runtime-over-worker-threads.md) — original "Event Loop coordinates. Persistent Workers execute." invariant.
  - [ADR-0009](0009-elastic-worker-pool-auto-scaling.md) — dynamic sizing API (`min`, `max`, `idleTimeoutMs`); this ADR adds the adaptive *driver* on top.
  - [ADR-0011](0011-hard-preemption-and-timeout-termination-for-runaway-tasks.md) — `forceKillOnTimeout` is the safety net for the "drain naturally" shrink path.
  - [ADR-0019](0019-default-workers-reduced-from-availableparallelism-to-1.md) — sets the conservative default this ADR auto-grows from.
- **Node references**:
  - [`perf_hooks.performance.eventLoopUtilization()`](https://nodejs.org/api/perf_hooks.html#performanceeventlooputilization) — the primary signal.
  - [`perf_hooks.monitorEventLoopDelay()`](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitorEventLoopDelay) — the secondary signal source.
- **Methodology references**:
  - TCP retransmit timeout (~500 ms) — same scale as our debounce window.
  - Prometheus / Grafana load-balancer EWMA conventions — α = 0.2-0.3 is standard.
