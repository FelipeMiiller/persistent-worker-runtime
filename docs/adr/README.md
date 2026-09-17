# Architecture Decision Records (ADRs)

This directory contains the formal Architecture Decision Records for the **Persistent Worker Runtime** project, documented using the MADR (Markdown Architectural Decision Records) format.

| ADR | Title | Status | Date |
| :--- | :--- | :--- | :--- |
| **[ADR-0001](0001-persistent-worker-runtime-over-worker-threads.md)** | Persistent Worker Runtime Over worker_threads | Accepted | 2026-09-16 |
| **[ADR-0002](0002-three-tier-memory-architecture.md)** | Three-Tier Memory Architecture (L1 / L2 / L3) | Accepted | 2026-09-16 |
| **[ADR-0003](0003-dual-execution-model-execute-and-dispatch.md)** | Dual Execution Model (execute vs. dispatch) and Transactional Outbox Support | Accepted | 2026-09-16 |
| **[ADR-0004](0004-asynchronous-queue-backpressure-with-timeout.md)** | Asynchronous Queue Backpressure with Timeout and AsyncResource | Accepted | 2026-09-16 |
| **[ADR-0005](0005-native-javascript-esm-with-zero-external-dependencies.md)** | Pure Modern JavaScript (ESM, Node.js >= 24) with Zero External Dependencies | Accepted | 2026-09-16 |
| **[ADR-0006](0006-bounded-concurrency-batch-processing.md)** | Bounded Concurrency Batch Processing (executeAll & dispatchAll) | Accepted | 2026-09-16 |
| **[ADR-0007](0007-automatic-retry-policies-with-exponential-backoff.md)** | Automatic Retry Policies with Exponential Backoff for Background Tasks | Accepted | 2026-09-16 |
| **[ADR-0008](0008-zero-copy-binary-data-transfer-via-transferable-objects.md)** | Zero-Copy Binary Data Transfer via Transferable Objects | Accepted | 2026-09-16 |
| **[ADR-0009](0009-elastic-worker-pool-auto-scaling.md)** | Elastic Worker Pool Auto-Scaling with Min/Max Bounds and Idle Timeout | Accepted | 2026-09-16 |
| **[ADR-0010](0010-automatic-worker-recycling-anti-memory-leak.md)** | Automatic Worker Recycling and Heap Rejuvenation | Accepted | 2026-09-16 |
| **[ADR-0011](0011-hard-preemption-and-timeout-termination-for-runaway-tasks.md)** | Hard Preemption and Thread Termination for Runaway Tasks | Accepted | 2026-09-16 |
| **[ADR-0012](0012-streaming-task-results-via-async-generators.md)** | Streaming Task Results via Async Generators and Structured IPC | Accepted | 2026-09-16 |
| **[ADR-0013](0013-worker-inter-communication-via-broadcast-channel.md)** | Worker Inter-Communication via Native BroadcastChannel | Accepted | 2026-09-16 |
| **[ADR-0014](0014-adaptive-concurrency-auto-tuning-via-event-loop-utilization.md)** | Adaptive Concurrency Auto-Tuning via Event Loop Utilization (ELU) | Accepted | 2026-09-16 |
| **[ADR-0015](0015-promise-rejection-contract-for-task-queue-waiters.md)** | Promise Rejection Contract for TaskQueue Waiters | Accepted | 2026-09-16 |
| **[ADR-0016](0016-priority-routing-and-fairness.md)** | Priority Routing and Fairness via Numeric Task Priority | Accepted | 2026-09-16 |
| **[ADR-0017](0017-cooperative-cancellation-via-abortsignal.md)** | Cooperative Cancellation via Standard `AbortSignal` | Accepted | 2026-09-16 |
| **[ADR-0018](0018-fire-and-forget-hazard-with-execute-and-post-shutdown-flakes.md)** | Fire-and-Forget Hazard with `runtime.execute()` and Post-Shutdown Test Flakes | Accepted | 2026-09-17 |
| **[ADR-0019](0019-default-workers-reduced-from-availableparallelism-to-1.md)** | Default Worker Pool Size Reduced from `availableParallelism() - 1` to `1` (memory + sizing) | Accepted | 2026-09-17 |
