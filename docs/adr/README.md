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
