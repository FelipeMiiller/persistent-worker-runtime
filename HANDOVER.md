# Agent Handover Guide: Persistent Worker Runtime

> **Audience**: AI Coding Agents (Antigravity, Claude Code, Cursor, Windsurf, Copilot) or engineers starting a new chat/session on this repository.
> **Last Updated**: 2026-10-03 (v0.3.0 shipped; CI hardening + spec hygiene + large-file investigation)
> **Active Branch**: `develop` (tracks `origin/develop`; `main` is the release target)
> **Released**: `v0.2.0`, `v0.2.1`, **`v0.3.0`** (2026-09-24) on npm with provenance.
> **In flight**: `develop` is ~40 commits ahead of `main` with **no API changes** — the delta is 4 benchmark-assertion fixes, 3 new examples, and docs. Release (bump / promote / publish) is deliberately deferred; see §4.

---

## 🎯 1. Project Overview & Context

- **Repository**: `https://github.com/FelipeMiiller/persistent-worker-runtime`
- **Local Path**: `c:\repository\persistent-worker-runtime`
- **NPM Package**: `persistent-worker-runtime` (latest: **`0.3.0`**)
- **Goal**: Build a high-performance persistent worker runtime for Node.js over native `worker_threads`, keeping the Event Loop 100% dedicated to non-blocking I/O while persistent workers execute CPU-bound tasks and transactional outbox background jobs with warm L1 heaps.

---

## 🔒 2. Non-Negotiable Operational Rules

1. **Active Branch**: All work is conducted on **`develop`**, which tracks `origin/develop`. `main` is the release target: releases are promoted `develop` → `main` and tagged there, then published via the `release.yml` GitHub Actions workflow. **Never push `develop` straight to `main`** — that skips the promotion step. (This rule previously said the project had no `develop` branch; that changed on 2026-09-27, when `develop`'s upstream was found to be misconfigured to `origin/main` and corrected. A bare `git push` would have landed a push on `main`.)
2. **Zero External Runtime Dependencies**: `package.json` has `dependencies: {}`. Do NOT install external runtime npm packages. Everything must use standard Node.js built-ins (`node:worker_threads`, `node:test`, `node:events`, `node:async_hooks`, `node:perf_hooks`, `node:os`, `node:sqlite`).
3. **Language**: **100% English** across all code, docstrings, tests, ADRs, specs, and commit messages.
4. **Quality Gates**: Every task must pass `npm run validate` (= `npm run lint && npm test`) before commit. Lint violations block the commit via the husky pre-commit hook.
5. **Atomic Conventional Commits**: One task = one commit. Prefix: `feat:`, `fix:`, `test:`, `docs:`, `perf:`, `chore:`, `ci:`, `refactor:`.

---

## 📍 3. Current State Snapshot

### Code Health (as of 2026-10-03)
- **Tests**: **622 passing**, 0 failures, 0 skipped, 0 cancelled (`node:test`).
- **Lint**: 0 errors, 0 warnings across `src/`, `test/`, `examples/`, `benchmarks/`, `research/` (Biome 2.x).
- **Benchmarks**: **24** gated scripts in `benchmarks/`, all wired into `npm run benchmark:all` and run in CI. Full empirical results in `BENCHMARKS.md`.
- **Research**: 2 usage-pattern investigations in `research/` (NOT CI gates — they measure how an *application* should use the library, not `src/` itself). See [`research/README.md`](research/README.md).
- **Examples**: **20** runnable scripts demonstrating the public API, all verified to exit 0.
- **Embedded Skill**: `skills/persistent-worker-runtime/` shipped in npm tarball.

### Released
- **v0.2.0** (2026-09-22 09:59Z) — ADR-0014 (adaptive concurrency) + ADR-0024 (runtime hardening). Tag `e098329`. CI run `35713434984`.
- **v0.2.1** (2026-09-22 21:13Z) — Post-release hygiene bundle: `.gitattributes` (LF enforcement), CI workflow fixes (commit-lint SHA + `pull_request` event switch + `exec` require drop), macOS timing tolerance, ESM `require` condition, docs refresh. Tag `41d9eae`. CI run `35784807442`.
- **v0.3.0** (2026-09-24) — Durable queue via `node:sqlite` (T13: `SqliteTaskQueue`, lease-based orphan recovery, retry budget) + liveness/readiness probes (DR §8.2 closure, `runtime.isAlive()` / `runtime.isReady()`). Tag `a515998`. ADR-0020 **revised** 2026-09-24 to SQLite-only; external RDBMS/event-streaming backends permanently out-of-scope by ADR-0005.

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
12. **`durable-queue-rpo/`** — **Complete (ADR-0020, SHIPPED v0.3.0 on 2026-09-24)**. `SqliteTaskQueue` via `node:sqlite` (T13 + T13.1 hardening + T13.2 lease reclaim / retry budget). ADR revised 2026-09-24 to **SQLite-only**; external backends (RDBMS / event-streaming) permanently out-of-scope by ADR-0005.
13. **`multi-az-topology/`** — Complete (ADR-0021). ≥2 instances × ≥2 AZs active-active.
14. **`node-built-ins-map/`** — Complete (ADR-0022). Authoritative map of "Node built-ins we use" vs "custom code we wrote".
15. **`sizing-policy/`** — Complete (ADR-0023). `WORKER_CONCURRENCY` env + `concurrency: 'auto'` factory option.
16. **`runtime-hardening/`** — **Complete (ADR-0024) — Accepted**. All 11 HARDEN tasks delivered (T1-T11 across Wave 1-4 commits). 3 post-review fixes: recycle-backoff Promise leak (`714f1e6`), Track 2 chunk leak (`b5c4bde`), T10 redundant if/else collapse (`12f7603`).

### Recent Quality Wins (since last handover)
- **v0.3.0 shipped** (2026-09-24) — durable queue + liveness/readiness probes. See §3 "Released".
- **Four benchmark-assertion defects fixed at the root** (2026-09-27/28) — each had a hard-coded threshold or sleep that encoded the benchmark author's machine instead of the behaviour under test. `broadcast-fanout` discarded 2000 `TaskHandle`s behind a fixed 200 ms sleep (unhandled rejection exited 1); `adaptive-controller-opt-out` gated on an unwarmed single p99 (scheduler noise, not a regression); `default-sizing-memory` required a ratio that only holds on a high-core-count host; `adaptive-controller-tick` measured without warmup. All four have issue files in `.agents/issues/`.
- **Two test-suite flakes fixed at the root** (2026-09-28) — `recycling.test.js` slept a fixed 200 ms for `worker_recycled`; now deadline-based polling. Note the same file already carried "bump to 200 ms to absorb CI timer noise" comments from an earlier flake — raising a sleep constant is the wrong fix, it only moves the cliff.
- **Spec hygiene** (2026-09-27) — all 13 features under `.specs/features/` validate **0 errors** on both `validate_spec.py` and `validate_tasks.py`. See `.agents/issues/003-spec-validation-drift.md`.
- **Large-file investigation** (2026-09-28) — measured the chunk-parallel vs NDJSON trade and the disk ceiling. Write-up in `research/` and `.agents/research/large-json-parsing.md`. Notably it **refuted** the NDJSON recommendation this repo had been carrying.
- **`lint-staged` broken for docs-only commits** (2026-09-27) — a `!*.skill-meta.json` negation matched every other file, so any commit touching only `.md` failed the pre-commit hook. Matcher now scoped to the code directories.
- **v0.2.0 → v0.2.1 promotion** — npm publish CI via `release.yml` (provenance + `id-token: write`).
- **Dependabot bumps merged** — `actions/setup-node` → 7.0.0, `actions/checkout` → 7.0.1.

### Documented but NOT YET Implemented
- **None blocking for single-instance deployments.** All documented ADRs (0010–0024) have shipped **in-scope** features in v0.2.0/0.2.1/0.3.0.
- **Multi-instance / production deployments still have deferred gaps** tracked in [DR plan §8](docs/operations/disaster-recovery.md#8-open-items-gaps-to-close). Current state: **§8.1** SIGTERM — recipe shipped as `examples/sigterm-drain.js`, still user-wired by design (ADR-0005). **§8.2** `/healthz` — **closed** via `isAlive()` / `isReady()`. **§8.3** OpenTelemetry and **§8.4** Postgres backend — **permanently out-of-scope by rule** (ADR-0005). **§8.5** chaos game day and **§8.6** cross-region snapshots — genuinely open, but deployment-side, not library work.

### Tracked work (`.agents/issues/`)
- **`001-supervisor-start-not-idempotent.md`** — ✅ FIXED (`5c4069c` + `205c384`).
- **`002-runtime-hardening-wave4-review.md`** — ✅ CLOSED (Findings 1+2 + Track 2 shipped in v0.2.0; Finding 3 doc note closed 2026-09-27).
- **`003-spec-validation-drift.md`** — ✅ FIXED 2026-09-27. All 13 features validate 0 errors on both `validate_spec.py` and `validate_tasks.py`.
- **`CI-FAILURE-macos-benchmarks.md`** — ✅ RESOLVED 2026-09-23 (platform-aware threshold in `cpu-saturation.benchmark.js`).
- **`CI-FAILURE-windows-broadcast-fanout.md`** — ✅ FIXED 2026-09-27. `broadcast-fanout` discarded 2000 `TaskHandle`s behind a fixed sleep; the unhandled rejection on `shutdown()` exited 1.
- **`CI-FAILURE-macos-adaptive-optout-noise.md`** — ✅ FIXED 2026-09-28. Single unwarmed p99 pass was scheduler noise; now warmup + best-of-5, gated on p50.
- **`CI-FAILURE-macos-default-sizing-hardware-calibration.md`** — ✅ FIXED 2026-09-28. Ratio threshold was calibrated to the author's 28-core host; now asserts marginal MB per worker.
- **`io-throughput-preempted-accounting.md`** — ✅ FIXED 2026-09-27. Now counts distinct terminal `taskId`s against `TOTAL_TASKS + 1`.

---

## 🚀 4. Exact Next Action for the New Chat

**Current state**: v0.3.0 shipped and published on npm. All feature ADRs complete. `develop` is green across the full 6-job CI matrix plus Linters and Coverage, and is ~40 commits ahead of `main`.

**Only remaining repo action**: decide whether to release the `develop` delta. It contains **no API changes** — 4 benchmark-assertion fixes, 2 test-flake fixes, 3 new examples, spec hygiene, and a `research/` directory. Both bumping to v0.4.0 and promoting `develop` → `main` are deliberate maintainer decisions, not library work. The maintainer has explicitly deferred the release; do not publish without being asked.

### Open follow-ups (in priority order)

1. **Release decision** — ⏸️ deferred by maintainer. `CHANGELOG.md` has a ready `[Unreleased]` section covering the whole delta. Path if resumed: bump `package.json` → CI green → promote `develop` → `main` → tag → `npm publish`.
2. **DR plan §8** — §8.2 `/healthz` closed; §8.3/§8.4 permanently out-of-scope by ADR-0005; §8.1 SIGTERM has a shipped recipe (`examples/sigterm-drain.js`) and stays user-wired by design. **§8.5** (chaos game day) and **§8.6** (cross-region snapshots) are genuinely open but **deployment-side, not library work** — they need a production deployment to exist first.
3. ~~`tasks.md` template migration~~ — ✅ DONE 2026-09-23; all 13 features now validate 0 errors on both validators (`.agents/issues/003-spec-validation-drift.md`).
4. ~~Spec-precision follow-ups~~ (`RECYCLE-08`, `PREEMPT-06`, `PREEMPT-08`) — ✅ all covered by existing tests in `test/recycling.test.js` and `test/preemption.test.js`.
5. ~~`gh auth refresh --scopes workflow`~~ — ✅ DONE 2026-09-23; token has `workflow`, so workflow-touching dependabot PRs can be merged with `gh pr merge` directly.

### Workflow for the next release

Per the branch rule in §2, releases are promoted from `develop` — do **not** cut a
`chore/release-*` branch off `main`. When the maintainer decides to release:

1. Confirm `develop` is green across the full matrix (CI + Linters + Coverage).
2. `npm version minor` (or `patch`) on `develop`; commit as `chore(release): v0.4.0`.
3. `git push origin develop`, wait for the matrix to go green on the release commit.
4. Promote `develop` → `main` (fast-forward; `main` is a strict ancestor).
5. Tag `main` — the tag triggers `release.yml` → npm publish with provenance.
6. GitHub release notes.

Everything before the tag is reversible. `npm publish` is not — confirm with the maintainer first.

---

## 🛠 5. Useful Verification Commands

```bash
# Tests + lint
npm test                     # 622 tests, 0 failed, 0 skipped
npm run lint                 # biome check (no auto-fix)
npm run lint:ci              # biome ci (CI strict mode; used by lint.yml)
npm run validate             # lint + test (used by pre-push, prepublish)

# Benchmarks — 24 gated scripts, all run in CI
npm run benchmark:all        # the full gated suite

# Research — usage-pattern investigations, NOT CI gates. See research/README.md.
# These need GB of temp disk and take 7-20 minutes. Do not add them to benchmark:all.
node research/parse-parallelism-probe.benchmark.js
PWR_SKIP_SWEEP=1 node research/parse-parallelism-probe.benchmark.js   # I/O section only
node research/json-strategy-compare.benchmark.js
PWR_SKIP_LARGE=1 node research/json-strategy-compare.benchmark.js     # 512 MB pass instead of 10 GB

# Spec validation — run BOTH validators over the whole tree when closing a feature
Get-ChildItem -Recurse -Filter spec.md .specs\features | ForEach-Object { py .agents/skills/tlc-spec-driven/scripts/validate_spec.py $_.FullName }
Get-ChildItem -Recurse -Filter tasks.md .specs\features | ForEach-Object { py .agents/skills/tlc-spec-driven/scripts/validate_tasks.py $_.FullName }

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

# Examples — all 12 [perf-tested] with measured metrics (`.agents/rules/perf-first-authoring.md`)
node examples/adaptive-concurrency.js          # auto vs fixed pool under CPU burst (23.22× speedup — controller grew 1→28)
node examples/broadcast-cache-invalidation.js  # cold vs warm cache reads (2.69× per warm hit, 25 ms cumulative saved)
node examples/cancel-on-disconnect.js          # cancel @100ms vs run-to-completion (~9800 ms worker time saved)
node examples/event-target-pattern.js          # 3 event observation patterns + addEventListener {signal} cleanup (1 vs N calls)
node examples/express-outbox-email.js          # dispatch vs sequential HTTP handler (76.41× HTTP path speedup)
node examples/image-resizer-batch.js           # worker pool keeps Event Loop responsive (27× more setInterval ticks during burst)
node examples/persistent-ai-model.js           # L1 cache vs rebuild every query (1.48× speedup, model loaded once)
node examples/priority-routing.js              # priority=10 vs priority=0 (30 slots earlier in completion log)
node examples/streaming-csv-export.js          # backpressure with slow consumer (rowsWritten + paused/resumed event counts)
node examples/streaming-llm.js                 # TTFT + signal abort + runtime event counts
node examples/worker-recycling.js              # per-cycle overhead = 263 ms avg (200 ms backoff + ~64 ms terminate)
node examples/zero-copy-image.js               # transferList vs structured-clone copy, 31 MB buffer (3.07× speedup)

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
