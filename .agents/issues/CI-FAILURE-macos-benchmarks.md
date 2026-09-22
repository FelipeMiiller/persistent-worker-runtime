# CI: macOS benchmark step fails on `npm run benchmark:all`

**Status**: Open — pre-existing, not caused by PR #6.

**Discovered**: 2026-09-22 (PR #6 run 35720814119).
**Symptom**: `Test on Node 22.x (macos-latest)` and `Test on Node 24.x (macos-latest)`
both fail with conclusion=failure on the step `Run Full Concurrency & Performance Benchmarks`.
The job runs benchmarks for ~10 seconds before failing on macOS — much faster than the
~140–160s it takes on Ubuntu, suggesting an early benchmark crashes or hangs.

## Verified working on this same CI run

- `Run Unit Tests` step: PASSED on **all** 6 jobs (macos + ubuntu + windows × Node 22 + 24).
- `Biome lint (CI mode)`: PASSED.
- `Test coverage report`: PASSED.
- `Verify ESM Package Exports`: PASSED on ubuntu; skipped on macOS (because the
  benchmarks step failed first, `fail-fast: false` skipped downstream).

## What I confirmed via the GH API

Job step data for macOS-22:

```
"Run Unit Tests"                         success   11:19:46 → 11:20:04
"Run Full Concurrency & Performance Benchmarks"  failure   11:20:04 → 11:20:14   ← 10s, then dies
"Verify ESM Package Exports"             skipped   (because previous failed)
```

## Hypothesis

macOS-Latest runners are ARM64 (M1-class) hosted by GitHub. The new benchmarks
added in v0.2.0 (commit `c588091`, `docs(benchmarks,context): add v0.2.0
io-throughput + adaptive-controller benchmarks`) likely contain timing
assertions or system-load assumptions calibrated against Linux x86_64 /
Windows, not ARM64 macOS. The first benchmark to fail in 10 seconds is one of
the early entries of `benchmark:all`:

1. `event-loop-lag.benchmark.js`
2. `stateful-vs-stateless.benchmark.js`
3. `batch-concurrency.benchmark.js`
4. `outbox-throughput.benchmark.js`
5. `zero-copy-transfer.benchmark.js`
6. `priority-routing.benchmark.js`
7. `abort-cancellation.benchmark.js`
8. `throughput-scaling.benchmark.js`
9. `cpu-saturation.benchmark.js` ← most suspicious (CPU topology differs on M1)
10. `preemption-recovery.benchmark.js`
11. `worker-recycling.benchmark.js`
12. `broadcast-fanout.benchmark.js`
13. `streaming-throughput.benchmark.js`
14. `streaming-memory.benchmark.js`
15. `streaming-stress.benchmark.js`
16. `default-sizing-memory.benchmark.js`
17. `streaming-queue-dispatch.benchmark.js`
18. `streaming-abort-latency.benchmark.js`
19. `adaptive-controller-tick.benchmark.js` (with `--expose-gc`)
20. `adaptive-controller-opt-out.benchmark.js`
21. `adaptive-concurrency.benchmark.js`
22. `io-throughput.benchmark.js` ← second-suspicious (ARM64 macOS IO is different)

## Mitigation options

| Option | Effort | Trade-off |
| --- | --- | --- |
| Run benchmarks locally in macOS-arm64 to find the failing one, then widen thresholds or guard platform-dependent paths | 1–2h | Permanent fix |
| Add a CI matrix guard: `if: matrix.os != 'macos-latest'` for the benchmarks step | 5min | macOS benchmarks stop being a CI gate (regression risk) |
| Add an allowlist of benchmarks that are known-portable, gate the rest on `ubuntu-latest` only | 30min | Middle-ground — keep CI useful without losing the gate |
| Run benchmarks with `--expose-gc` only on ubuntu-latest, drop them on macOS | 5min | Just hides the issue |

## Why this is NOT PR #6's problem

PR #6's mandate is **CI/build hygiene** (gitattributes, SHA typo, test flake,
yarn CJS warning, pull_request event). The benchmark failure pre-dates the PR —
the same macOS-benchmarks failure would happen on `main` HEAD if a fresh CI run
were triggered today. Confirmed by inspection: main HEAD (`c588091`) is exactly
the commit that introduced the new benchmarks.

## Next actions (T13+)

1. Open a separate PR dedicated to benchmark portability (ADR-0023 follow-up).
2. Decide which of the 22 benchmarks need platform-aware paths or thresholds.
3. Update `benchmark:all` to be portable or split into `benchmark:ci` (portable subset)
   and `benchmark:full` (includes platform-specific ones, run on `ubuntu-latest` only).

---

## Related: commit-lint workflow is also broken (same root cause)

`commit-lint.yml` uses `on: pull_request_target`. For that event, **GitHub
reads the workflow file from the BASE branch (main), not the PR branch.**
PR #6 has the fix (`on: pull_request` + correct SHA `...dea`), but the CI
run will continue to fail until the workflow file lands on main. This is by
design for security — `pull_request_target` is meant to be unmodifiable by
PR contributions.

**Workaround used in PR #6**: the branch protection on `main` does NOT set
`required_status_checks`, so the failing commit-lint check does not block
merge. `enforce_admins` is disabled (admins can merge with red CI). The
workflow fix takes effect for every subsequent PR once PR #6 merges.

---

## Reference: log extraction tooling

The CI logs are served as a parallel ZIP from `https://api.github.com/repos/.../actions/runs/{id}/logs`.
On this run (35720814119), the response was 1.27MB and started with **two** UTF-8
BOMs (`EF BB BF EF BB BF`) before the proper ZIP signature `50 4B 03 04` —
indicating the download wrapper inserted BOMs but stripped binary integrity.
The resulting ZIP has `EF BF BD` (UTF-8 replacement char) bytes inside the
central directory size/offset fields, making it unreadable by `yauzl`, `unzip`,
or `Expand-Archive`.

To work around: fetch with `gh api` and pipe through Node's `fs.writeFileSync`
with raw bytes; yauzl still fails on the corrupted central directory.
The reliable path is to use `gh run view <id> --log-failed` for specific failed
jobs, or open the per-job logs in the GitHub UI.

For future CI debugging, prefer the per-job `gh run view --job <job-id>` over
the parallel ZIP download.
