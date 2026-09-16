# ADR-0014: Adaptive Concurrency Auto-Tuning via Event Loop Utilization (ELU)

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: concurrency, auto-scaling, elu, perf_hooks, adaptive-control

## Context and Problem Statement

Static worker pool sizing (such as fixing `poolSize: os.availableParallelism()` or `poolSize: 4`) assumes dedicated CPU availability, static system workloads, and isolated execution. In production microservices, containerized platforms (Docker, Kubernetes, AWS ECS), or serverless environments, CPU resources are frequently constrained by cgroup quotas (e.g. `cpu.cfs_quota_us`) or shared with concurrent processes.

Under heavy traffic, if worker threads aggressively consume all available CPU cores with background tasks while the main thread simultaneously receives a surge of HTTP/WebSocket I/O requests, the main Event Loop suffers starvation. HTTP request latencies skyrocket, health checks fail, and services become unresponsive.

Naive metrics like OS load average (`os.loadavg()`) or overall CPU percentage are lagging, noisy, and cannot detect whether the Node.js Event Loop itself is saturated. How can the runtime dynamically tune task concurrency to maximize throughput while guaranteeing that the main Event Loop remains responsive?

## Decision Drivers

- Must protect the main Event Loop from starvation to maintain ultra-low HTTP/RPC I/O latency under all load conditions.
- Must dynamically throttle or expand task concurrency based on actual runtime saturation rather than static core counts.
- Must leverage native Node.js metrics without introducing external APM agents or native addons.
- Must provide smooth backpressure damping (hysteresis) to prevent pool oscillation and thrashing during bursty traffic.

## Considered Options

- **Option 1: Static Concurrency (Fixed Pool Size)**: Sizing determined once at startup. Cannot adapt to runtime load shifts or CPU throttling.
- **Option 2: OS Load Average (`os.loadavg()`)**: Only updated every 1 to 5 minutes by the OS kernel; far too slow to respond to sub-second latency spikes.
- **Option 3: Event Loop Delay Tracking (`monitorEventLoopDelay`)**: Measures the delay between scheduled timer executions. Useful, but only triggers *after* delay has already occurred and is distorted by timer resolution.
- **Option 4: Adaptive Concurrency via Event Loop Utilization (ELU)**: Continuously sample `performance.eventLoopUtilization()` (ELU) to measure the exact ratio of time the Event Loop spends active vs. idle.

## Decision Outcome

Chosen option: **"Option 4: Adaptive Concurrency via Event Loop Utilization (ELU)"**, because ELU is a non-lagging, mathematically precise metric ($0.0 \dots 1.0$) provided directly by Node.js core that measures the true capacity of the Event Loop without timer jitter.

### Architectural Mechanics

1. **Native ELU Sampling**:
   - The runtime uses `perf_hooks.performance.eventLoopUtilization()` to measure main-thread saturation over rolling intervals (e.g., every 250ms):
     ```js
     const currentElu = performance.eventLoopUtilization(previousEluSample);
     ```
   - ELU represents the exact percentage of wall-clock time the libuv loop was actively processing callbacks and executing JavaScript.
2. **Adaptive Concurrency Throttle**:
   - Configuration parameters:
     - `adaptiveConcurrency: true` (opt-in or enabled when scaling policy is `'adaptive'`).
     - `targetElu: 0.75` (safety headroom: ensure main thread remains $\le 75\%$ utilized).
     - `minWorkers`, `maxWorkers`: Elastic bounds for pool expansion and contraction.
3. **Control Loop Policy**:
   - **Main Loop Under Stress (ELU > targetElu)**:
     - The runtime pauses worker thread expansion and throttles task dispatch from the priority queue.
     - Active workers finish current tasks, but queue dispatch is damped until ELU normalizes.
     - Preserves 100% of remaining CPU headroom for main-thread HTTP/TLS/socket handling.
   - **Main Loop Healthy & Queue Backlogged (ELU $\le$ targetElu & Queue Depth > 0)**:
     - The runtime dynamically scales worker concurrency up to `maxWorkers` and drains tasks at maximum parallelism.
   - **System Idle (ELU low, Queue Empty)**:
     - Workers idle and scale down toward `minWorkers` based on idle timeout rules (per ADR-0009).

### Positive Consequences

- Prevents HTTP/gRPC request latency spikes during background CPU spikes.
- Functions accurately inside Docker/Kubernetes containers with CPU quotas where core counts are misleading.
- Extremely low runtime overhead (a single lightweight C++ call per sampling interval).
- Provides an automated, self-balancing engine suitable for production workloads without manual tuning.

### Negative Consequences

- Requires tuning damping intervals to avoid excessive throttle fluttering on millisecond micro-bursts.
- Background tasks may experience temporary queuing delays during peak incoming HTTP traffic (which is precisely the desired operational trade-off to protect SLAs).
