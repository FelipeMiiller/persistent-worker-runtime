# CI: `cpu-saturation` E-1 saturation gate compares the wrong worker pair

**Status**: ✅ **FIXED** 2026-10-23 — commit `91934f0` ("fix(bench): assert the CPU-saturation knee
instead of the two largest worker counts").

**Discovered**: 2026-10-23, CI run `40036815752`, `Test on Node 24.x (macos-latest)`.
**Component**: `benchmarks/cpu-saturation.benchmark.js` (Phase E-1)

## Symptom

`Run Full Concurrency & Performance Benchmarks` failed on one leg only. Unit tests passed on
every leg.

```
workers=  1:     810ms ->    2470 tasks/sec
workers=  2:     397ms ->    5037 tasks/sec
workers=  4:     470ms ->    4258 tasks/sec
workers=  8:     436ms ->    4589 tasks/sec
workers= 16:     276ms ->    7237 tasks/sec
workers=  3:     233ms ->    8590 tasks/sec
E-1 FAIL: throughput did not plateau at cores — investigate.
```

## The decisive fact: the two macOS legs of the SAME run had different core counts

GitHub's `macos-latest` ARM64 runners are **not** uniform. Within run `40036815752`:

| leg | `availableParallelism()` | sweep | gate pair | ratio | outcome |
| --- | --- | --- | --- | --- | --- |
| `Node 22.x (macos-latest)` | **5** | `[1,2,4,8,16,5]` | (16, 8) | **1.05×** | PASS |
| `Node 24.x (macos-latest)` | **3** | `[1,2,4,8,16,3]` | (16, 8) | **1.58×** | FAIL |
| `Node 26.x (macos-latest)` | 5 | `[1,2,4,8,16,5]` | (16, 8) | 1.05× | PASS |

Same benchmark, same runner image, same assertion — **1.05× and 1.58×**. The only difference
between the legs is the number of cores the runner happened to report.

## Root cause 1 — the gate compares the two LARGEST sweep entries, not the knee

```js
const sortedCounts = [...WORKER_COUNTS].sort((a, b) => a - b);
const maxW  = sortedCounts[sortedCounts.length - 1];   // 16
const halfW = sortedCounts[sortedCounts.length - 2];   // 8
const satRatio = fullCpu.throughput / halfCpu.throughput;
```

On a 3-core host, 8 workers is 2.7× oversubscription and 16 workers is 5.3× — **both are past
the knee**, so the true ratio is ≈1.0 *by construction*. The gate was therefore measuring the
runner's scheduling noise with a 1.5× budget, not the saturation rule.

The raw numbers show the noise directly: `workers=8` took 436 ms while `workers=16` took 276 ms —
a 58% swing between two configurations that are both fully saturated.

On the 5-core runner the same pair happened to land at 1.05×, so the gate passed. The assertion
was a coin flip whose outcome was decided by the runner's core count.

## Root cause 2 — one measurement per configuration, in a fixed order, with no warmup

`measureWorkload()` is called exactly once per worker count, always in the same order, and the
sweep **ends with `CORES`** — so the configuration that represents the host's core count is
always the last one measured, on the most mature process.

Measured on the local 28-core host (Windows, Node 24):

```
workers=  1:    1021ms ->    1960 tasks/sec   <-- measured FIRST (cold process)
workers=  2:     431ms ->    4640 tasks/sec   <-- "118.4% efficient" — impossible without bias
workers=  4:     226ms ->    8860 tasks/sec
```

With 28 cores, 2 workers should take ~510 ms and took 431 ms: the 1-worker baseline is inflated
by ~20% because it was measured first. The same mechanism inflated the CI run's `workers=16`
(276 ms, measured second-to-last) against `workers=8` (436 ms, measured earlier).

This is the same measurement-order bias that was removed from
`adaptive-controller-opt-out.benchmark.js` in `c82172b` — and that fix is confirmed working:
the `macos-latest` legs of run `40036815752` all passed the opt-out benchmark.

## Root cause 3 — the success message is false on large hosts

On the local 28-core host the benchmark prints:

```
✓ saturation confirmed at ~20 workers (extra -0% from doubling past saturation; host cores=28)
```

**Nothing saturated.** The host has 28 cores and the sweep never reaches 28 — `CORES` is capped by
`MAX_WORKERS = 20`, so the sweep is `[1,2,4,8,16,20]` and the "saturation" pair (16, 20) is two
*under-saturated* configurations. The benchmark asserts a knee it never measured, and the printed
conclusion is factually wrong. `BENCHMARKS.md` §1️⃣8️⃣ repeats the same claim for a 28-core host.

## Resolution (shipped in `91934f0`)

1. **Knee pair.** The gate became `tput(2×CORES) / tput(CORES)` — "doubling workers past the
   core count must not scale CPU-bound throughput". The discriminating power is why the *adjacent*
   pair is not acceptable: with the knee at `CORES` the ratio is ≈1.0, with the knee wrongly at
   `2×CORES` it is ≈2.0, and a 1.5× budget separates the two. With an adjacent pair (3→4) the
   ratio would only reach 1.33 even with no saturation at all — the gate would not discriminate.
2. **`CORES` and `2×CORES` join the sweep**, sorted ascending, so the measurement order is
   deterministic and the `CORES` configuration is no longer always measured last.
3. **Repeated, rotated, median.** E-1 runs 4 rounds over the same sweep, rotating the sweep order
   by one position per round **and alternating its direction per round**, and asserts on the
   **median** across rounds. Median, not maximum: the gate is a ratio between two quantities, and
   taking the maximum on both sides *increases* the variance of the ratio.
   The direction alternation is not optional — see the measurement below.
4. **A discarded warmup sweep** with a reduced task count, so the process cold start is not
   charged to the first configuration measured.
5. **Honest output.** When `2×CORES > MAX_WORKERS` the knee is beyond the measurable range: the
   benchmark prints that the assertion is *not measurable on this host* and skips the hard gate —
   it no longer claims "saturation confirmed" for a knee it did not measure. E-2 (the I/O control)
   keeps its assertion with the (8, 16) doubling pair, which is always in the sweep.

### Evidence

**The CI flake reproduced locally.** The *old, shipped* code was run 10× in fresh processes on the
same pair shape (16/8), on a host whose true ratio for that pair is ≈1.12×:

```
old: n=10  min=0.8502  max=1.8827  spread=1.0325  median=1.0952  mean=1.1688
old run 7/10: ratio(16/8)=1.8827   <-- through the 1.5x budget: FAIL
```

The *new* code, same protocol, 8 fresh runs:

```
new: n=8   min=1.0398  max=1.3029  spread=0.2630  median=1.1841  mean=1.1920
```

Spread **1.0325 → 0.2630** (3.9× tighter); the new method's worst of 8 runs stayed 13% below the
budget, while the old method's worst exceeded it. Per-run cost of the E-1 phase: 3.0 s → 11.7 s;
total benchmark 67.1 s → 77.1 s.

**Why rotation alone is not enough.** A variant harness (6 methods × 8 repetitions, method order
rotated per repetition to kill the process-warmth confound) measured the *centre* of the ratio:

```
oldOrderSensitivity (oldAscendingMean vs oldDescendingMean): 0.133   <-- 13.3%
plainVsFlipped (new method, direction convention flipped):     0.040   <-- 4.0%
rotOnlyVsTruth (rotation only, no direction alternation):       0.071   <-- 7.1%
```

Rotation by itself leaves the two members of the pair in a fixed relative order, so the
"measured later = faster" effect stays *systematic* inside the ratio — and a systematic bias is
not removed by any order statistic. Alternating the direction inverts the pair's relative order
between rounds, which cancels it. That is the same lesson as the opt-out fix in `c82172b`.

**Non-vacuity (gate is load-bearing).** With `CORES` forged to 1 — so the knee pair becomes (1, 2),
a pair that genuinely scales — the gate fires:

```
knee pair (CORES→2×CORES): 1→2 workers
per-round knee ratios: 2.40× | 2.36× | 2.34× | 2.36×   spread 0.06
saturation ratio (2/1): 2.36×   (budget ≤1.5×, host cores=1)
E-1 FAIL: throughput did not plateau at cores — 2.36× > 1.5× budget at 1→2 workers
EXIT_CODE=1
```

Verified independently by the parent agent (same forged input, same exit code 1, ratio 2.36×).

**Known limit — the cancellation is not exact.** The direction alternation moves the pair across
the sweep between rounds, but whether the pair's relative order flips in a given round depends
on where the pair sits. On the sweep a 3-core CI runner produces (`[1,2,3,4,6,8,16]`, pair 3→6)
the balance is **3 rounds "low first" against 1 "high first"**, leaving the high member on
average 1.75 positions later than the low one — a residual that inflates the ratio by a few
percent (≈4% measured on a 28-core host). Against a budget with ~50% of headroom it cannot flip
the assertion in either direction, so it was left in place rather than churning a
measured-good design; the code comment says so explicitly, and names the fix if the gate ever
needs an exact one (measure the pair adjacently with mirrored slots).


## Prevention

- **A saturation test must compare across the knee, not across the top of the sweep.** Comparing
  two already-oversubscribed configurations asserts a property of the runner, not of the runtime.
- **The host's core count is an input to the assertion, not just a label.** Two CI legs of the
  same run reported 3 and 5 cores; any threshold calibrated on one of them is calibrated on
  noise. Assert on a quantity that is invariant to the host's core count.
- **A sweep that ends with the interesting configuration measures it on the warmest process.**
  Put the interesting configuration in the middle, or rotate the order.
- **"Saturation confirmed" must only print when a saturation was actually measured.** A benchmark
  that reports a knee it never reached is worse than one that reports nothing.
- This is the third member of the same family already tracked in
  `CI-FAILURE-macos-adaptive-optout-noise.md` and `io-throughput-preempted-accounting.md`: a
  benchmark assertion that was not reproducible before it was made a gate.
