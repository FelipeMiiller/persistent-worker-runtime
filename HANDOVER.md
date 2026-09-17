# Agent Handover Guide: Persistent Worker Runtime

> **Audience**: AI Coding Agents (Antigravity, Claude Code, Cursor, Windsurf, Copilot) or engineers starting a new chat/session on this repository.
> **Last Updated**: 2026-09-17
> **Active Branch**: `develop`

---

## 🎯 1. Project Overview & Context

- **Repository**: `https://github.com/FelipeMiiller/persistent-worker-runtime`
- **Local Path**: `c:\repository\persistent-worker-runtime`
- **NPM Package**: `persistent-worker-runtime` (version `0.1.0`)
- **Goal**: Build a high-performance persistent worker runtime for Node.js over native `worker_threads`, keeping the Event Loop 100% dedicated to non-blocking I/O while persistent workers execute CPU-bound tasks and transactional outbox background jobs with warm L1 heaps.
- **Node.js Core Target**: Designed as a zero-dependency reference implementation proposed for inclusion into Node.js core stdlib (`node:worker_threads`).

---

## 🔒 2. Non-Negotiable Operational Rules

1. **Active Branch**: All work is conducted directly on the **`develop`** branch.
   - **`main` is protected**: Never commit directly to `main`. Releases are merged via PRs from `develop`.
2. **Zero External Runtime Dependencies**: `package.json` has `dependencies: {}`. Do NOT install external runtime npm packages. Everything must use standard Node.js built-ins (`node:worker_threads`, `node:test`, `node:events`, `node:async_hooks`, `node:perf_hooks`, `node:os`).
3. **Language**: **100% English** across all code, docstrings, tests, ADRs, specs, and commit messages.
4. **Quality Gates**: Every task must pass `npm run validate` (= `npm run lint && npm test`) before commit. Lint violations block the commit via the husky pre-commit hook.
5. **Atomic Conventional Commits**: One task = one commit. Prefix: `feat:`, `fix:`, `test:`, `docs:`, `perf:`, `chore:`, `ci:`, `refactor:`.

---

## 📍 3. Current State Snapshot

### Code Health (as of last commit `7acdfe6`)
- **213 tests passing** across 72 suites (0 failures, 0 skipped, 0 cancelled).
- **Coverage**: 95.23% lines / 92.25% branches / 90.68% functions across `src/`.
- **Lint**: 0 errors, 0 warnings across `src/`, `test/`, `examples/`, `benchmarks/` (Biome 2.x).
- **Benchmarks**: 11 reproducible benchmarks. Full empirical results in `BENCHMARKS.md`.
- **Examples**: 7 runnable scripts demonstrating the public API.
- **Embedded Skill**: `skills/persistent-worker-runtime/` shipped in npm tarball, ~1k tokens on activation + 6 lazy-loaded references.

### Completed Features (all implemented and merged into `develop`)
1. **`persistent-worker-runtime/`** — Initial implementation (ADR-0001..0009).
2. **`worker-recycling/`** — Complete (ADR-0010).
3. **`hard-preemption/`** — Complete (ADR-0011).
4. **`broadcast-channel/`** — Complete (ADR-0013). Inter-worker `BroadcastChannel` for L1 cache invalidation and pub/sub.

### Recent Quality Wins (latest session)
- **Biome 2.x** + **husky 9** + **lint-staged 15** for lint infrastructure: pre-commit auto-fixes safe style, blocks on non-fixable errors; pre-push runs full validate.
- **`npm run validate`** wired into pre-push, prepublish; `npm run lint` and `npm run format` scripts.
- **Skill split** — SKILL.md body reduced from ~3,500 tokens to ~1,000 tokens; 5 new topic-specific `references/` files loaded on demand.
- **CI flake fix** — `runtime.execute()` without await caused `WorkerCrashError` to fire after test exit on slower CI runners (macOS Node 22). Fixed by `await`ing.
- **ADR-0013 delivery** — full BroadcastChannel feature: `ChannelRegistry`, main-thread `broadcast()`/`subscribe()`/`unsubscribe()`/`hasSubscribers()`, worker-side `context.channel()`, 25+ new tests, `examples/broadcast-cache-invalidation.js`, `benchmarks/broadcast-fanout.benchmark.js` (18× faster than per-worker dispatch), embedded-skill section.

### Documented but NOT YET Implemented (deferred ADRs)
- **ADR-0012** — Streaming task results via `AsyncGenerator` (`runtime.stream()`). Declared in `src/index.d.ts` as future addition.
- **ADR-0014** — Adaptive concurrency auto-tuning via ELU.

---

## 🚀 4. Exact Next Action for the New Chat

**Your immediate goal**: Define and implement the next feature spec.

### Recommended candidates (in priority order)

1. **ELU Adaptive Concurrency (ADR-0014)** — Most impactful for production HTTP servers. Auto-throttles pool size under load to protect p99 latency.
2. **Streaming Task Results (ADR-0012)** — Useful for LLM token streaming and large dataset exports.

### Workflow

1. **Verify baseline**:
   ```bash
   git status              # should be clean on develop
   npm run validate        # lint + test (must pass)
   npm run benchmark:all   # confirm all 11 benchmarks run
   ```
2. **Pick a feature** from the candidates above.
3. **Create the spec** under `.specs/features/<feature-name>/spec.md` and `tasks.md` (see existing specs for structure).
4. **Implement T1 → T2 → ...** following the same conventional-commit cadence used by the previous features.
5. **Update the docs** in the same commit(s) — README.md section, BENCHMARKS.md if relevant, embedded skill references if user-facing.

---

## 🛠 5. Useful Verification Commands

```bash
# Tests + lint
npm test                 # 213 tests
npm run test:coverage    # >95% line coverage
npm run lint             # biome check (no auto-fix)
npm run lint:fix         # biome check --write --unsafe
npm run format           # biome format --write
npm run format:check     # biome format (no fix)
npm run validate         # lint + test (used by pre-push, prepublish)

# Benchmarks (11 total — full results in BENCHMARKS.md)
npm run benchmark:all
npm run benchmark                  # Event Loop lag under load
npm run benchmark:stateful         # Warm L1 vs stateless reload (30.7× faster)
npm run benchmark:concurrency      # Bounded batch concurrency
npm run benchmark:outbox           # Transactional outbox throughput
npm run benchmark:zero-copy        # transferList vs clone (6.2× faster)
npm run benchmark:priority         # Priority routing & fairness
npm run benchmark:cancel           # AbortController cancellation (0.16 ms pre-aborted)
npm run benchmark:scaling          # Worker count scaling
npm run benchmark:preemption       # Hard preemption watchdog + pool healing
npm run benchmark:recycling        # Automatic recycling
npm run benchmark:broadcast        # BroadcastChannel fan-out (18.3× faster)

# Examples (7 total)
node examples/broadcast-cache-invalidation.js

# Verify ESM exports
node --input-type=module -e "import * as mod from './src/index.js'; console.log(Object.keys(mod));"
```

---

## 📂 6. Key Files Quick Reference

| Purpose | Path |
| --- | --- |
| Public API entry | `src/index.js` |
| TypeScript types | `src/index.d.ts` |
| Execution engine | `src/worker-runtime.js` |
| Worker pool | `src/supervisor.js` |
| Worker wrapper | `src/worker-handle.js` |
| In-thread loop | `src/worker-thread-entry.js` |
| Task model | `src/task-handle.js` |
| Priority queue | `src/task-queue.js` |
| Error hierarchy | `src/errors.js` |
| BroadcastChannel wrapper | `src/broadcast-channel.js` |
| Architectural decisions | `docs/adr/0001..0017-*.md` (see `docs/adr/README.md`) |
| Empirical benchmark results | `BENCHMARKS.md` |
| Embedded AI-agent skill | `skills/persistent-worker-runtime/` |
| Local spec/state | `.specs/STATE.md` (gitignored) |

---

## 🧭 7. Common Pitfalls to Avoid

1. **Don't `await enqueue()` without cleanup** — if a task gets cancelled mid-wait, the abandoned waiter promise stays pending until `destroy()`. Either await `handle.promise` or wrap with `.catch()`.
2. **Don't dispatch after `shutdown()`** — the runtime throws `WorkerRuntimeError('Cannot dispatch tasks: Runtime is shutting down')`.
3. **`fnCode` runs in a worker thread, not the main thread** — closures and outer-scope variables don't carry over. Use `payload` to pass data in. Same for `BroadcastChannel` channel names — inline them as literals in the fn body.
4. **`transferList` detaches the buffer on the sender** — you cannot reuse the same `ArrayBuffer` after transfer; the runtime uses it as a one-way move.
5. **`forceKillOnTimeout: true` will terminate the worker** — the task promise rejects with `TaskTimeoutError(preempted: true)` and the supervisor spawns a replacement.
6. **`.specs/` is gitignored** — STATE.md updates only affect the local working tree, not the repo. Don't try to commit it.
7. **`BroadcastChannel` does not loop back to the sender** — to evict your own cache, do it explicitly in addition to `publish()`.
8. **`subscribe()` after `runtime.shutdown()`** throws — subscribe BEFORE shutdown if you need to receive late messages.
9. **In tests, `await runtime.execute(...)` if measuring latency or relying on the result** — fire-and-forget `runtime.execute()` followed by a sync test exit can produce `WorkerCrashError` after the test ends (CI flake on slower runners).