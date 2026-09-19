# ADR-0023: `WORKER_CONCURRENCY` Env Var + `concurrency: 'auto'` Sizing Policy

- **Date**: 2026-09-18
- **Status**: Accepted
- **Deciders**: Mavis (assistant) + Felipe (maintainer)
- **Tags**: architecture, sizing, deployment, defaults

## Context and Problem Statement

The runtime currently has two competing sizing defaults:

1. **`WorkerRuntime` defaults to `workers: 1`** (ADR-0019), citing the conservative cost of V8 isolates (~30-50 MB RSS each). The warning at >4 cores nudges users toward explicit sizing.
2. **`Supervisor` falls back to `workers: 4`** when `options.workers` is undefined — an undocumented magic number.

Neither default matches what production deployments actually want. The `workers: 1` default wastes CPU on multi-core machines; the `4` default under-uses large boxes and over-uses small ones. There is no environment-variable override — production deployments must edit code to change pool size.

The Phase E benchmark (`BENCHMARKS.md §18`, commit `65c2023`) empirically establishes the sizing rule: **CPU-bound workloads saturate at `availableParallelism()` workers; I/O-bound benefit from oversubscription up to RAM limits.** This is the same rule Gunicorn encodes as `WEB_CONCURRENCY` and Puma encodes as `(2 × CPU) + 1`. The runtime should expose the same convention.

## Decision Drivers

- **Production-friendly defaults**: `WORKER_CONCURRENCY=auto` should "just work" on multi-core boxes without code changes.
- **Back-compat**: existing users who pass `workers: N` explicitly must see no behavior change.
- **Empirically grounded**: the default should rest on the Phase E saturation data, not folklore.
- **Env-overridable**: ops teams should be able to tune pool size per environment (dev/staging/prod) without touching code.
- **Cross-platform**: works the same on Linux, macOS, Windows. No `taskset` or CPU-affinity assumptions.
- **DR-consistent**: aligns with ADR-0021 (multi-AZ active-active): per-instance workers is bounded, horizontal scaling is the lever.

## Considered Options

- **Option A — Status quo**: hardcoded `workers: 1` (ADR-0019) + supervisor fallback `4`. No env override.
- **Option B — `WORKER_CONCURRENCY` env var + numeric default** (Puma-style).
- **Option C — `WORKER_CONCURRENCY` env var + `concurrency: 'auto'` option** (Gunicorn-style with auto-detection).
- **Option D — Drop the env var entirely, only support `concurrency: 'auto'` factory option**.

## Decision Outcome

Chosen option: **"Option C — env var + factory option, with auto-detection default"**.

The factory and env-var contract:

```js
import { availableParallelism } from 'node:os';

// Resolution order (highest priority first):
//   1. options.workers (explicit numeric)         — back-compat
//   2. process.env.WORKER_CONCURRENCY              — ops override
//   3. options.concurrency === 'auto'              — auto-detect
//   4. default = 1                                  — ADR-0019 conservative
function resolveWorkerCount(options) {
  if (typeof options.workers === 'number') return options.workers;

  const env = process.env.WORKER_CONCURRENCY;
  if (env !== undefined) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 1) return n;
    if (env === 'auto') return availableParallelism();
  }

  if (options.concurrency === 'auto') return availableParallelism();

  return 1; // ADR-0019 conservative default
}
```

The `Supervisor`'s fallback `|| 4` is removed (it was unreachable: `WorkerRuntime` always passes a number to `Supervisor`). Both classes' defaults are derived from the same `resolveWorkerCount` helper to prevent drift.

### Positive Consequences

- **Production-ready defaults out of the box**: a fresh deploy on a 16-core machine with `WORKER_CONCURRENCY=auto` (or unset `concurrency: 'auto'`) uses 16 workers. No code changes required.
- **Consistent with industry**: `WEB_CONCURRENCY` (Gunicorn), `WEB_CONCURRENCY` (Puma), `WORKER_CONCURRENCY` (this ADR). Ops engineers already know the convention.
- **Phase E validation**: the default value (`availableParallelism()`) is the empirically measured saturation knee, not a heuristic.
- **Per-environment tuning**: `WORKER_CONCURRENCY=8` in a memory-constrained container, `auto` on bare metal, explicit `workers: 2` in tests.
- **ADR-0021 alignment**: per-instance workers is bounded by Phase E (8-16); horizontal scaling is the lever for more throughput.

### Negative Consequences

- **Larger default RSS**: `auto` on a 64-core machine allocates 64 V8 isolates (~2-3 GB RSS). Mitigation: warning when RSS estimate exceeds 50% of `totalmem`.
- **Auto-detection surprises in containers**: Docker `--cpuset-cpus` or K8s CPU limits may restrict effective cores; `availableParallelism()` reports host cores, not container quota. Mitigation: warn when CPU quota is detected (future work; ADR-0024 candidate).
- **`parseInt` on env vars**: typos like `WORKER_CONCURRENCY=ten` silently fall back to `1`. Mitigation: log a warning when `env !== 'auto'` and `parseInt` returns NaN.

## Pros and Cons of the Options

### Option A — Status quo ❌ Rejected

- ✅ Maximum simplicity.
- ❌ Wastes CPU on every multi-core deploy unless code is edited.
- ❌ Magic `4` in `Supervisor` is undocumented and arbitrary.
- ❌ Production teams hit ADR-0019 warning at >4 cores every time and ignore it (warning fatigue).
- ❌ No env-var escape hatch for ops.

### Option B — Env var + numeric default ⚠️ Acceptable but less expressive

- ✅ Solves the env-var gap.
- ❌ Still requires ops to know their host's core count.
- ❌ Doesn't match Gunicorn's `=auto` ergonomics.

### Option C — Env var + factory option + auto-detection ✅ Chosen

- ✅ Matches Gunicorn/Puma conventions.
- ✅ `auto` works on bare metal without operator input.
- ✅ Explicit `workers: N` (Option A's behavior) still works for back-compat.
- ✅ Env var allows per-environment override without code changes.
- ⚠️ Container CPU quotas need a separate ADR (future work).

### Option D — Factory option only ❌ Rejected

- ✅ Simplest API surface.
- ❌ Breaks ops workflow — environment-specific tuning requires code changes per environment.
- ❌ Diverges from Gunicorn/Puma convention.

## Implementation Notes

Tracked as **T6** in `.specs/features/adaptive-concurrency/tasks.md` (replaces the existing T6 "Band validation + opt-out detection" with a combined task: validation + sizing policy).

Concrete changes:

1. New file `src/worker-pool-sizing.js` (or inline in `worker-runtime.js`) — exports `resolveWorkerCount(options)`.
2. `worker-runtime.js` uses the resolver; `Supervisor` no longer has its own default.
3. `adaptive-controller.js` `maxWorkers` defaults to `availableParallelism()` if not specified (T6 band validation already covers `minWorkers <= maxWorkers`).
4. Tests:
   - `resolveWorkerCount({ workers: 4 })` → 4 (explicit wins).
   - `resolveWorkerCount({})` with `WORKER_CONCURRENCY=auto` → host cores.
   - `resolveWorkerCount({})` with `WORKER_CONCURRENCY=8` → 8.
   - `resolveWorkerCount({})` with no env → 1 (back-compat).
   - `resolveWorkerCount({ concurrency: 'auto' })` → host cores.
   - Invalid env (`ten`) → falls back to 1 + logs warning.
5. Document in README §Configuration + DR plan §3.

## When This ADR Should Be Updated

- When K8s/Docker CPU quotas need to override `availableParallelism()` (track as ADR-0024 candidate).
- When I/O-bound workloads warrant a different default (e.g., 2× `availableParallelism()` capped by RAM) — currently handled by ops setting explicit `workers: N`, but a future `concurrency: 'io'` mode might be useful.
- When `node:worker_threads` adds its own pool-sizing API.

## Links

- ADR-0009 — Elastic worker pool auto-scaling (the runtime's auto-scale on resize; this ADR is the *initial* sizing).
- ADR-0019 — Default workers reduced from `availableParallelism()` to 1 (the conservative default this ADR amends for production opt-in).
- ADR-0021 — Multi-AZ active-active deployment topology (the topology that consumes per-instance sizing from this ADR).
- `BENCHMARKS.md §18` — Phase E CPU saturation (the empirical foundation for `auto` default).
- `.specs/features/adaptive-concurrency/tasks.md` — T6 implementation tasks.
- `docs/operations/disaster-recovery.md §3` — topology diagram citing `WORKER_CONCURRENCY=auto`.
- Supersedes: ADR-0019 §Behavior (default for production); ADR-0019 §Caveats (env-var escape hatch).

## Amendment Note

ADR-0019's "Behavior" section (default `workers: 1` with warning) remains the **default for the factory** when neither `workers` nor `WORKER_CONCURRENCY` nor `concurrency: 'auto'` is specified. The change here is that **production deployments have an explicit, documented escape hatch** (env var or factory option) that activates auto-sizing. The conservative default is preserved for safety.
