# CI: `adaptive-controller-opt-out` p99 parity assertion is scheduler-noise sensitive

**Status**: ✅ **REOPENED and RE-CLOSED** (2026-10-23) — the 2026-09-28 fix removed the JIT-warmup bias but left the **measurement-order bias** in place, and the p99-ratio gate was still a hard 2× while the file's own documentation already called p99 "reported for tail visibility". The second occurrence (CI run `39993041450`, commit `696a1e9`) failed on `Node 22.x (macos-latest)` and `Node 24.x (macos-latest)`; the phase now measures both paths interleaved with the order alternating per round and gates on the **minimum of the per-round ratios**.

**Discovered**: 2026-09-28 while watching CI run `36414171679` on `develop`.
**Reopened**: 2026-10-23 by CI run `39993041450` (commit `696a1e9`).
**Component**: `benchmarks/adaptive-controller-opt-out.benchmark.js` (Phase C-3)

## Occurrence 1 — 2026-09-28: warmup + best-of-N, p50 became the load-bearing signal

### Symptom

`Test on Node 24.x (macos-latest)` failed; the other five matrix legs passed — including
`Node 22.x (macos-latest)` on the *same* runner image.

```
FAIL: disabled controller costs 2.15× the enabled one (budget: 2×).
VERDICT: at least one phase FAILED — see lines above.
```

`Run Unit Tests` passed, so the failure was isolated to the `benchmark:all` step.

### Why it was noise, not a regression

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

### Root cause

`measureTicks()` ran a single measured pass of 5 000 iterations with **no warmup**, timing each
iteration with a pair of `performance.now()` calls. At the ~30 µs scale:

- The first measured loop runs before the JIT has settled, so the *first* path measured is
  systematically penalised (or helped) relative to the second.
- A single p99 is the 99th percentile of one sample. At n = 5 000 that is the 50th-slowest
  iteration — a handful of scheduler preemptions is enough to move it by 2×, and which of the two
  loops absorbs them is down to OS scheduling luck.

So the assertion was measuring the runner's noise floor, not the controller.

### Resolution

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

### Verification

Five consecutive local runs, all exit 0:

| Run | p99 ratio | p50 ratio |
| --- | --- | --- |
| 1 | 1.01× | 1.00× |
| 2 | 1.01× | 1.00× |
| 3 | 1.01× | 1.00× |
| 4 | 1.01× | 0.98× |
| 5 | 0.99× | 1.03× |

The 2.15× outlier is gone; the spread is now ~±2% instead of swinging past the 2× budget.

## Occurrence 2 — 2026-10-23: the measurement-ORDER bias survived the 2026-09-28 fix

### Symptom

CI run `39993041450` (commit `696a1e9`) went red in **two** legs — `Node 22.x (macos-latest)`
and `Node 24.x (macos-latest)` — and only in `benchmarks/adaptive-controller-opt-out.benchmark.js`
(Phase C-3). Ubuntu and Windows passed; macOS `26.x` passed. The unit tests passed on every leg.

```
FAIL: disabled controller costs 2.69× the enabled one on p99 (budget: 2×).
FAIL: disabled controller costs 4.01× the enabled one on p99 (budget: 2×).
```

### The four measurements

Same benchmark, same OS, same Node version — the previous green run `39983798286` against the
red run `39993041450`:

| leg | run | enabled p99 | disabled p99 | p99 ratio | p50 ratio |
| --- | --- | --- | --- | --- | --- |
| 24.x macOS | green `39983798286` | 0.032 ms | 0.037 ms | **1.19×** | 0.98× |
| 22.x macOS | green `39983798286` | 0.031 ms | 0.038 ms | **1.22×** | 1.00× |
| 24.x macOS | red `39993041450` | 0.029 ms | 0.077 ms | **2.69×** | 1.05× |
| 22.x macOS | red `39993041450` | 0.032 ms | 0.130 ms | **4.01×** | 1.00× |

Three facts fall out of that table:

1. **The p50 is practically identical in all four measurements** (0.98×–1.05×). The cost per tick
   is the same — which is exactly what Phase C-3 exists to prove.
2. **The `enabled` path's own p99 never moved** (0.029–0.032 ms). Only the `disabled` tail
   inflated, and only when the runner was busy.
3. The unit tests passed everywhere, so the runtime was not the problem.

### Root cause: measurement-order bias

The phase measured the `enabled` path **to completion** and then the `disabled` path **to
completion** (old lines 271-275). The second path was therefore always measured on a process that
had already grown its heap / semi-space and had already produced the 25 000+ samples of the first
path, so the second path's tail absorbed the GC and preemption cost that the first path did not
absorb.

An aggravating factor arrived with the same CI run: in `.github/workflows/ci.yml` the
`Run Examples` step ran **before** `Run Full Concurrency & Performance Benchmarks`. Those are 20
example scripts, each opening worker threads, and the p99-sensitive benchmark ran immediately
after them on a 3-core macOS runner.

### Why best-of-N per path could not fix it

`measureTicksStable()` takes the minimum p99 of each path **separately** and only then divides.
That rejects a noise event *within* one path, but it does not remove the order bias: the first
path is still measured under cleaner conditions than the second one. So the minimum of the first
path is systematically lower than the minimum of the second path, and the quotient inherits the
gap. A real cost difference shows up in every round; a GC/preemption event shows up in at most one
— but the *order* was fixed, so the event always landed on the same side of the division.

There was also a contradiction inside the benchmark itself. The comment on old lines 294-299 said
*"p50 is the load-bearing signal here… p99 is reported for tail visibility but a single p99 ratio
is scheduler-noise sensitive at the ~35us scale"* — while the code on old lines 308-314 **still
failed the build** whenever the p99 ratio passed 2×. The 2026-09-28 resolution recorded "p50
became the load-bearing assertion, p99 kept for tail visibility"; the documented intent and the
implementation had diverged.

### Not an ADR-0025 regression

Worth stating explicitly, because the red run landed right after the ADR-0025 dispatch-contract
change (`20b3564`):

- The controller's `tick()` dispatches **no task**. It samples two Event Loop signals, feeds two
  EWMAs, classifies the direction and notes it on the debounce counter. It never touches the
  dispatch path.
- The `enabled` path — which does strictly **more** work per tick, because its debounced fire
  handler can allocate and invoke the spawn/retire callbacks — did not move at all: its p99 stayed
  at 0.029–0.032 ms across the green and the red runs.
- A real per-tick cost regression moves the p50 of **both** paths. Here the p50 ratio was
  0.98×–1.05× in all four measurements.

So the runtime was not regressing; the measurement was moving.

### Resolution

**1. Interleaved measurement with the order alternating per round.** Both paths are warmed up
explicitly (interleaved) before any measured round, then every round measures **both** paths —
even rounds measure `enabled` first, odd rounds measure `disabled` first. An even round count (6)
keeps the two orders exactly balanced, so no path is systematically the second one.

```js
const enabledFirst = r % 2 === 0;
const first = measureTicks(n, enabledFirst ? paths.enabled : paths.disabled);
const second = measureTicks(n, enabledFirst ? paths.disabled : paths.enabled);
```

**2. The gate uses the MINIMUM of the per-round ratios.** A real per-tick cost regression shows
up in **every** round, so the minimum still denounces it; a GC/preemption event shows up in **at
most one** round, so the minimum discards it.

**3. The ADR-0014 absolute budget** (`disabled p99 < 5 ms`) now uses the **smallest p99 observed on
the `disabled` path** across the rounds, so one noisy round cannot trip it while a regression
visible in every round still does.

**4. The p99-ratio budget became noise-aware: 5×** (was 2×), with the four measurements above
documented in the code comment. The p50 ratio keeps its 1.5× budget and remains the load-bearing
gate; the ADR-0014 absolute budget is untouched. The success message no longer claims "within 2×".

**5. The phase prints the dispersion** — every round's ratio, not only the minimum the gate uses —
plus the round count and the minimum that was selected.

**6. CI hygiene:** `Run Examples` now runs **after** `Run Full Concurrency & Performance
Benchmarks` in `.github/workflows/ci.yml`, so the hot-path measurements do not inherit the
residual load of 20 worker-thread scripts. The order of the steps does not change what each gate
verifies.

### Verification

Five consecutive local runs (Windows, Node v24.16.0), all exit 0:

| Run | min p99 ratio | min p50 ratio | min disabled p99 |
| --- | --- | --- | --- |
| 1 | 0.90× | 1.00× | 0.055 ms |
| 2 | 0.51× | 0.99× | 0.049 ms |
| 3 | 0.99× | 1.00× | 0.054 ms |
| 4 | 0.90× | 1.00× | 0.050 ms |
| 5 | 0.98× | 0.96× | 0.050 ms |

Run 2 is a good illustration of the new behaviour: its round 6 was a noisy one (p50 ratio 1.28×,
p99 ratio 1.35× — a GC/preemption event), and the minimum over the six rounds (0.51×) discarded
it, exactly as intended.

**Non-vacuity proof.** A deliberate regression was injected into the `disabled` path — 30 000
iterations of extra arithmetic per tick, roughly 2× the measured per-tick cost — and the phase
failed as it must:

```
  min p99 ratio (disabled / enabled): 1.38x  (minimum of 6 rounds, noise-aware budget 5.00x)
  min p50 ratio (disabled / enabled): 4.59x  (minimum of 6 rounds, load-bearing budget 1.50x)
  FAIL: disabled controller costs 4.59× the enabled one on p50 (budget: 1.5×) — the opt-out path is doing extra work per tick.
VERDICT: at least one phase FAILED — see lines above.
```

Exit code **1**. The p50 gate — the load-bearing one — caught it, while the p99 ratio (1.38×) was
still inside its 5× budget, so the failure message is unambiguous. Restoring the file made the
phase pass again with exit code **0** (p50 ratio 0.99×, p99 ratio 0.90×). The minimum-over-rounds
statistic therefore does **not** mask a real regression: 4.59× is what survived the minimum.

**Order-independence probe.** A scratch harness measured the same two paths under four policies —
the legacy best-of-N algorithm, `always-first`, `always-second`, and the new `alternating` — on an
idle machine and on a saturated one (27 spinning worker threads, to emulate the contended CI
runner):

| policy | idle per-round p99 ratios | idle mean | loaded per-round p99 ratios | loaded mean |
| --- | --- | --- | --- | --- |
| legacy best-of-N (old) | 0.97 | 0.97× | 0.70 | 0.70× |
| always `enabled` first | 1.90 0.45 0.98 1.01 1.02 0.71 | 1.01× | 3.85 0.48 3.63 1.42 0.91 1.26 | 1.93× |
| always `disabled` first | 1.21 1.38 1.67 0.66 0.99 1.36 | 1.21× | 0.41 1.27 1.22 0.45 1.18 1.56 | 1.01× |
| **alternating (new)** | 1.01 0.96 1.00 0.98 1.04 0.98 | **1.00×** | 0.83 1.64 0.51 0.94 0.95 0.90 | **0.96×** |

Three things fall out of it:

- A single round under load can reach **3.85×** — well past the old 2× budget. That is the noise
  the old gate was catching (and failing on).
- The alternating design's per-round ratios **straddle 1.0** in both conditions, so the order
  component alternates in sign between rounds and cancels in the aggregate.
- Its aggregate is **not** the midpoint of the two forced-order aggregates. Loaded: alternating
  0.96× vs the forced-order midpoint 1.47× (34.4% below). Idle: alternating 1.00× vs midpoint
  1.11× (10.4% below). The alternating number is therefore not "the always-first number" or "the
  always-second number" — it is the balanced mix, which is what order-independence means here.

Note that the direction of the order bias is **environment-dependent**: on the contended CI runner
the second-measured path was the expensive one (matching the red run), while on an idle machine the
first-measured path absorbs the JIT/heap-growth cost. Either way it is an artefact of the
measurement, which is exactly why a tight p99-ratio parity budget cannot be a gate.

## Prevention

- **Never assert on a single p99 of a sub-100 µs operation.** Warm up, then take the best of
  several rounds. The tail percentile of one pass measures the OS scheduler, not the code.
- **Use p50 as the primary signal for "this path does more work" questions**, and keep p99 for
  reporting a tail. If p50 is identical but p99 differs, you are measuring jitter.
- **When a matrix leg fails alone, compare p50 across the paths before theorising about a
  regression.** An identical p50 with a divergent p99 is a near-certain noise diagnosis.
- **Measure the two paths of a comparison inside the same round, and alternate the order.**
  Measuring path A to completion and then path B makes the *order* a permanent, invisible
  variable in the ratio. Per-path best-of-N does not remove it: the minimum of the first path is
  still measured under cleaner conditions than the minimum of the second.
- **Take the minimum of the per-round RATIOS, not the ratio of the per-path minima.** A real
  regression appears in every round; a GC/preemption event appears in at most one. That asymmetry
  is what makes the minimum the right statistic — and it must be verified with a deliberately
  injected regression, because a gate that has never failed is not a gate.
- **Keep the documented intent and the implementation in sync.** The 2026-09-28 comment already
  said p99 was "reported for tail visibility", but the code still failed the build on a 2× p99
  ratio. When a resolution says a signal becomes informational, the gate that enforces it has to
  go.
- **A missing warmup biases a sweep, not just a single measurement.** A follow-up audit of all 23
  benchmarks found `adaptive-controller-tick.benchmark.js` had the same unwarmed pass across a
  sweep of `{0, 1, 10}` listeners. Because the *first* configuration measured is systematically
  penalised, the 1-listener baseline was inflated and the scaling ratio looked artificially
  favourable — a permissive gate, not a flaky one, and just as wrong. Fixed in `ec49558` with the
  same `measureTicksStable` helper.
- `hot-path-micro.benchmark.js` was the control case: it already had a 1000-iteration warmup,
  consistent with it being the one benchmark wired into `npm run validate` and the one that never
  flaked.
- **Do not let a load-generating step run immediately before a tail-sensitive benchmark.** The
  20 example scripts open worker threads; on a 3-core runner their residue deformed the
  measurement. The step order in `.github/workflows/ci.yml` is now benchmarks → examples.
- This is the same family as the other benchmark bugs fixed this week (see
  `io-throughput-preempted-accounting.md` and `CI-FAILURE-windows-broadcast-fanout.md`): a
  benchmark assertion that was not reproducible before it was made a gate.
