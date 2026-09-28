# CI: `adaptive-controller-opt-out` p99 parity assertion is scheduler-noise sensitive

**Status**: ✅ **FIXED** (2026-09-28) — measurement made reproducible (warmup + best-of-N) and a p50 assertion added as the load-bearing signal.

**Discovered**: 2026-09-28 while watching CI run `36414171679` on `develop`.
**Component**: `benchmarks/adaptive-controller-opt-out.benchmark.js` (Phase C-3)

## Symptom

`Test on Node 24.x (macos-latest)` failed; the other five matrix legs passed — including
`Node 22.x (macos-latest)` on the *same* runner image.

```
FAIL: disabled controller costs 2.15× the enabled one (budget: 2×).
VERDICT: at least one phase FAILED — see lines above.
```

`Run Unit Tests` passed, so the failure was isolated to the `benchmark:all` step.

## Why it was noise, not a regression

The measured values tell the story directly:

```
enabled:true   p50 = 0.024 ms   p99 = 0.035 ms
enabled:false  p50 = 0.024 ms   p99 = 0.075 ms
p99 ratio (disabled / enabled): 2.15x
```

**p50 is byte-identical between the two paths.** That is the decisive clue: the two controllers
run the exact same `sample` + `classify` + `debounce.note` body on every tick, differing only in a
fire handler that runs at most every `debounceTicks` ticks. A genuine "the opt-out path pays extra
work" regression — the thing this phase exists to catch — would move p50 too.

A p99 gap over 35 µs vs 75 µs is one OS preemption, not a per-tick cost. Both values are also far
inside the phase's other budget (`disabledResult.p99 < 5 ms`), so absolute cost was never a problem.

## Root cause

`measureTicks()` ran a single measured pass of 5 000 iterations with **no warmup**, timing each
iteration with a pair of `performance.now()` calls. At the ~30 µs scale:

- The first measured loop runs before the JIT has settled, so the *first* path measured is
  systematically penalised (or helped) relative to the second.
- A single p99 is the 99th percentile of one sample. At n = 5 000 that is the 50th-slowest
  iteration — a handful of scheduler preemptions is enough to move it by 2×, and which of the two
  loops absorbs them is down to OS scheduling luck.

So the assertion was measuring the runner's noise floor, not the controller.

## Resolution

**1. `measureTicksStable()` — warmup, then best-of-N p99:**

```js
function measureTicksStable(n, perTick, { rounds = 5, warmup = 2_000 } = {}) {
  for (let i = 0; i < warmup; i++) perTick();
  let best = null;
  for (let r = 0; r < rounds; r++) {
    const result = measureTicks(n, perTick);
    if (best === null || result.p99 < best.p99) best = result;
  }
  return best;
}
```

Taking the minimum p99 across rounds rejects outliers: a real cost difference appears in *every*
round, while a scheduling hiccup appears in at most one. Both paths now go through the identical
`makeCtrl(enabled)` factory so construction order cannot favour either.

**2. p50 became the load-bearing assertion, p99 kept for tail visibility:**

```js
if (p50Ratio > 1.5) { /* FAIL: opt-out path is doing extra work per tick */ }
if (ratio   > 2.0) { /* FAIL: tail outlier, and say so in the message */ }
```

p50 directly reflects per-tick work and is what the phase is actually for. The p99 message now
includes the p50 ratio so a future reader can tell a real regression from a tail event without
re-deriving it.

## Verification

Five consecutive local runs, all exit 0:

| Run | p99 ratio | p50 ratio |
| --- | --- | --- |
| 1 | 1.01× | 1.00× |
| 2 | 1.01× | 1.00× |
| 3 | 1.01× | 1.00× |
| 4 | 1.01× | 0.98× |
| 5 | 0.99× | 1.03× |

The 2.15× outlier is gone; the spread is now ~±2% instead of swinging past the 2× budget.

## Prevention

- **Never assert on a single p99 of a sub-100 µs operation.** Warm up, then take the best of
  several rounds. The tail percentile of one pass measures the OS scheduler, not the code.
- **Use p50 as the primary signal for "this path does more work"** questions, and keep p99 for
  reporting a tail. If p50 is identical but p99 differs, you are measuring jitter.
- **When a matrix leg fails alone, compare p50 across the paths before theorising about a
  regression.** An identical p50 with a divergent p99 is a near-certain noise diagnosis.
- **A missing warmup biases a sweep, not just a single measurement.** A follow-up audit of all 23
  benchmarks found `adaptive-controller-tick.benchmark.js` had the same unwarmed pass across a
  sweep of `{0, 1, 10}` listeners. Because the *first* configuration measured is systematically
  penalised, the 1-listener baseline was inflated and the scaling ratio looked artificially
  favourable — a permissive gate, not a flaky one, and just as wrong. Fixed in `ec49558` with the
  same `measureTicksStable` helper.
- `hot-path-micro.benchmark.js` was the control case: it already had a 1000-iteration warmup,
  consistent with it being the one benchmark wired into `npm run validate` and the one that never
  flaked.
- This is the same family as the other benchmark bugs fixed this week (see
  `io-throughput-preempted-accounting.md` and `CI-FAILURE-windows-broadcast-fanout.md`): a
  benchmark assertion that was not reproducible before it was made a gate.
