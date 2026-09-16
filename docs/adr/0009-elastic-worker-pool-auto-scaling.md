# ADR-0009: Elastic Worker Pool Auto-Scaling with Min/Max Bounds and Idle Timeout

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: architecture, elasticity, resource-management, pool

## Context and Problem Statement

Applications experience variable workloads throughout the day. Fixed-size worker pools either over-provision threads during idle hours (wasting RAM, as each V8 Isolate consumes ~30MB), or under-provision during peak traffic bursts (causing queue buildup and timeouts). How can the Persistent Worker Runtime adjust thread counts dynamically based on real-time demand?

## Decision Drivers

- Minimum resource consumption during quiet periods.
- Rapid elastic scale-up during traffic bursts.
- Bounded maximum capacity to prevent host CPU exhaustion.
- Graceful scale-down of idle surplus workers.

## Considered Options

- **Option 1: Static Fixed Pool Size (`workers: N`)**
- **Option 2: Spawn new worker per task** (High latency, no persistence)
- **Option 3: Elastic Bounded Auto-Scaling (`minWorkers`, `maxWorkers`, `idleTimeoutMs`)**

## Decision Outcome

Chosen option: **"Option 3: Elastic Bounded Auto-Scaling"**, where the Supervisor maintains a baseline of `minWorkers` (e.g. 2). When the task queue builds up and all active workers are busy, the Supervisor dynamically spawns replacement workers up to `maxWorkers` (e.g. 8). If a surplus worker remains idle longer than `idleTimeoutMs` (e.g. 15s), it is gracefully terminated down to `minWorkers`.

### Configuration:
```javascript
const runtime = await createWorkerRuntime({
  minWorkers: 2,
  maxWorkers: 8,
  idleTimeoutMs: 15000,
});
```

### Positive Consequences

- Low memory footprint during off-peak periods.
- Automatic capacity expansion during peak traffic bursts.
- Controlled maximum concurrency protects the server from thrashing.

### Negative Consequences

- The first burst task that triggers worker spawning incurs worker initialization latency (~20ms).
