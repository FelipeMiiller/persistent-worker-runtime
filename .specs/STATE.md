# Project State Snapshot: Persistent Worker Runtime

- **Repository:** `persistent-worker-runtime`
- **Target Subsystem:** Node.js Core (`node:worker_runtime` / `node:worker_threads`)
- **Language / Runtime:** Pure Vanilla JavaScript (ESM), Node.js >= 22.0.0 (Tested on Node.js 24)
- **Active Version:** `0.1.0`
- **Architecture Maturity:** Production-Grade Reference Implementation (Phase 1 & Phase 2 Complete)

---

## 🧭 Active Milestones

| Milestone | Status | Description |
| :--- | :--- | :--- |
| **M1: Core Execution Engine** | Completed | Native pool atop `node:worker_threads` with `execute()` and `executeAll()` |
| **M2: Transactional Outbox Engine** | Completed | Asynchronous `dispatch()` with `.onComplete()` and `.onError()` callbacks |
| **M3: L1 Persistent Worker State** | Completed | Stateful workers preserving in-memory heap caches across consecutive calls |
| **M4: Supervisor & Fault Recovery** | Completed | Automatic crash detection and replacement of failed worker isolates |
| **M5: Backpressure & AsyncResource** | Completed | Non-blocking queue timeouts and OpenTelemetry context propagation |
| **M6: Resilient Retries & Zero-Copy** | In Progress | Exponential backoff for outbox jobs and `transferList` zero-copy buffers |
| **M7: Node.js Core RFC Submission** | Ready | Prepared `NODEJS_RFC_PROPOSAL_DRAFT.md` and strategic guide for `nodejs/node` |

---

## 🏛 Key Decision Index

All decisions are recorded under `docs/adr/`:
* ADR-0001: Persistent Worker Runtime Over worker_threads
* ADR-0002: Three-Tier Memory Architecture (L1/L2/L3)
* ADR-0003: Dual Execution Model (execute vs. dispatch) & Outbox Pattern
* ADR-0004: Asynchronous Queue Backpressure with Timeout & AsyncResource
* ADR-0005: Pure Modern JavaScript (ESM, Node >= 24) Zero Dependencies
* ADR-0006: Bounded Concurrency Batch Processing (executeAll & dispatchAll)
* ADR-0007: Automatic Retry Policies with Exponential Backoff
* ADR-0008: Zero-Copy Binary Data Transfer via Transferable Objects
* ADR-0009: Elastic Worker Pool Auto-Scaling with Min/Max Bounds
