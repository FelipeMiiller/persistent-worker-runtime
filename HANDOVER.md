# Agent Handover Guide: Persistent Worker Runtime

> **Audience**: AI Coding Agents (Antigravity, Claude Code, Cursor, Windsurf, Copilot) or engineers starting a new chat/session on this repository.
> **Last Updated**: 2026-09-18 (T3 adaptive-concurrency shipped — Phase 1 done; T4-T12 pending)
> **Active Branch**: `develop`

---

## 🎯 1. Project Overview & Context

- **Repository**: `https://github.com/FelipeMiiller/persistent-worker-runtime`
- **Local Path**: `c:\repository\persistent-worker-runtime`
- **NPM Package**: `persistent-worker-runtime` (version `0.1.0`)
- **Goal**: Build a high-performance persistent worker runtime for Node.js over native `worker_threads`, keeping the Event Loop 100% dedicated to non-blocking I/O while persistent workers execute CPU-bound tasks and transactional outbox background jobs with warm L1 heaps.

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

### Code Health (as of last commit `e31589d`)
- **Tests**: 363 passing across 109 suites (`node:test`), 0 failures, 0 skipped, 0 cancelled.
- **Coverage**: not re-measured since ADR-0014 lands the controller incrementally (T1-T3 added code, no regression; full sweep deferred to T12).
- **Lint**: 0 errors, 0 warnings across `src/`, `test/`, `examples/`, `benchmarks/` (Biome 2.x).
- **Benchmarks**: 17 reproducible scripts (5 streaming + 12 others). Full empirical results in `BENCHMARKS.md`. No new benchmarks yet — adaptive-concurrency benchmark lands in T10.
- **Examples**: 9 runnable scripts demonstrating the public API. Adaptive-concurrency example (`examples/adaptive-concurrency.js`) lands in T11.
- **Embedded Skill**: `skills/persistent-worker-runtime/` shipped in npm tarball, ~1k tokens on activation + 6 lazy-loaded references.

### Completed Features (all implemented and merged into `develop`)
1. **`persistent-worker-runtime/`** — Initial implementation (ADR-0001..0009).
2. **`worker-recycling/`** — Complete (ADR-0010).
3. **`hard-preemption/`** — Complete (ADR-0011).
4. **`streaming-results/`** — Complete (ADR-0012). `runtime.stream()` API with AsyncGenerator / structured IPC / per-stream backpressure / queue-aware scheduling / runtime-level telemetry events. T1–T7 delivered across commits `87afbf3`, `36cd760`, `38401b3`, `8fd3b36`, `d493eb8`, `32c9c9d`, `49f6cf6`. Two runnable examples in `examples/`; five dedicated benchmarks (throughput, memory, stress, queue-dispatch, abort-latency).
5. **`broadcast-channel/`** — Complete (ADR-0013). Inter-worker `BroadcastChannel` for L1 cache invalidation and pub/sub.
6. **`task-queue-waiters/`** — Complete (ADR-0015). Promise rejection contract: `destroy()` rejects in-flight enqueue Promises so abandoned waiters can't strand the queue.
7. **`priority-routing/`** — Complete (ADR-0016). Numeric task priority with tier dequeue + FIFO-within-tier.
8. **`cooperative-cancellation/`** — Complete (ADR-0017). `AbortSignal` integration; emits `TaskAbortedError`, signal-aware dispatch.
9. **`fire-and-forget-hazard/`** — Complete (ADR-0018). Test flake prevention by always `await`ing `runtime.execute()` (or using `dispatch()`).
10. **`default-pool-sizing/`** — Complete (ADR-0019). `workers=1` default + warning on >4 cores; empirically 6.95× cheaper than legacy `os.availableParallelism()` on multi-core hosts.

### In-Progress Features (implementation started, not yet feature-complete)
1. **`adaptive-concurrency/`** — **In progress** (ADR-0014). Dual-signal ELU + `monitorEventLoopDelay` p99 controller with EWMA α=0.3 smoothing and 5-tick debounce; grow + drain-shrink (no `worker.terminate()`); opt-out via `concurrency: 'fixed'`; pool band `[1, maxWorkers]` honoring ADR-0019 default. Spec + 12-task breakdown in `.specs/features/adaptive-concurrency/`. **Phase 1 done** — T1 (scaffold, `b9966e5`) + T2 (Ewma + SignalMonitor, `9662661`) + T3 (DebounceCounter, `e31589d`). **Phase 2-6 pending** — T4 (spawn/retire actions), T5 (decision matrix), T6 (band validation + opt-out), T7 (supervisor tick integration), T8 (telemetry block), T9 (integration tests), T10 (benchmark), T11 (example), T12 (README + BENCHMARKS + HANDOVER).

### Recent Quality Wins (since last handover at `7acdfe6`)
- **T5–T7 streaming delivery** — cancellation refinement (unified `stream:aborted`, `MSG_STREAM_PAUSE`/`RESUME` backpressure, `#pendingStreams` queue), runtime-level telemetry (`stream:created`/`chunk`/`end`/`aborted`/`backpressure` + `activeStreams` stats), two runnable examples, README §Streaming section.
- **Streaming benchmarks** (`e60c348`) — added `streaming-queue-dispatch` + `streaming-abort-latency`; total benchmark count now 17.
- **CI layout hardened** (`010b49b`) — split workflows (lint, coverage, commit-lint), SHA-pinned actions, concurrency + cancel-in-progress, paths-ignore, draft PR skip, `core-validate-commit@6.0.0`, dependabot zero-deps block, CODEOWNERS, PR template + DCO 1.1.
- **CI flake fix** — `runtime.execute()` without await caused `WorkerCrashError` to fire after test exit on slower CI runners (macOS Node 22). Fixed by `await`ing in tests.
- **Biome 2.x** + **husky 9** + **lint-staged 15** for lint infrastructure.
- **Docs cleanup** (`77394f6`) — stripped internal Node.js core submission language from the repository (per Felipe's direction). The RFC draft itself (`NODEJS_RFC_PROPOSAL_DRAFT.md`) is preserved as a design proposal without the upstream PR roadmap context.
- **ADR-0014 refined** (`af0a906`) — superseded the simplified 2026-09-16 version of the ELU adaptive concurrency ADR with a production-grade dual-signal controller design: ELU + `monitorEventLoopDelay` p99 with EWMA α=0.3 smoothing and 5-tick debounce; grow + drain-shrink (not terminate); first-class telemetry in `runtime.stats.adaptive`; opt-out via `concurrency: 'fixed'`; pool band `[1, maxWorkers]` that respects the ADR-0019 conservative default. Spec + 12-task breakdown in `.specs/features/adaptive-concurrency/`. Implementation pending (T1 → T12).
- **BENCHMARKS.md backfill** (`356b7ae`) — documented the four orphan benchmarks that shipped via hardening + ADR-0019 but were never sectioned (`streaming-throughput`, `streaming-memory`, `streaming-stress`, `default-sizing-memory`). `How to Reproduce All Results` snippet now lists all 17 scripts.
- **HANDOVER + README state refresh** (`3aa9c60`) — replaced stale state snapshot (commit ref, test counts, coverage, benchmark count, reproduction snippet) so a new chat session lands on the current numbers, not the pre-T5 ones.
- **ADR-0014 Phase 1 landed** (`b9966e5` + `9662661` + `e31589d`) — adaptive concurrency controller scaffold (T1), EWMA smoothing + signal monitor wired into `tick()` (T2), debounce state-machine primitive (T3). Phase 2-6 (resize actions, decision matrix, WorkerRuntime wiring, telemetry, integration tests, benchmark, example, README) pending.

### Documented but NOT YET Implemented (deferred ADRs)
- _None._ All documented ADRs (0010–0019) are feature-complete; ADR-0014 is the active in-progress work (see "In-Progress Features" above).

---

## 🚀 4. Exact Next Action for the New Chat

**Your immediate goal**: continue the active feature (ADR-0014 ELU adaptive concurrency — Phase 1 done, Phase 2 next).

### Recommended candidates (in priority order)

1. **Adaptive Concurrency (ADR-0014) — T4** — Spawn + retire worker actions (`spawnWorker()` calls into `WorkerRuntime.spawnIdleWorker()`, `retireLowestLoadWorker()` picks lowest `tasksCompletedSinceBoot` worker, marks it `draining`, waits for in-flight task to complete — **no `worker.terminate()`**), hooks `runtime.events` `worker:retiring` (`{ workerId, reason: 'drain' }`). Depends on T3 (✅). **Architectural call needed first**: T4 needs `WorkerRuntime.spawnIdleWorker()` (lands in T7) — pick the seam: (a) controller calls `runtime.spawnIdleWorker()` via injected ref, (b) supervisor exposes spawn/retire methods the controller calls, (c) defer T4 until T7 lands the runtime API and do T5-T6 first. **Recommendation**: do (a) with a forward declaration — T4 takes a `spawnIdle` callback in factory options, T7 wires it to the real `runtime.spawnIdleWorker()`. That keeps T4 testable in isolation and unblocks the decision matrix (T5).
2. **Phase 2 of `streaming-abort-latency` benchmark** — currently deferred (see code comment "needs more design"). Worth revisiting once ADR-0014 lands and we have a clearer picture of abort latency under adaptive concurrency.

### Workflow

1. **Verify baseline**:
   ```bash
   git status              # should be clean on develop
   npm run validate        # lint + test (must pass — currently 363/363 across 109 suites)
   npm run benchmark:all   # confirm all 17 benchmarks run (none added yet for adaptive-concurrency; T10 ships the first)
   ```
2. **Open the existing spec + tasks + completion-checklist** at `.specs/features/adaptive-concurrency/{spec.md,tasks.md,completion-checklist.md}` (all drafted 2026-09-18; local-only via gitignore). The completion-checklist has the T1-T3 progress + lessons captured so far. Review the locked decisions in the Assumptions table before coding.
3. **Implement T4 → T5 → ...** following the same conventional-commit cadence used by the previous features. **One task = one commit** (T1+T2 were merged into T2 after a `git reset HEAD~2` rewrite — don't repeat that mistake; commit per task, verify diff before push).
4. **Update the docs** in the same commit(s) — README.md §Adaptive Concurrency, BENCHMARKS.md if relevant, embedded skill references if user-facing. HANDOVER refresh after each phase (not every task — too noisy).

---

## 🛠 5. Useful Verification Commands

```bash
# Tests + lint
npm test                 # 363 tests across 109 suites (post-ADR-0014 T1-T3)
npm run test:coverage    # >95% line coverage (full sweep deferred to T12)
npm run lint             # biome check (no auto-fix)
npm run lint:ci          # biome ci (CI strict mode; used by lint.yml)
npm run lint:fix         # biome check --write --unsafe
npm run format           # biome format --write
npm run format:check     # biome format (no fix)
npm run validate         # lint + test (used by pre-push, prepublish)

# Benchmarks (17 total — full results in BENCHMARKS.md)
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
npm run benchmark:streaming-queue-dispatch   # T5 queued stream dispatch latency
npm run benchmark:streaming-abort-latency    # Consumer break → worker finally
npm run benchmark:streaming-throughput  # chunks/sec by stream length × HWM
npm run benchmark:streaming-memory      # RSS steady-state + queue footprint
npm run benchmark:streaming-stress      # concurrent streams + 50k chunks + abort latency
npm run benchmark:default-sizing-memory # ADR-0019 (default workers=1 is 5× to 20× cheaper on multi-core hosts)

# Examples (9 total)
node examples/broadcast-cache-invalidation.js
node examples/streaming-llm.js          # TTFT + signal abort + runtime events
node examples/streaming-csv-export.js   # backpressure with slow consumer

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
| Adaptive concurrency controller (ADR-0014) | `src/adaptive-controller.js` (T1-T3 done; T4-T5 pending) |
| Architectural decisions | `docs/adr/0001..0019-*.md` (see `docs/adr/README.md`) |
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
10. **One task = one commit.** The T1 commit (`b9966e5`) originally bundled T1+T2 content; the fix required a `git reset HEAD~2` + rewrite + restore via backup. Don't repeat. Commit per task; verify the diff scope before push (`git diff origin/develop..HEAD --stat`).