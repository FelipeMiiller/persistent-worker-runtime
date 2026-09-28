# CI: `default-sizing-memory` ratio assertion is calibrated to the author's hardware

**Status**: ✅ **FIXED** (2026-09-28) — assertion rewritten in hardware-independent terms.

**Discovered**: 2026-09-28 while watching CI run `36415949248` on `develop`.
**Component**: `benchmarks/default-sizing-memory.benchmark.js`

## Symptom

`Test on Node 22.x (macos-latest)` failed; the other five legs passed.

```
Phase A: default (ADR-0019) — workers = 1
  peak RSS: 62.5 MB
Phase B: legacy default — workers = 4
  peak RSS: 91.1 MB
  legacy - ADR-0019 = 28.6 MB saved
  ratio (legacy / new) = 1.46x
FAIL: ADR-0019 default not measurably cheaper (ratio 1.46x < 2x)
```

Note the direction was **correct** and the absolute saving was a healthy 28.6 MB. Only the ratio
missed the bar.

## Root cause: the ratio is a function of core count, but the threshold was a constant

The legacy pool size is `legacyCount = max(1, cores - 1)`, so the memory ratio scales with how
many threads the host can spawn:

| Host | legacy pool | extra workers | ratio |
| --- | --- | --- | --- |
| 28-core workstation (author's machine) | 27 | 26 | 5.8× |
| 4-core CI runner (this failure) | 3 | 2 | 1.46× |

A fixed `ratio >= 2` therefore encodes the benchmark author's hardware, not any property ADR-0019
asserts. The file's own docstring made this explicit — it claimed *"assert the new default is at
least 5× cheaper"* while the code required 2×, and *"On a 28-core host this typically lands between
5× and 20×"*. Both statements are only true on a 28-core host.

The docstring also contained a factual error: it said hosts with ≤ 4 cores make the legacy default
"fall back to 1 worker". It does not — `cores - 1 <= 1` only at `cores <= 2`. At 4 cores the legacy
pool is 3 workers, a perfectly measurable difference. The `if (cores <= 4)` guard was therefore
skipping a valid measurement.

## Resolution

The hardware-independent invariant is **marginal cost per worker thread** — each thread has a real
RSS cost, and avoiding that cost by default *is* ADR-0019. The assertion is now three checks:

1. **Direction** — `savingsMb > 0`. The new default must never cost more. This is the core claim
   and needs no threshold.
2. **Marginal cost** — `mbPerWorker >= 2.0`, i.e. `savings / (legacyCount - 1)`. Holds on a 4-core
   runner (9.5 MB/worker) and on a 28-core workstation (12.1 MB/worker).
3. **Absolute floor** — `savingsMb >= 5`, so a 2-worker pool cannot pass on arithmetic alone.

The ratio is still computed and printed, explicitly labelled as host-dependent and reported rather
than asserted. The failure messages state which invariant broke, so a future reader can tell a
real ADR regression from a threshold recalibration.

The degenerate-host guard was corrected to `legacyCount <= 1` (equivalently `cores <= 2`) with the
arithmetic spelled out.

## Verification

- Local (28 cores): 5.82× ratio, 12.1 MB/worker, 314.4 MB saved — exit 0.
- Replaying the exact CI numbers (62.5 MB vs 91.1 MB, 4 workers) through both gates:

| Gate | Result |
| --- | --- |
| Old (`ratio >= 2`) | ❌ **fails** — 1.46× |
| New (`>0` ∧ `mb/worker>=2` ∧ `>=5 MB`) | ✅ **passes** — 9.53 MB/worker, 28.6 MB |

The new gate still fails on a genuine regression: if the default ever costs *more*, or if worker
threads stop costing real memory, it exits 1.

## Prevention

- **A ratio between two independently-measured quantities is only a valid threshold if both
  quantities are hardware-independent.** Here the numerator's *denominator* (`legacyCount = cores-1`)
  varies by 10× between a laptop and a CI runner.
- When a benchmark's own comment states a number that disagrees with its code, both are suspect —
  the comment had drifted from the implementation across at least one threshold change.
- Cross-check threshold plausibility against the **smallest** machine in the CI matrix, not the
  machine the benchmark was written on. A developer workstation with 28 cores is the worst possible
  calibration target for a memory-scaling claim.
- The degenerate-case guard deserves the same scrutiny as the assertion: `cores <= 4` was skipping a
  valid measurement under a factually wrong justification.
