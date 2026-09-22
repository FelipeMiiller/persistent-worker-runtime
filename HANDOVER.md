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

### Code Health (as of last commit `35613e0`)
- **Tests**: 563 passing across 153 suites (`node:test`), 0 failures, **0 skipped**, 0 cancelled. First-time zero-skip pipeline (the Track 2 chunk leak was the long-standing skip; fixed in `b5c4bde`).
- **Lint**: 0 errors, 0 warnings across `src/`, `test/`, `examples/`, `benchmarks/` (Biome 2.x).
- **Benchmarks**: 18 reproducible scripts (5 streaming + adaptive-concurrency throughput-scaling + io-throughput + 11 others). Full empirical results in `BENCHMARKS.md`.
- **Examples**: 11 runnable scripts demonstrating the public API.
- **Embedded Skill**: `skills/persistent-worker-runtime/` shipped in npm tarball.

### Completed Features (all implemented and merged into `develop`)
1. **`persistent-worker-runtime/`** — Initial implementation (ADR-0001..0009).
2. **`worker-recycling/`** — Complete (ADR-0010).
3. **`hard-preemption/`** — Complete (ADR-0011).
4. **`streaming-results/`** — Complete (ADR-0012).
5. **`broadcast-channel/`** — Complete (ADR-0013). Inter-worker `BroadcastChannel` for L1 cache invalidation and pub/sub.
6. **`adaptive-concurrency/`** — Complete (ADR-0014). Dual-signal ELU + `monitorEventLoopDelay` p99 controller with EWMA α=0.3 smoothing and 5-tick debounce; grow + drain-shrink (no `worker.terminate()`); opt-out via `concurrency: 'fixed'`; pool band `[1, maxWorkers]` honoring ADR-0019 default. Implementation complete through T9 (integration tests).
7. **`task-queue-waiters/`** — Complete (ADR-0015).
8. **`priority-routing/`** — Complete (ADR-0016).
9. **`cooperative-cancellation/`** — Complete (ADR-0017).
10. **`fire-and-forget-hazard/`** — Complete (ADR-0018).
11. **`default-pool-sizing/`** — Complete (ADR-0019).
12. **`runtime-hardening/`** — Complete (ADR-0024). All 11 HARDEN tasks delivered (T1-T11 across Wave 1-4 commits). Three post-review fixes landed: `714f1e6` (Finding 1: recycle-backoff Promise leak), `b5c4bde` (Track 2 chunk leak), `12f7603` (Finding 2: T10 redundant if/else collapse). ADR status: Proposed → Accepted.

### In-Progress Features (implementation started, not yet feature-complete)
_None._ All documented ADRs (0010–0024) are feature-complete.

### Recent Quality Wins (since last handover at `7acdfe6`)
- **T5–T7 streaming delivery** — cancellation refinement (unified `stream:aborted`, `MSG_STREAM_PAUSE`/`RESUME` backpressure, `#pendingStreams` queue), runtime-level telemetry (`stream:created`/`chunk`/`end`/`aborted`/`backpressure` + `activeStreams` stats), two runnable examples, README §Streaming section.
- **Streaming benchmarks** (`e60c348`) — added `streaming-queue-dispatch` + `streaming-abort-latency`; benchmark count grew to 17 then to 18 with `io-throughput`.
- **CI layout hardened** (`010b49b`) — split workflows (lint, coverage, commit-lint), SHA-pinned actions, concurrency + cancel-in-progress, paths-ignore, draft PR skip, `core-validate-commit@6.0.0`, dependabot zero-deps block, CODEOWNERS, PR template + DCO 1.1.
- **CI flake fix** — `runtime.execute()` without await caused `WorkerCrashError` to fire after test exit on slower CI runners (macOS Node 22). Fixed by `await`ing in tests.
- **Biome 2.x** + **husky 9** + **lint-staged 15** for lint infrastructure.
- **Docs cleanup** (`77394f6`) — stripped internal Node.js core submission language from the repository (per Felipe's direction). The RFC draft itself (`NODEJS_RFC_PROPOSAL_DRAFT.md`) is preserved as a design proposal without the upstream PR roadmap context.
- **ADR-0014 complete** (T1 → T9 across `b9966e5` + `9662661` + `e31589d` + later commits) — production-grade dual-signal controller: ELU + `monitorEventLoopDelay` p99, EWMA α=0.3, 5-tick debounce, grow + drain-shrink, first-class telemetry in `runtime.stats.adaptive`, opt-out via `concurrency: 'fixed'`. Full integration test suite passing (T9).
- **ADR-0024 complete** — runtime hardening (T1-T11 across `3882ee8`, `cdb8ce4`, `35cec8f` + post-review fixes `714f1e6`, `b5c4bde`, `12f7603`). All 11 HARDEN tasks delivered. ADR status moved Proposed → Accepted.
- **BENCHMARKS.md backfill** (`356b7ae`) — documented orphan benchmarks; reproduction snippet now lists all 18 scripts.
- **HANDOVER + README state refresh** (`3aa9c60`) — replaced stale state snapshot.

### Documented but NOT YET Implemented (deferred ADRs)
- _None._ All documented ADRs (0010–0019) are feature-complete; ADR-0014 is the active in-progress work (see "In-Progress Features" above).

---

## 🚀 4. Exact Next Action for the New Chat

**Your immediate goal**: ship the `v0.2.0` stable release. All feature work is
complete (ADR-0001 through ADR-0024 delivered). Pipeline is green (563/563
pass, 0 fail, 0 skip). What's missing is the release artifacts.

### Pre-stable checklist (in priority order)

1. **Verify pipeline one more time**:
   ```bash
   npm run validate        # lint + test — must show 563/563 + 0 skip
   ```
2. **README + CHANGELOG refresh** — README.md does not yet mention the
   HARDEN-06 through HARDEN-11 options (`accumulationRateMbPerSec`,
   `minRecycleIntervalMs`, `recycleOnTasksExhausted`, `dispatchStrategy`,
   `workerPollIntervalMs`, `recycleBackoffMs`). CHANGELOG.md does not
   exist yet — first entry should cover ADR-0014 + ADR-0024.
3. **Version bump** — `package.json` `0.1.0` → `0.2.0`. Bump `engines.node`
   if needed.
4. **Tag + publish** — `git tag v0.2.0 && git push --tags && npm publish`
   (verify npm registry credentials first).
5. **Alert Felipe** — message "stable v0.2.0 ready — bumped + tagged +
   published. Next chat can pick up any follow-up work."

### Optional follow-ups (not blockers)

- **Track 5 from issue 002** — hot-path benchmark as pre-push hook
  (currently only the lint+test pipeline runs in pre-push; the
  io-throughput benchmark is not gated). Defer until after v0.2.0 ships.
- **Finding 3 from issue 002** — T9 fresh-priority getter note in
  `dispatchStrategy` doc comment. Trivial. Defer.
- **Streaming backlog** — `streaming-abort-latency` Phase 2 (needs design).

### Workflow for v0.2.0 ship

1. Open `package.json` — change `version: "0.1.0"` → `0.2.0"`.
2. Commit `chore(release): bump version to 0.2.0`.
3. `git tag v0.2.0`.
4. `git push origin develop --follow-tags`.
5. `npm publish --access public` (or scoped accordingly).
6. Confirm on npmjs.com that v0.2.0 is live.
7. Reply to Felipe with the alert message above.

---

## 🛠 5. Useful Verification Commands

```bash
# Tests + lint
npm test                 # 563 tests across 153 suites (post-ADR-0024 + 3 review fixes)
npm run test:coverage    # >95% line coverage
npm run lint             # biome check (no auto-fix)
npm run lint:ci          # biome ci (CI strict mode; used by lint.yml)
npm run lint:fix         # biome check --write --unsafe
npm run format           # biome format --write
npm run format:check     # biome format (no fix)
npm run validate         # lint + test (used by pre-push, prepublish)

# Benchmarks (18 total — full results in BENCHMARKS.md)
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
npm run benchmark:io-throughput       # ADR-0024 sustained-rate benchmark (50k TCP round-trips)

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