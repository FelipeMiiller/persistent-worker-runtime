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
├── CONTEXT.md                          # Foundational architectural context (51 sections)
├── CONTRIBUTING_TO_NODEJS_PROCESS.md   # Strategic guide for Node.js Core contribution
├── NODEJS_RFC_PROPOSAL_DRAFT.md        # Official RFC proposal draft for nodejs/node
├── package.json                        # Node.js >= 22, pure ESM, zero external dependencies
├── LICENSE                             # MIT License
├── .github/workflows/ci.yml            # Multi-OS matrix CI (Ubuntu, macOS, Windows)
├── docs/
│   └── adr/                            # Architecture Decision Records (MADR format)
├── src/                                # Core implementation (pure JavaScript ESM)
│   ├── index.js                        # Public API entry point
│   ├── index.d.ts                      # TypeScript definitions for IDE autocompletion
│   ├── errors.js                       # Error hierarchy
│   ├── task-handle.js                  # Task model with AsyncResource and callbacks
│   ├── task-queue.js                   # Asynchronous queue with backpressure timeout
│   ├── worker-handle.js                # Managed Worker thread wrapper
│   ├── worker-thread-entry.js          # In-thread worker loop with L1 memory
│   ├── supervisor.js                   # Pool lifecycle, elasticity, and crash recovery
│   └── worker-runtime.js               # Central execution engine
├── test/                               # Native unit tests (node:test)
├── benchmarks/                         # Performance and Event Loop lag benchmarks
└── examples/                           # Real-world usage patterns (Express, Outbox, AI)
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
