# Operational Guide for AI Agents (AGENTS.md)

This document provides operational instructions, navigation maps, and development rules for **AI Agents** (Antigravity, Claude Code, Cursor, Windsurf, Copilot) contributing to the **`persistent-worker-runtime`** repository.

---

## 🎯 Repository Mission & Architectural Philosophy

The **Persistent Worker Runtime** is a concurrent execution layer for Node.js built atop `node:worker_threads`.

Its core architectural axiom is:
> **"The Event Loop coordinates. Persistent Workers execute."**

The ultimate goal of this project is to provide a zero-dependency, pure JavaScript runtime atop `node:worker_threads` with stateful workers, priority routing, backpressure, and async-hooks-aware diagnostics.

---

## 🧭 Directory Map

```text
persistent-worker-runtime/
├── AGENTS.md                           # This operational guide
├── README.md                           # Primary user and developer documentation
├── HANDOVER.md                         # Handoff guide for the next chat/session
├── CONTEXT.md                          # Foundational architectural context (51 sections)
├── NODEJS_RFC_PROPOSAL_DRAFT.md        # Draft RFC proposal for a Node.js Persistent Worker Runtime built-in
├── package.json                        # Node.js >= 22, pure ESM, zero external dependencies
├── LICENSE                             # MIT License
├── .github/workflows/ci.yml            # Multi-OS matrix CI (Ubuntu, macOS, Windows)
├── .agents/rules/                      # Always-on rules (test-before-commit, MADR, zero-deps, end-of-spec hardening, perf-first-authoring)
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

## 📂 Tracked Issues & Known Drift (`.agents/issues/`)

These are the **canonical link targets** for the next session / agent. Each item is a known limitation or drift point — read before assuming a feature is implemented or assuming the docs are current.

| # | File | Title | Status | Why it matters |
| --- | --- | --- | --- | --- |
| 001 | [`.agents/issues/001-supervisor-start-not-idempotent.md`](.agents/issues/001-supervisor-start-not-idempotent.md) | `Supervisor.start()` not idempotent (pool doubles on double-call) | ✅ **FIXED** (`5c4069c` + `205c384`) | Regression guard already in `test/supervisor-units.test.js`; `#isStarted` flag added |
| 002 | [`.agents/issues/002-runtime-hardening-wave4-review.md`](.agents/issues/002-runtime-hardening-wave4-review.md) | Wave 4 review findings (T9-T11 + chunk leak) | ✅ **CLOSED** 2026-09-22 | Findings 1 (backoff Promise leak) + 2 (poll branch collapse) + Track 2 chunk leak all shipped in v0.2.0. Finding 3 (fresh-priority doc note) ⏳ open — docs only |
| CI | [`.agents/issues/CI-FAILURE-macos-benchmarks.md`](.agents/issues/CI-FAILURE-macos-benchmarks.md) | `npm run benchmark:all` failed on macOS-Latest ARM64 | ✅ **RESOLVED** 2026-09-23 | Dependabot SHA bump + `cpu-saturation.benchmark.js` platform-aware threshold (1.15× darwin / 1.3× others). CI green across 4 consecutive runs |

**Cross-references for related gaps** (not in `.agents/issues/` but worth knowing):

- [DR plan §8](docs/operations/disaster-recovery.md#8-open-items-gaps-to-close) — production-readiness gaps deferred for the reference implementation. **Note (2026-09-24, Felipe):** items **8.3 OpenTelemetry** and **8.4 Postgres SKIP LOCKED backend** are **permanently out-of-scope by rule** — the project follows ADR-0005 (pure vanilla JS, zero external runtime deps), which excludes the `pg` driver and the `@opentelemetry/api` peer-dep eagerly. The workaround documented in DR §8 (user installs their own OTel SDK; user fronts with their own Postgres queue) is the final answer, not a placeholder. Treat any future proposal to add OTel or Postgres directly to `src/` as a violation of ADR-0005 unless ADR-0005 itself is amended first. SIGTERM (8.1) and `/healthz` (8.2) remain user-wired workarounds.
- [`HANDOVER.md`](HANDOVER.md) — current session's pending follow-ups (T13+ portability, `gh auth refresh --scopes workflow`, etc.).

> **Reading rule:** before declaring a feature "implemented" or "shipped" in any downstream doc, verify against `src/` + `STATE.md` + the relevant ADR/spec. See [agent memory `verify-implementation-claims-before-formalizing` (2026-09-23)](D:\.minimax/agents/mavis/memory/MEMORY.md) for the rule + diagnostic.

---

## 📌 Strict Rules of Conduct for Agents

1. **Pure Vanilla JavaScript (No TypeScript in `src/*.js`):**
   - The runtime code must remain 100% vanilla modern JavaScript (ESM).
   - Zero external runtime dependencies. Only built-in `node:*` modules may be imported.
   - Types are provided exclusively in `src/index.d.ts` for consumer IDE autocompletion.
2. **Mandatory Testing + Lint after Every Modification:**
   - Always run `npm run validate` (= `npm run lint && npm test`) after any code change.
   - Never commit code if any unit test fails or any lint error remains.
   - The husky pre-commit hook runs `npx lint-staged` + `npm test` automatically; the pre-push hook runs the full validation.
3. **Architecture Decision Records (ADRs):**
   - Every major technical decision, concurrency pattern, or lifecycle alteration must be recorded in `docs/adr/` using the **MADR** format.
4. **All Documentation and Code in English:**
   - All code comments, variable names, ADRs, specifications, and git commits must be in English.
5. **Conventional Commits:**
   - Use standard prefixing: `feat:`, `fix:`, `docs:`, `test:`, `perf:`, `chore:`, `ci:`.

---

## 🧹 Lint + Format Workflow

The project uses **Biome 2.x** for both linting and formatting (single Rust binary, ~50× faster than ESLint).

| Script | Purpose |
| --- | --- |
| `npm run lint` | Check src/, test/, examples/, benchmarks/ against biome.json rules |
| `npm run lint:fix` | Auto-fix all fixable issues (use with care; `--unsafe` enables fixer for unsafe cases) |
| `npm run format` | Apply Biome formatter (single quotes, 2-space indent, trailing commas, LF) |
| `npm run format:check` | Verify formatting without applying |
| `npm run validate` | `lint` + `test` (used by pre-push hook and `prepublishOnly`) |

### Pre-commit hook (`.husky/pre-commit`)

```sh
npx lint-staged
npm test
```

`lint-staged` runs `biome check --write` only on the staged files (fast feedback + auto-fix safe style issues), then the full test suite runs to ensure nothing broke. **Non-fixable lint errors block the commit.**

### Pre-push hook (`.husky/pre-push`)

```sh
npm run validate
```

Runs the full lint + test suite before a push lands on `origin/develop`.

### Per-directory overrides in `biome.json`

- `examples/**`, `benchmarks/**`: `noConsole` is **off** (these are demonstrative scripts that print output).
- `test/**`: `noConsole` and `noEmptyBlockStatements` are **off** (legitimate patterns like `.catch(() => {})` for fire-and-forget).
