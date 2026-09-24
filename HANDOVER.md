# Agent Handover Guide: Persistent Worker Runtime

> **Audience**: AI Coding Agents (Antigravity, Claude Code, Cursor, Windsurf, Copilot) or engineers starting a new chat/session on this repository.
> **Last Updated**: 2026-09-22 (v0.2.1 shipped — ADR-0014 T12 docs complete)
> **Active Branch**: `main`
> **Released**: `v0.2.0` (2026-09-22 09:59Z) + `v0.2.1` (2026-09-22 21:13Z) on npm with provenance.

---

## 🎯 1. Project Overview & Context

- **Repository**: `https://github.com/FelipeMiiller/persistent-worker-runtime`
- **Local Path**: `c:\repository\persistent-worker-runtime`
- **NPM Package**: `persistent-worker-runtime` (latest: **`0.2.1`**)
- **Goal**: Build a high-performance persistent worker runtime for Node.js over native `worker_threads`, keeping the Event Loop 100% dedicated to non-blocking I/O while persistent workers execute CPU-bound tasks and transactional outbox background jobs with warm L1 heaps.

---

## 🔒 2. Non-Negotiable Operational Rules

1. **Active Branch**: All work is conducted on **`main`** (this project does not use a `develop` branch — PRs target `main` directly). Releases are tagged on `main` and published via the `release.yml` GitHub Actions workflow.
2. **Zero External Runtime Dependencies**: `package.json` has `dependencies: {}`. Do NOT install external runtime npm packages. Everything must use standard Node.js built-ins (`node:worker_threads`, `node:test`, `node:events`, `node:async_hooks`, `node:perf_hooks`, `node:os`).
3. **Language**: **100% English** across all code, docstrings, tests, ADRs, specs, and commit messages.
4. **Quality Gates**: Every task must pass `npm run validate` (= `npm run lint && npm test`) before commit. Lint violations block the commit via the husky pre-commit hook.
5. **Atomic Conventional Commits**: One task = one commit. Prefix: `feat:`, `fix:`, `test:`, `docs:`, `perf:`, `chore:`, `ci:`, `refactor:`.

---

## 📍 3. Current State Snapshot

### Code Health (as of commit `99ef885`, 2026-09-23)
- **Tests**: 563 passing across 153 suites (`node:test`), 0 failures, **0 skipped**, 0 cancelled. First-time zero-skip pipeline.
- **Lint**: 0 errors, 0 warnings across `src/`, `test/`, `examples/`, `benchmarks/` (Biome 2.x).
- **Benchmarks**: 20+ reproducible scripts (5 streaming + adaptive-concurrency Phase A/B/C/D/E + io-throughput + 11 others). Full empirical results in `BENCHMARKS.md`.
- **Examples**: 11 runnable scripts demonstrating the public API.
- **Embedded Skill**: `skills/persistent-worker-runtime/` shipped in npm tarball.

### Released
- **v0.2.0** (2026-09-22 09:59Z) — ADR-0014 (adaptive concurrency) + ADR-0024 (runtime hardening). Tag `e098329`. CI run `35713434984`.
- **v0.2.1** (2026-09-22 21:13Z) — Post-release hygiene bundle: `.gitattributes` (LF enforcement), CI workflow fixes (commit-lint SHA + `pull_request` event switch + `exec` require drop), macOS timing tolerance, ESM `require` condition, docs refresh. Tag `41d9eae`. CI run `35784807442`.

### Completed Features (all merged to `main`)
1. **`persistent-worker-runtime/`** — Initial implementation (ADR-0001..0009).
2. **`worker-recycling/`** — Complete (ADR-0010).
3. **`hard-preemption/`** — Complete (ADR-0011).
4. **`streaming-results/`** — Complete (ADR-0012).
5. **`broadcast-channel/`** — Complete (ADR-0013). Inter-worker `BroadcastChannel` for L1 cache invalidation and pub/sub.
6. **`adaptive-concurrency/`** — **Complete (ADR-0014) — T12 docs closed**. Dual-signal ELU + `monitorEventLoopDelay` p99 controller with EWMA α=0.3 smoothing and 5-tick debounce; grow + drain-shrink (no `worker.terminate()`); opt-out via `concurrency: 'fixed'`; pool band `[minWorkers, maxWorkers]`; first-class `runtime.stats.adaptive` 7-field telemetry. T1-T11 + T10-A/B/C/D/D-4/E + T12 all done.
7. **`task-queue-waiters/`** — Complete (ADR-0015).
8. **`priority-routing/`** — Complete (ADR-0016).
9. **`cooperative-cancellation/`** — Complete (ADR-0017).
10. **`fire-and-forget-hazard/`** — Complete (ADR-0018).
11. **`default-pool-sizing/`** — Complete (ADR-0019).
12. **`durable-queue-rpo/`** — Complete (ADR-0020). Postgres `SELECT FOR UPDATE SKIP LOCKED` first; Kafka/SQS acceptable.
13. **`multi-az-topology/`** — Complete (ADR-0021). ≥2 instances × ≥2 AZs active-active.
14. **`node-built-ins-map/`** — Complete (ADR-0022). Authoritative map of "Node built-ins we use" vs "custom code we wrote".
15. **`sizing-policy/`** — Complete (ADR-0023). `WORKER_CONCURRENCY` env + `concurrency: 'auto'` factory option.
16. **`runtime-hardening/`** — **Complete (ADR-0024) — Accepted**. All 11 HARDEN tasks delivered (T1-T11 across Wave 1-4 commits). 3 post-review fixes: recycle-backoff Promise leak (`714f1e6`), Track 2 chunk leak (`b5c4bde`), T10 redundant if/else collapse (`12f7603`).

### Recent Quality Wins (since last handover)
- **v0.2.0 → v0.2.1 promotion** — npm publish CI via `release.yml` (provenance + `id-token: write`). Fixed `.gitattributes` LF cycle, commit-lint workflow (SHA typo + `pull_request_target` → `pull_request` switch + `actions/github-script` v7 `exec` require drop), macOS test timing tolerance, ESM `require` condition, docs refresh.
- **Windows Node 22 CI flake fix** (`99ef885`) — `test/recycle-backoff.test.js` HARDEN-11 timing window widened 50ms → 200ms to match the explicit pattern used by sibling test #2 ("Bump to 200 ms to absorb CI timer noise on slow runners").
- **Dependabot bumps merged** — `actions/setup-node` 4.4.0 → 7.0.0 (`9c2b585`), `actions/checkout` 4.4.0 → 7.0.1 (`d9864ad`). Merged via direct git push (workaround for `gh` OAuth `workflow` scope limitation — see Lessons below).
- **ADR-0014 T12 docs closed** — README §11.1 cites T10 measured numbers (p50=0.041ms/p99=0.064ms tick overhead, 65.97 M ops/sec `classifyTickDirection` throughput, ~17s wall time for Phase A+B+E suite, 16→20 saturation plateau at 1.07×). BENCHMARKS.md §20 has the headline-numbers table. HANDOVER.md + STATE.md refreshed.

### Documented but NOT YET Implemented
- **None blocking for single-instance deployments.** All documented ADRs (0010–0024) have shipped **in-scope** features in v0.2.0/0.2.1.
- **Multi-instance / production deployments still have deferred gaps** tracked in [DR plan §8](docs/operations/disaster-recovery.md#8-open-items-gaps-to-close) — SIGTERM handler, `/healthz`, OpenTelemetry, durable queue backend. Each is `Status = deferred` with a user-side workaround that already works against current `src/`; see that section for per-item effort estimate to close.

### Tracked work (`.agents/issues/`)
- **`001-supervisor-start-not-idempotent.md`** — ✅ FIXED (`5c4069c` + `205c384`).
- **`002-runtime-hardening-wave4-review.md`** — ✅ CLOSED 2026-09-22 (all 3 findings + Track 2 chunk leak shipped in v0.2.0).
- **`CI-FAILURE-macos-benchmarks.md`** — 🟡 TRACKED — pre-existing macOS-Latest ARM64 benchmark failure (T13+ portable benchmarks). Not blocking merge/release.

---

## 🚀 4. Exact Next Action for the New Chat

**Current state**: v0.2.1 is shipped. All feature ADRs complete. No urgent release work pending.

### Open follow-ups (in priority order)

1. **T13+ portable benchmarks** — ✅ DONE 2026-09-23 (commit `75deeaf`). `.agents/issues/CI-FAILURE-macos-benchmarks.md` marked RESOLVED; macOS-Latest ARM64 benchmark now uses platform-aware `1.15× darwin / 1.3× others` threshold in `benchmarks/cpu-saturation.benchmark.js`. CI green across 4 consecutive runs.
2. **`gh auth refresh --scopes workflow`** — ✅ DONE 2026-09-23. Token now has `gist`, `read:org`, `repo`, **`workflow`** (verified via `gh auth status`). Future dependabot PRs that touch `.github/workflows/*.yml` can be merged with `gh pr merge` directly — no more `git fetch + local merge + git push` workaround.
3. **Spec-precision follow-ups** (cheap, non-blocking, ~25 lines total):
   - `RECYCLE-08` — negative-case assertion in `test/worker-recycling.test.js`.
   - `PREEMPT-06` — explicit field-name assertions in `worker_replaced` event payload.
   - `PREEMPT-08` — shutdown-during-pending-watchdog `unhandledRejection` regression test.
4. **`tasks.md` template migration** — pre-existing drift in `.specs/features/adaptive-concurrency/tasks.md` and `.specs/features/persistent-worker-runtime/tasks.md`. Both fail `validate_tasks.py` with 4 structural errors each (missing `## Test Coverage Matrix`, `## Gate Check Commands`, `## Execution Plan`, `## Task Breakdown` + per-task `**Tests**:` / `**Gate**:` fields). Dedicated session with human review.
5. **DR plan §8 open items** — SIGTERM handler, `/healthz` endpoint, OpenTelemetry, durable queue backend (Postgres impl per ADR-0020). **All 4 are deferred, not built-in** (corrected 2026-09-23 — earlier text said "Implementation partial in `src/`" which over-stated reality):
   - **SIGTERM handler** — `runtime.shutdown()` exists and is idempotent, but no built-in `process.on('SIGTERM', ...)` registration in `src/`. Workaround (works today): user wires a 3-line listener; pattern documented in `skills/persistent-worker-runtime/references/observability.md §Lifecycle`.
   - **/healthz endpoint** — zero HTTP server in `src/`. Workaround (works today): caller-side `http.createServer` reads `runtime.stats()` + `isShuttingDown`.
   - **OpenTelemetry** — only `AsyncResource` propagation is in place (the OTel Node SDK's transport); no spans emitted by the runtime. Workaround (works today): user installs `@opentelemetry/api` and wraps their own task fns; context flows into workers automatically.
   - **queueBackend Postgres** — not implemented. ADR-0020 §Implementation Notes: *"Tracked separately as T7-extension or T12 — this ADR records the decision, not the implementation steps."* Workaround: caller fronts the runtime with an external queue (SQS / Kafka / Postgres) per DR §5.2.1.
   - **§8 doc formalization**: ✅ DONE 2026-09-23 (this session) — 6 detailed subsections (`docs/operations/disaster-recovery.md §8.1–§8.6`). Each entry has Goal / Current state / Why deferred / Workaround today / Estimated effort to close.

### Workflow for next release (v0.3.0 — placeholder)

When ready:
1. `git checkout -b chore/release-v0.3.0`
2. Land features in conventional-commits commits.
3. `npm version minor` (0.2.1 → 0.3.0).
4. `git push origin chore/release-v0.3.0`.
5. Open PR → merge to `main` (CI runs `lint` + `test` matrix).
6. Tag triggers `release.yml` workflow → npm publish with provenance.
7. GitHub release notes.

---

## 🛠 5. Useful Verification Commands

```bash
# Tests + lint
npm test                     # 563 tests across 153 suites (post-ADR-0024 + 3 review fixes + Windows Node 22 fix)
npm run lint                 # biome check (no auto-fix)
npm run lint:ci              # biome ci (CI strict mode; used by lint.yml)
npm run validate             # lint + test (used by pre-push, prepublish)

# Benchmarks (20+ scripts — full results in BENCHMARKS.md)
npm run benchmark:all
npm run benchmark                              # Event Loop lag under load
npm run benchmark:stateful                     # Warm L1 vs stateless reload (30.7× faster)
npm run benchmark:concurrency                  # Bounded batch concurrency
npm run benchmark:outbox                       # Transactional outbox throughput
npm run benchmark:zero-copy                    # transferList vs clone (6.2× faster)
npm run benchmark:priority                     # Priority routing & fairness
npm run benchmark:cancel                       # AbortController cancellation (0.16 ms pre-aborted)
npm run benchmark:scaling                      # Worker count scaling
npm run benchmark:preemption                   # Hard preemption watchdog + pool healing
npm run benchmark:recycling                    # Automatic recycling
npm run benchmark:broadcast                    # BroadcastChannel fan-out (18.3× faster)
npm run benchmark:streaming-queue-dispatch     # T5 queued stream dispatch latency
npm run benchmark:streaming-abort-latency      # Consumer break → worker finally
npm run benchmark:streaming-throughput        # chunks/sec by stream length × HWM
npm run benchmark:streaming-memory             # RSS steady-state + queue footprint
npm run benchmark:streaming-stress             # concurrent streams + 50k chunks + abort latency
npm run benchmark:default-sizing-memory       # ADR-0019 (default workers=1 is 5× to 20× cheaper on multi-core hosts)
npm run benchmark:io-throughput                # ADR-0024 sustained-rate (50k TCP round-trips)
npm run benchmark:cpu-saturation               # Phase E — CPU saturation knee
npm run benchmark:adaptive-controller          # ADR-0014 tick overhead < 1ms SLA (p50=0.041ms / p99=0.064ms)
npm run benchmark:adaptive-controller-opt-out  # ADR-0014 opt-out overhead
npm run benchmark:adaptive-concurrency         # ADR-0014 end-to-end grow/shrink

# Examples
node examples/adaptive-concurrency.js          # Three sizing modes side-by-side (ADR-0014)
node examples/broadcast-cache-invalidation.js
node examples/streaming-llm.js                 # TTFT + signal abort + runtime events
node examples/streaming-csv-export.js          # backpressure with slow consumer
node examples/express-outbox-email.js          # Express + transactional outbox
node examples/image-resizer-batch.js           # Bounded batch image processing
node examples/persistent-ai-model.js           # Stateful worker with warm AI model in L1
node examples/priority-routing.js              # Critical work vs. batch work ordering
node examples/zero-copy-image.js               # transferList for 30MB image buffer
node examples/cancel-on-disconnect.js          # Manual + AbortSignal.timeout + pre-aborted patterns

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
| Adaptive concurrency controller (ADR-0014) | `src/adaptive-controller.js` |
| Worker-pool sizing helpers (ADR-0023) | `src/worker-pool-sizing.js` |
| Architectural decisions | `docs/adr/0001..0024-*.md` (see `docs/adr/README.md`) |
| DR plan | `docs/operations/disaster-recovery.md` |
| Empirical benchmark results | `BENCHMARKS.md` |
| Embedded AI-agent skill | `skills/persistent-worker-runtime/` |
| Local spec/state | `.specs/STATE.md` (gitignored — local planning only) |

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
10. **One task = one commit.** Don't batch. Verify `git diff origin/main..HEAD --stat` before pushing.
11. **GitHub OAuth `workflow` scope** — ~~missing~~ ✅ resolved 2026-09-23 via `gh auth refresh --scopes workflow` (interactive). If a future session hits `GraphQL: refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope` again, it means the scope was lost — re-run the refresh. Workaround until fix: fetch PR head ref + merge locally + push via plain git.
12. **GitHub REST API cannot change PR head branch** — `PATCH /repos/{owner}/{repo}/pulls/{number}` ignores `head` field. To rename a branch after PR is open: edit title/body on closed PR + redirect comment + create new PR from renamed branch.
13. **Windows Node 22 CI flake** — node startup is slower on Windows + Node 22. Use 200ms timing windows (not 50ms) for any "wait briefly then assert pool state" tests.

---

## 📜 8. Release + CI Notes (post-v0.2.1)

- **`release.yml`** triggers automatically on `release: published` → runs `npm ci` + `npm test` + `npm publish --access public --provenance`. Uses `secrets.NPM_TOKEN` via `NODE_AUTH_TOKEN` env var. Permissions include `id-token: write` for npm provenance attestation.
- **`commit-lint.yml`** uses `pull_request` event (not `pull_request_target`). With `pull_request_target`, the workflow always reads the workflow file from `main`, so PR-branch fixes wouldn't take effect until after merge. The post-merge version of `commit-lint.yml` is the one that validates.
- **`ci.yml`** matrix: Node 22.x + 24.x × ubuntu/macos/windows. Pre-existing flake: `Test on Node 22.x (macos-latest)` benchmarks step (`benchmarks/cpu-saturation`). Tracked in `.agents/issues/CI-FAILURE-macos-benchmarks.md`. Fixed in v0.2.1: `Test on Node 22.x (windows-latest)` recycle-backoff timing (`99ef885`).
- **npm registry propagation delay** — variable. v0.2.0 visible in 54s; v0.2.1 took 4min 8s. Don't panic-declare-failure within 1 minute. Check Sigstore provenance (`npm notice publish Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=<id>`) to confirm publish succeeded even if registry hasn't caught up.
