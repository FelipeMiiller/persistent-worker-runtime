# Agent Handover Guide: Persistent Worker Runtime

> **Audience**: AI Coding Agents (Antigravity, Claude Code, Cursor, Windsurf, Copilot) or engineers starting a new chat/session on this repository.
> **Last Updated**: 2026-09-16
> **Active Branch**: `develop`

---

## 🎯 1. Project Overview & Context

- **Repository**: `https://github.com/FelipeMiiller/persistent-worker-runtime`
- **Local Path**: `c:\repository\persistent-worker-runtime`
- **NPM Package**: `persistent-worker-runtime` (version `0.1.0` live on registry)
- **Goal**: Build a high-performance persistent worker runtime for Node.js over native `worker_threads`, keeping the Event Loop 100% dedicated to non-blocking I/O while persistent workers execute CPU-bound tasks and transactional outbox background jobs with warm L1 heaps.
- **Node.js Core Target**: Designed as a zero-dependency reference implementation proposed for inclusion into Node.js core stdlib (`node:worker_threads`).

---

## 🔒 2. Non-Negotiable Operational Rules

1. **Active Branch**: All work is conducted directly on the **`develop`** branch.
   - **`main` is protected**: Never commit directly to `main`. Releases are merged via PRs from `develop`.
2. **Zero External Dependencies**: `package.json` has `dependencies: {}`. Do NOT install external runtime npm packages under any circumstances. Everything must use standard Node.js built-ins (`node:worker_threads`, `node:test`, `node:events`, `node:async_hooks`, `node:perf_hooks`).
3. **Language**: **100% English** across all code, docstrings, tests, ADRs, specs, and commit messages.
4. **Testing Gate**: Every single task must have tests. All tests (`npm test`) must pass with 100% approval before making any commit.
5. **Atomic Conventional Commits**: Commit each task atomically (`feat:`, `fix:`, `test:`, `docs:`, `perf:`, `chore:`, `ci:`, `refactor:`).

---

## 📍 3. Current State Snapshot

### Code Health (as of last commit)
- **149 tests passing** across 50 suites (0 failures, 0 skipped).
- **Coverage**: ~94.7% lines / ~91.0% branches / ~90.4% functions across `src/`.
- **Benchmarks**: 10 reproducible benchmarks covering event-loop lag, warm-state, batch concurrency, outbox throughput, zero-copy transfer, priority routing, cancellation latency, throughput scaling, hard preemption, and worker recycling.
- **Examples**: 6 runnable scripts demonstrating the public API.

### Completed Features (in `.specs/features/`)
1. **`persistent-worker-runtime/`** — Initial implementation (ADR-0001 to ADR-0009).
2. **`worker-recycling/`** — Complete (ADR-0010, T1-T5 all merged).
3. **`hard-preemption/`** — Complete (ADR-0011, T1-T5 all merged).

### Recent Quality Wins (last session)
- **Bug fix**: `task-queue.js` was leaking unhandled rejections — `destroy()` now rejects enqueue promises on waiters, and `drainWaiters()` cleans up abandoned settled-waiter timers.
- **Coverage**: task-queue.js 65% → 100%, errors.js 82% → 100%, worker-runtime.js 91% → 99.7%.
- **New dedicated unit tests**: `task-queue.test.js` (19), `errors.test.js` (14), `supervisor-units.test.js` (15), `state-and-affinity.test.js` (14), `zero-copy.test.js` (4), `priority-routing.test.js` (5), `cancel-signal.test.js` (5).
- **New benchmarks**: `zero-copy-transfer`, `priority-routing`, `abort-cancellation`, `throughput-scaling`.
- **New examples**: `priority-routing.js`, `zero-copy-image.js`, `cancel-on-disconnect.js`.

### Documented but NOT YET implemented (deferred ADRs)
- **ADR-0012** — Streaming task results via `AsyncGenerator` (`runtime.stream()`). Documented, declared in `src/index.d.ts` as a future addition; not in runtime yet.
- **ADR-0013** — Inter-worker communication via `BroadcastChannel`. Documented; not in runtime yet.
- **ADR-0014** — Adaptive concurrency auto-tuning via ELU. Documented; not in runtime yet.

---

## 🚀 4. Exact Next Action for the New Chat

**Your immediate goal**: Define and implement the next feature spec.

### Recommended candidates (in priority order)

1. **ELU Adaptive Concurrency (ADR-0014)** — Most impactful for production HTTP servers. Auto-throttles pool size under load to protect p99 latency.
2. **Inter-worker `BroadcastChannel` (ADR-0013)** — Useful for cache invalidation and pub/sub between workers.
3. **Streaming task results (ADR-0012)** — Useful for LLM token streaming and large dataset exports.

### Workflow

1. **Verify baseline**:
   ```bash
   git status              # should be clean on develop
   npm test                # 149/149 passing
   npm run test:coverage   # >90% line coverage
   ```
2. **Pick a feature** from the candidates above.
3. **Create the spec** under `.specs/features/<feature-name>/spec.md` and `tasks.md` (see existing specs for structure).
4. **Update `.specs/STATE.md`** with the new Handoff block pointing to the new feature.
5. **Implement T1 → T2 → ...** following the same conventional-commit cadence used by the previous features.

---

## 🛠 5. Useful Verification Commands

```bash
# Run all unit and integration tests
npm test

# Run code coverage report
npm run test:coverage

# Run all 10 benchmarks
npm run benchmark:all

# Run individual benchmarks
npm run benchmark              # Event Loop lag
npm run benchmark:stateful     # Warm L1 vs stateless
npm run benchmark:concurrency  # Bounded batch
npm run benchmark:outbox       # Outbox throughput
npm run benchmark:zero-copy    # ArrayBuffer transfer
npm run benchmark:priority     # Priority routing
npm run benchmark:cancel       # AbortController latency
npm run benchmark:scaling      # Worker count scaling
npm run benchmark:preemption   # Hard preemption watchdog
npm run benchmark:recycling    # Automatic recycling

# Run any example
node examples/<name>.js
```

## 📂 6. Key Files Quick Reference

| Purpose | Path |
|---|---|
| Public API entry | `src/index.js` |
| TypeScript types | `src/index.d.ts` |
| Execution engine | `src/worker-runtime.js` |
| Worker pool | `src/supervisor.js` |
| Worker wrapper | `src/worker-handle.js` |
| In-thread loop | `src/worker-thread-entry.js` |
| Task model | `src/task-handle.js` |
| Priority queue | `src/task-queue.js` |
| Error hierarchy | `src/errors.js` |
| Architectural decisions | `docs/adr/0001..0014-*.md` |
| Local spec/state | `.specs/STATE.md` (gitignored) |

## 🧭 7. Common Pitfalls to Avoid

1. **Don't `await enqueue()` without cleanup** — if the task gets cancelled mid-wait, the abandoned waiter promise stays pending until destroy(). Either always await the task's `handle.promise` or wrap with `.catch()`.
2. **Don't dispatch after `shutdown()`** — the runtime throws `WorkerRuntimeError('Cannot dispatch tasks: Runtime is shutting down')`.
3. **`fnCode` runs in a worker thread, not the main thread** — closures and outer-scope variables don't carry over. Use `payload` to pass data in.
4. **`transferList` detaches the buffer on the sender** — you cannot reuse the same `ArrayBuffer` after transfer; the runtime uses it as a one-way move.
5. **`forceKillOnTimeout: true` will terminate the worker** — the task promise rejects with `TaskTimeoutError(preempted: true)` and the supervisor spawns a replacement.
6. **`.specs/` is gitignored** — STATE.md updates only affect the local working tree, not the repo. Don't try to commit it.
