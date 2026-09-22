---
title: "Cross-OS Lessons (CI timing, benchmark hardening, flaky test heuristics)"
category: lessons
scope: cross-cutting
audience: AI agents + humans writing benchmarks, integration tests, or CI infra
---

# Cross-OS Lessons

Heuristics, anti-patterns, and re-usable fixes captured from real CI flakes on the
`persistent-worker-runtime` matrix (ubuntu-latest, windows-latest, macos-latest × Node
22.x / 24.x). Apply these when writing or reviewing **any** benchmark, timing-sensitive
integration test, or CI script that depends on host-relative assumptions.

This doc is consultive, not normative — read it when the next `CI failed on macOS only`
or `test passes locally but flakes in CI` lands in front of you. The patterns here have
all been hit at least once in the live tree.

## 1. CI host resources are smaller than you think

The `macos-latest` GitHub Actions runner reports `availableParallelism() === 3` in late
2026. `ubuntu-latest` (M2 runners, Ubuntu 26 starting Oct 2026) and `windows-latest`
report higher core counts, but **never assume the benchmark host has the same core
count as your dev box or any other CI target**.

Symptoms in CI:

- `WORKER_COUNTS = [1, 2, 4, 8, X, min(MAX_WORKERS, CORES)]` arrays get sorted in
  unexpected ways. The last entry (`min(MAX_WORKERS, CORES)`) can be **smaller** than
  the second-to-last (`X`), breaking code that picks extrema by index.
- Build / install steps slow to ~3-5× local timings because the runner shares
  hardware with other tenants.

**Heuristic:** any array you build by `append + filter(unique)` for a sweep — sort
ascending before picking the tail entries. Don't trust that the last element is the
largest. Source-of-truth fix in `benchmarks/cpu-saturation.benchmark.js` (commit
`ddcd33f`).

```js
// ❌ Bad — assumes last entry is largest
const maxW = WORKER_COUNTS[WORKER_COUNTS.length - 1];
const halfW = WORKER_COUNTS[WORKER_COUNTS.length - 2];

// ✅ Good — explicit ordering
const sortedCounts = [...WORKER_COUNTS].sort((a, b) => a - b);
const maxW = sortedCounts[sortedCounts.length - 1];
const halfW = sortedCounts[sortedCounts.length - 2];
```

## 2. Windows CI is the slowest runner for event-loop saturation

`setImmediate`-chained busy loops produce near-100% event-loop utilization on Linux
and macOS runners (~0.9 ELU). On **Windows Node 22.x GitHub Actions runners**, raw
ELU samples hover closer to 0.8 because the event loop has higher fixed overhead
under the Windows VM. With `α=0.3` EWMA, the smoothed signal needs 1-2 more ticks to
cross any given shrink/grow threshold.

Symptoms in CI:

- Integration tests that pass locally and on Linux/macOS runners flake on Windows
  Node 22.x because a debounce window doesn't accumulate 5 consecutive samples of
  the expected direction.
- `setInterval`-based busy loops are worse than `setImmediate` chains on every
  runner (setInterval callbacks coalesce when the loop is busy) but the gap is
  smaller on Linux/macOS.

**Heuristic:** for any test that needs to drive the main-thread event loop to
saturation, use a `setImmediate` chain (not `setInterval`) AND add 1.0-1.5s of
headroom above the calculated minimum. Minimum shrink debounce window on
`α=0.3` EWMA at 100ms cadence is ~900ms (5 ticks + EWMA convergence + retire drain);
**use 2500ms wait, not 1500ms**, in any integration test that depends on
`runtime.stats.adaptive.lastResizeReason === 'shrink'` firing under load.

Concrete shape from `test/adaptive-concurrency-runtime.test.js` (commit `daedaf6`):

```js
const busyTimer = setImmediate(function busyTick() {
  const burstStart = Date.now();
  while (Date.now() - burstStart < BURST_MS) {
    for (let i = 0; i < 1e6; i++) _acc += i;
  }
  if (busyLoopActive) setImmediate(busyTick);
});

try {
  // 2500ms, not 1500ms — Windows CI Node 22.x needs the headroom.
  await new Promise((r) => setTimeout(r, 2500));
} finally {
  busyLoopActive = false;
}
```

## 3. `availableParallelism()` is not portable for benchmark thresholds

Don't use `availableParallelism()` directly as the upper bound of a benchmark sweep
without capping it. Two reasons:

1. **CI runners may report surprisingly small numbers** (3 on macOS-latest, see #1).
2. **The CPU-saturation rule** the benchmark exists to demonstrate empirically is
   `workers = nproc` — capping the sweep at the actual cores under test makes the
   benchmark produce useful empirical data instead of "saturation already passed
   by the time we started measuring".

Always cap at a `MAX_WORKERS` constant (currently 20) AND validate that the sweep
hits at least the smallest useful scenario (workers = `min(MAX_WORKERS, CORES)`).

## 4. macOS Apple Silicon runner: scheduled-task latency is non-deterministic

`setImmediate`-chained busy loops on macOS-latest show mild jitter (5-15% variance
between consecutive CI runs). The same loop on Windows Node 22.x shows severe jitter
(30-50%). If a benchmark asserts a strict ratio (e.g. `ioRatio >= 1.15×`), even a
well-designed busy loop can land below threshold on a single unlucky CI run.

Heuristic for ratio-based assertions in benchmarks:

- Assert **strict lower bounds**, never `===`. Use thresholds like `>= 1.15×` not
  `=== 2.0×`.
- Re-run CI when a benchmark fails — flaky on the **first** run but stable on the
  **second** is the macOS pattern.
- Investigate when the **same** benchmark fails twice in a row on the **same**
  host — that's a real bug, not jitter (see #5 for the original E-2 ratio
  inversion that produced `0.18×`).

## 5. Sort-before-extrema is the only safe pattern for array selection

Re-stating lesson #1 with the exact failure mode:

```js
// The original bug:
const WORKER_COUNTS = [
  1, 2, 4, 8,
  Math.min(MAX_WORKERS, Math.max(16, Math.floor(CORES / 2))),  // e.g. 16
  Math.min(MAX_WORKERS, CORES),                                  // e.g. 3 (on macOS CI)
].filter((v, i, a) => a.indexOf(v) === i);
// On macOS CI: [1, 2, 4, 8, 16, 3]
// Picking last/second-to-last gave maxW=3, halfW=16
// ioRatio = 3-worker tput / 16-worker tput = 0.18×
// → benchmark reported a "runtime bottleneck" that didn't exist.
```

The same anti-pattern shows up in any code that does:

- `pick max(arr)` after `arr.push(conditional_small_value)`
- `sliding window over a circular buffer that wasn't sorted`
- `binary search on a partially-sorted array`

**Heuristic:** if an array is built conditionally and then has extrema selected from
it, sort it. The cost of `[...arr].sort((a, b) => a - b)` on a 6-1000 element array
is negligible compared to the cost of a wrong-by-one ratio.

## 6. macOS runner: don't be fooled by a one-off PASS on a flaky benchmark

The CI history for the cpu-saturation benchmark shows a clear pattern:

- 10 consecutive CI runs on `linux/ubuntu/windows` × `Node 22/24`: all green.
- 2 consecutive runs on `macos-latest` × `Node 22/24`: both failed with
  `ioRatio = 0.17×` and `0.18×`.

When this pattern appears (one OS flakes consistently while others pass), the
failure is **not random jitter** — there is a bug in the test that happens to
manifest on the OS where the bug condition triggers. **Always investigate the
common thread between failing runs** (worker counts shape, sampling cadence, ELU
distribution) before assuming "CI is flaky, retry".

For this codebase specifically, the cpu-saturation E-2 bug was triggered by the
host reporting `CORES = 3` — a code path that 16+ core hosts never exercised.

## 7. Git autocrlf + Biome formatter: brittle under Windows

This is project-specific but high-yield:

```sh
warning: in the working copy of 'src/foo.js', LF will be replaced by CRLF
         the next time Git touches it
```

Under `core.autocrlf = true` (Windows default), `git checkout <file>` rewrites
LF → CRLF in the working copy. Biome's formatter rejects the resulting mixed
endings and emits `× Some errors were emitted`. Same hazard appears with
`git stash pop`, `git reset --hard`, etc.

**Fix (Windows, autocrlf=true):**

```powershell
$content = [System.IO.File]::ReadAllText('src/foo.js').Replace("`r`n", "`n")
[System.IO.File]::WriteAllText('src/foo.js', $content, [System.Text.UTF8Encoding]::new($false))
```

The `[System.Text.UTF8Encoding]::new($false)` is critical — `Set-Content -Encoding
UTF8` adds a BOM, which biome rejects as a separate failure mode. `[IO.File]::WriteAllText`
with explicit `UTF8Encoding($false)` writes UTF-8 without BOM.

**Heuristic:** any session that touches tracked files on Windows should normalize
LF endings after every `git checkout`/`git reset` that touches a previously
edited file. Source-of-truth fix in
`.specs/features/adaptive-concurrency/completion-checklist.md` (lesson section,
commit `bcc17bc`).

## 8. Bumping CI timing budget is cheaper than rewriting the test

When a benchmark or integration test flakes on one CI host but passes locally and
on the others, **first try doubling the timing budget** before rewriting the
test. Most flakes are timing-sensitive, not correctness bugs. Cheaper path:

1. Bump the wait from 1500ms to 2500ms (1.6s of headroom above the calculated
   ~900ms minimum).
2. Re-run the CI 5+ times. If it still flakes, then investigate the test logic.
3. Document the bump in the test comment so future readers know the budget is
   deliberate, not lazy.

Source-of-truth fix: `test/adaptive-concurrency-runtime.test.js` Phase 2 wait
bump from 1500ms to 2500ms in commit `daedaf6`.

## 9. Pre-commit hook failures vs. CI failures: different observability

The pre-commit hook (`npx lint-staged` + `npm test`) runs locally with whatever
hardware you're on. If a test passes locally and the pre-commit hook succeeds, the
**only remaining signal is CI** — which has its own hardware, its own runner
sharing, and its own scheduling jitter.

**Don't trust local-only validation for CI-sensitive tests.** The two failure
modes fixed in this session (E-2 WORKER_COUNTS shape, T9 P1+P2 Phase 2 timing) both
passed the pre-commit hook on the 28-core local Windows dev box and only surfaced
on `macos-latest` and `windows-latest` CI runners respectively. The pre-commit
hook can't catch what only CI sees.

**Heuristic:** for any new benchmark or timing-sensitive integration test, push
the commit and **read the full CI matrix** before declaring it done. Local
green ≠ CI green.

## 10. `gh run rerun --failed` does NOT replay the existing run

`gh run rerun <run-id> --failed` creates a **new** run record and triggers only the
failed jobs. The existing run's conclusion stays as `failure` until the new run
finishes. Both records exist in `gh run list`. This is documented behavior but
counterintuitive — when investigating "is this flake stable?", look at the
**most recent** run for that head SHA, not the run you initially triggered.

---

## Index by date / source commit

| Date | Commit | OS host | Lesson |
|---|---|---|---|
| 2026-09-19 | `ddcd33f` | macOS CI Node 22/24 | #1, #5, #6 — WORKER_COUNTS shape inversion |
| 2026-09-19 | `daedaf6` | Windows CI Node 22 | #2, #8 — Phase 2 timing flake, bump 1500→2500ms |
| 2026-09-19 | `bcc17bc` | local + Windows | #7 — CRLF/LF drift on `git checkout` |

When a future agent adds a benchmark or timing-sensitive test, read sections 1, 2,
5, 6, 9 first. When a CI matrix shows "1 OS fails, others pass", read section 4
before assuming jitter.
