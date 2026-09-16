# Operational Guide for AI Agents (AGENTS.md)

This document provides operational instructions, navigation maps, and development rules for **AI Agents** (Antigravity, Claude Code, Cursor, Windsurf, Copilot) contributing to the **`persistent-worker-runtime`** repository.

---

## 🎯 Repository Mission & Architectural Philosophy

The **Persistent Worker Runtime** is a concurrent execution layer for Node.js built atop `node:worker_threads`.

Its core architectural axiom is:
> **"The Event Loop coordinates. Persistent Workers execute."**

The ultimate goal of this project is to provide a zero-dependency reference implementation and RFC for submission to **Node.js Core (`nodejs/node`)**.

---

## 🧭 Directory Map

```text
persistent-worker-runtime/
├── AGENTS.md                           # This operational guide
├── README.md                           # Primary user and developer documentation
├── HANDOVER.md                         # Handoff guide for the next chat/session
├── CONTEXT.md                          # Foundational architectural context (51 sections)
├── CONTRIBUTING_TO_NODEJS_PROCESS.md   # Strategic guide for Node.js Core contribution
├── NODEJS_RFC_PROPOSAL_DRAFT.md        # Official RFC proposal draft for nodejs/node
├── package.json                        # Node.js >= 22, pure ESM, zero external dependencies
├── LICENSE                             # MIT License
├── .github/workflows/ci.yml            # Multi-OS matrix CI (Ubuntu, macOS, Windows)
├── .agents/rules/                      # Always-on rules (test-before-commit, MADR, zero-deps)
├── docs/
│   └── adr/                            # Architecture Decision Records (MADR format, 0001..0014)
├── src/                                # Core implementation (pure JavaScript ESM)
│   ├── index.js                        # Public API entry point
│   ├── index.d.ts                      # TypeScript definitions for IDE autocompletion
│   ├── errors.js                       # Error hierarchy
│   ├── task-handle.js                  # Task model with AsyncResource and callbacks
│   ├── task-queue.js                   # Asynchronous priority queue with backpressure timeout
│   ├── worker-handle.js                # Managed Worker thread wrapper (watchdog, recycling, preemption)
│   ├── worker-thread-entry.js          # In-thread worker loop with L1 memory
│   ├── supervisor.js                   # Pool lifecycle, recycling, and crash recovery
│   └── worker-runtime.js               # Central execution engine
├── test/                               # Native unit tests (node:test, 149 tests across 50 suites)
│   ├── task-queue.test.js              # Queue unit tests (lifecycle, priority, affinity, drain, destroy)
│   ├── errors.test.js                  # Error hierarchy tests
│   ├── supervisor-units.test.js        # Supervisor getters, dispatch validation, retry path
│   ├── state-and-affinity.test.js      # L1 state ops, supervisor affinity, retry semantics
│   ├── zero-copy.test.js               # ArrayBuffer transferList semantics
│   ├── priority-routing.test.js        # Priority queue routing and FIFO within tier
│   ├── cancel-signal.test.js           # AbortController cancellation patterns
│   ├── recycling.test.js               # Worker recycling integration tests
│   ├── preemption.test.js              # Hard preemption watchdog integration tests
│   ├── concurrency-stress.test.js      # Concurrency stress tests
│   └── worker-runtime.test.js          # Core runtime end-to-end tests
├── benchmarks/                         # Performance and Event Loop lag benchmarks (10 total)
│   ├── event-loop-lag.benchmark.js
│   ├── stateful-vs-stateless.benchmark.js
│   ├── batch-concurrency.benchmark.js
│   ├── outbox-throughput.benchmark.js
│   ├── zero-copy-transfer.benchmark.js
│   ├── priority-routing.benchmark.js
│   ├── abort-cancellation.benchmark.js
│   ├── throughput-scaling.benchmark.js
│   ├── preemption-recovery.benchmark.js
│   └── worker-recycling.benchmark.js
├── examples/                           # Real-world usage patterns
│   ├── express-outbox-email.js         # Express + transactional outbox
│   ├── image-resizer-batch.js          # Bounded batch image processing
│   ├── persistent-ai-model.js          # Stateful worker with warm AI model in L1
│   ├── priority-routing.js             # Critical work vs. batch work ordering
│   ├── zero-copy-image.js              # TransferList for 30MB image buffer
│   └── cancel-on-disconnect.js         # Manual + AbortSignal.timeout + pre-aborted patterns
└── .specs/                             # LOCAL planning state (gitignored)
    ├── STATE.md                        # Active spec, decisions, handoff pointer
    └── features/                       # Per-feature spec + tasks breakdown
```

---

## 📌 Strict Rules of Conduct for Agents

1. **Pure Vanilla JavaScript (No TypeScript in `src/*.js`):**
   - The runtime code must remain 100% vanilla modern JavaScript (ESM).
   - Zero external runtime dependencies. Only built-in `node:*` modules may be imported.
   - Types are provided exclusively in `src/index.d.ts` for consumer IDE autocompletion.
2. **Mandatory Testing after Every Modification:**
   - Always run `npm test` after any code change.
   - Never commit code if any unit test fails.
3. **Architecture Decision Records (ADRs):**
   - Every major technical decision, concurrency pattern, or lifecycle alteration must be recorded in `docs/adr/` using the **MADR** format.
4. **All Documentation and Code in English:**
   - All code comments, variable names, ADRs, specifications, and git commits must be in English.
5. **Conventional Commits:**
   - Use standard prefixing: `feat:`, `fix:`, `docs:`, `test:`, `perf:`, `chore:`, `ci:`.
