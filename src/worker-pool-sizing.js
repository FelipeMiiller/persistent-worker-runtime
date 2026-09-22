/**
 * Worker pool sizing policy (ADR-0023).
 *
 * Single source of truth for the initial pool size and the adaptive-
 * controller opt-out flag. Both `WorkerRuntime` and `Supervisor` derive
 * their target count from `resolveWorkerCount` so defaults never drift.
 *
 * Resolution order (highest priority first):
 *
 *   1. `options.workers` (explicit numeric integer >= 1) — back-compat per
 *      ADR-0019. Pinning the size explicitly also disables the adaptive
 *      controller (see `resolveAdaptiveEnabled`).
 *   2. `process.env.WORKER_CONCURRENCY` — ops escape hatch per ADR-0023.
 *      Accepts a positive integer (`8`) or the literal string `auto`
 *      (Gunicorn-style auto-detect via `availableParallelism()`).
 *   3. `options.concurrency === 'auto'` — programmatic auto-detect
 *      without needing to know the env var name.
 *   4. Default = `1` (ADR-0019 conservative). Emits a startup warning
 *      on >4-core hosts when reached via this branch.
 *
 * The `Supervisor`'s `|| 4` magic-number fallback was removed in T6; it
 * was unreachable because `WorkerRuntime` always passes a finite integer
 * to the Supervisor.
 *
 * @see ADR-0019 — Default workers reduced from `availableParallelism()` to `1`.
 * @see ADR-0023 — `WORKER_CONCURRENCY` env var + `concurrency: 'auto'` sizing policy.
 */

import { availableParallelism } from 'node:os';

/** Name of the env var consulted by `resolveWorkerCount`. Exposed for tests + tooling. */
export const SIZING_ENV_VAR = 'WORKER_CONCURRENCY';

/** Conservative default returned when no sizing hint is provided (ADR-0019). */
export const SIZING_DEFAULT_WORKERS = 1;

/**
 * Warning code emitted when `WORKER_CONCURRENCY` is set but unparseable.
 * Operators scripting around this warning code (rather than the message)
 * are insulated from future copy edits.
 */
export const SIZING_INVALID_ENV_WARNING = 'PersistentWorkerRuntimeInvalidEnv';

/**
 * Resolves the initial pool size from factory options + environment.
 *
 * `options.workers`, when a finite integer >= 1, always wins regardless
 * of the env var or `concurrency` setting. The env var is then consulted
 * (literal `auto` → host cores; integer → that value; anything else →
 * warn and fall through). As a last resort, `concurrency: 'auto'` does
 * the same `availableParallelism()` mapping. Anything else returns the
 * conservative default of `1`.
 *
 * Invalid env values (e.g. `WORKER_CONCURRENCY=ten`) emit a
 * `process.emitWarning` with code `SIZING_INVALID_ENV_WARNING` and fall
 * through to the next resolution tier. This matches ADR-0023's "warn and
 * fall back" mitigation for env typos — silent fallback would mask
 * deployment misconfigurations.
 *
 * @param {{ workers?: unknown, concurrency?: unknown }} [options]
 * @returns {number} A positive integer (>= 1).
 * @throws {RangeError} If `options.workers` is provided but is not a
 *   positive integer (NaN, Infinity, 0, negatives, fractional). Explicit
 *   options fail fast; the env var and `concurrency: 'auto'` paths are
 *   permissive by design (best-effort auto-detection should not crash
 *   the process).
 */
export function resolveWorkerCount(options = {}) {
  if (typeof options.workers === 'number') {
    if (
      !Number.isFinite(options.workers) ||
      !Number.isInteger(options.workers) ||
      options.workers < 1
    ) {
      throw new RangeError(
        `resolveWorkerCount: options.workers must be a positive integer, got ${options.workers}`,
      );
    }
    return options.workers;
  }

  const env = process.env[SIZING_ENV_VAR];
  if (env !== undefined) {
    if (env === 'auto') {
      return availableParallelism();
    }
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed;
    }
    // Garbage like 'ten' or '0' — warn and fall through to the next tier.
    process.emitWarning(
      `persistent-worker-runtime: ignoring invalid ${SIZING_ENV_VAR}=${JSON.stringify(env)} ` +
        `(expected a positive integer or 'auto'); falling back to defaults`,
      SIZING_INVALID_ENV_WARNING,
    );
  }

  if (options.concurrency === 'auto') {
    return availableParallelism();
  }

  return SIZING_DEFAULT_WORKERS;
}

/**
 * Decides whether the adaptive concurrency controller is enabled given
 * the factory options. Per ADR-0014, the controller is opt-out:
 * explicit numeric `workers` and `concurrency: 'fixed'` both disable it,
 * even if the runtime could technically shrink/grow the pool within the
 * band. `concurrency: 'auto'` enables it.
 *
 * The result is the value `WorkerRuntime` should pass to
 * `createAdaptiveController({ enabled })`. When the controller is
 * disabled, sampling still runs so the telemetry block stays populated.
 *
 * @param {{ workers?: unknown, concurrency?: unknown }} [options]
 * @returns {boolean} `true` unless the user explicitly pinned the size.
 */
export function resolveAdaptiveEnabled(options = {}) {
  if (typeof options.workers === 'number') return false;
  if (options.concurrency === 'fixed') return false;
  return true;
}

/**
 * Returns `true` when the resolver reached its default branch (i.e. no
 * sizing hint at all). `WorkerRuntime` uses this to gate the
 * `PersistentWorkerRuntimeDefaultSizing` startup warning so it only
 * nags users on the conservative default, never on explicit configs
 * (even an explicit `WORKER_CONCURRENCY=1`).
 *
 * @param {{ workers?: unknown, concurrency?: unknown }} [options]
 * @returns {boolean}
 */
export function isDefaultSizing(options = {}) {
  if (typeof options.workers === 'number') return false;
  if (process.env[SIZING_ENV_VAR] !== undefined) return false;
  if (options.concurrency === 'auto') return false;
  return true;
}
