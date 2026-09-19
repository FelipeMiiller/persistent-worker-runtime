/**
 * Adaptive Concurrency Controller (ADR-0014).
 *
 * Resizes the WorkerRuntime pool between `[minWorkers, maxWorkers]` using
 * two complementary main-thread Event Loop signals:
 *
 *   - `perf_hooks.performance.eventLoopUtilization()` — utilization ratio
 *     in `[0, 1]`.
 *   - `perf_hooks.monitorEventLoopDelay({ resolution: 20 })` — p99 tail
 *     latency in milliseconds.
 *
 * Both signals are smoothed with an EWMA filter (α ≈ 0.3) and gated by a
 * debounce window (5 ticks in the same direction) to filter transient
 * spikes and prevent pool oscillation. Decision matrix:
 *
 *   - **Shrink** when `ELU_EWMA > 0.85` OR `p99 > 50ms` (debounce
 *     satisfied, `effectiveWorkers > minWorkers`).
 *   - **Grow** when `ELU_EWMA < 0.5` AND `p99 < 10ms` AND the queue has
 *     pending work (debounce satisfied, `effectiveWorkers < maxWorkers`).
 *
 * Explicit opt-out via `enabled: false` (the runtime sets this when
 * `concurrency: 'fixed'` is configured). When disabled, the tick still
 * runs to keep telemetry populated, but no resize ever fires.
 *
 * Lifecycle:
 *   - `start()` arms the sampling cadence (idempotent).
 *   - `stop()` cancels pending ticks and detaches resize listeners.
 *   - `tick()` runs one sampling + decision cycle. Safe to call directly
 *     for tests; the supervisor heartbeat invokes it on the cadence.
 *   - `onResize(listener)` registers a resize callback; returns an
 *     idempotent unsubscribe function.
 *   - `getStats()` returns the latest telemetry snapshot for the
 *     `runtime.stats.adaptive` block.
 *
 * Phase 1 status:
 *   - T1 — public surface + factory: complete.
 *   - T2 — `Ewma` + `SignalMonitor` wired into `tick()`: complete.
 *   - T3 — `DebounceCounter` primitive: complete.
 *
 * Phase 2 status:
 *   - T4 — `spawnWorker()` + `retireLowestLoadWorker()` with drain
 *     semantics: complete. Resize callbacks (`spawnIdleWorker`,
 *     `retireLowestLoadWorker`) and `events` emitter are injected via
 *     factory options so T4 stays unit-testable in isolation. T7 will
 *     wire the real `WorkerRuntime.spawnIdleWorker()` /
 *     `WorkerRuntime.retireLowestLoadWorker()` and pass
 *     `runtime.events` here.
 *   - T5 — resize decision logic wiring: complete. `tick()` calls
 *     `classifyTickDirection` (pure helper) on the smoothed signals,
 *     feeds the result into `DebounceCounter.note(direction)`, and
 *     the debounced fire listener enforces the
 *     `[minWorkers, maxWorkers]` band + the `enabled` opt-out before
 *     invoking `spawnWorker()` / `retireLowestLoadWorker()` from T4.
 *     Sustained grow signals re-fire every `debounceTicks` ticks (the
 *     controller's fire cadence, not a burst loop) — pool growth is
 *     bounded by `maxWorkers`, not the fire rate.
 *
 * @see ADR-0014 — Adaptive Concurrency via Event Loop Utilization
 * @see .specs/features/adaptive-concurrency/{spec.md,tasks.md}
 */

import { availableParallelism } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/**
 * @typedef {object} AdaptiveControllerOptions
 * @property {number} minWorkers Lower bound for `effectiveWorkers`. MUST be `>= 1`.
 * @property {number} maxWorkers Upper bound for `effectiveWorkers`. MUST be `>= minWorkers`.
 * @property {number} [samplingCadenceMs=100] Tick interval in milliseconds.
 * @property {number} [ewmaAlpha=0.3] EWMA smoothing factor in `(0, 1)`.
 * @property {number} [debounceTicks=5] Consecutive same-direction ticks before a resize fires.
 * @property {number} [shrinkEluThreshold=0.85] EWMA ELU above which shrink can fire.
 * @property {number} [shrinkLatencyP99Ms=50] EWMA p99 (ms) above which shrink can fire.
 * @property {number} [growEluThreshold=0.5] EWMA ELU below which grow can fire (paired with latency).
 * @property {number} [growLatencyP99Ms=10] EWMA p99 (ms) below which grow can fire (paired with ELU).
 * @property {boolean} [enabled=true] When false, the tick still samples for telemetry but never resizes.
 * @property {number} [initialWorkers] Sets the initial value of `stats.effectiveWorkers`
 *   at construction time. When omitted, falls back to `minWorkers`. WorkerRuntime
 *   passes the resolved initial pool size here so `effectiveWorkers` mirrors the
 *   real pool at start (avoids a transient `effectiveWorkers = 1` while the pool
 *   actually has N workers — the bug a `workers: 4` config would otherwise expose
 *   to dashboards reading `runtime.stats.adaptive.effectiveWorkers` pre-resize).
 * @property {() => Promise<string> | string} [spawnIdleWorker] T7 will inject this — spawns a new
 *   idle worker and returns its `workerId`. When the callback resolves to a non-empty string
 *   the controller increments `effectiveWorkers` and fires an `onResize` event with
 *   `reason: 'grow'`. Rejections / non-string returns are treated as failures (no state change,
 *   no event). When absent, `spawnWorker()` is a graceful no-op.
 * @property {() => Promise<string | null> | string | null} [retireLowestLoadWorker] T7 will
 *   inject this — picks the lowest-load worker (LRU proxy: smallest `tasksCompletedSinceBoot`),
 *   marks it `draining`, awaits the in-flight task to complete naturally (NO
 *   `worker.terminate()`), then retires and returns the `workerId`. The controller emits
 *   `runtime.events` `worker:retiring` with `{ workerId, reason: 'drain' }` BEFORE decrementing
 *   `effectiveWorkers` and firing `onResize` with `reason: 'shrink'`. Returning `null` (or an
 *   empty string) means "no worker to retire" — graceful no-op.
 * @property {{ emit(event: string, payload: object): void }} [events] T7 will inject
 *   `runtime.events` here. When present, the controller emits `worker:retiring` for every
 *   successful retire. When absent, the controller skips emission silently (still updates
 *   stats and fires `onResize`).
 */

/**
 * @typedef {object} AdaptiveStats
 * @property {boolean} enabled Whether the controller can fire resize events.
 * @property {number | null} elu Latest EWMA-smoothed Event Loop utilization ratio.
 * @property {number | null} latencyP99Ms Latest EWMA-smoothed Event Loop delay p99 (ms).
 * @property {number} effectiveWorkers Current pool size.
 * @property {number} ticksSinceResize Ticks elapsed since the most recent resize (or start).
 * @property {'grow' | 'shrink' | null} lastResizeReason Direction of the most recent resize.
 * @property {number | null} lastResizeAt `performance.now()` timestamp of the most recent resize.
 */

/**
 * @typedef {object} ResizeEvent
 * @property {'grow' | 'shrink'} reason Direction of the resize that just fired.
 * @property {number} effectiveWorkers Pool size after the resize.
 * @property {number} at `performance.now()` timestamp of the event.
 * @property {{ elu: number | null, latencyP99Ms: number | null }} signals Smoothed signals at firing time.
 */

/**
 * @callback ResizeListener
 * @param {ResizeEvent} event
 */

/**
 * Exponentially Weighted Moving Average (EWMA).
 *
 * Smoothing primitive used to filter per-tick jitter from the `elu` and
 * `latencyP99` signals before threshold comparison.
 *
 * Formula (recursive):
 *   value_t = α * sample_t + (1 - α) * value_{t - 1}
 *
 * The first `update()` seeds the average with the input verbatim — no
 * warm-up bias. Subsequent calls apply the standard EWMA formula. This
 * keeps the controller responsive on the first few ticks without
 * dragging the smoothed value toward an artificial origin (which would
 * delay the first legitimate decision by the EWMA half-life).
 *
 * Validation: alpha must be a finite number in the open interval (0, 1).
 * Update values must be finite numbers (NaN, Infinity, strings rejected).
 *
 * @see ADR-0014 §Architectural Mechanics — EWMA smoothing, α = 0.3
 */
export class Ewma {
  /** @type {number} */
  #alpha;
  /** @type {number | null} */
  #value;

  /**
   * @param {number} [alpha=0.3] Smoothing factor in (0, 1). Standard
   *   load-balancer value; half-life ≈ 2-3 samples at the default α.
   * @throws {TypeError} If `alpha` is not a finite number.
   * @throws {RangeError} If `alpha` is not in the open interval (0, 1).
   */
  constructor(alpha = 0.3) {
    if (typeof alpha !== 'number' || !Number.isFinite(alpha)) {
      throw new TypeError(`Ewma alpha must be a finite number, got ${alpha}`);
    }
    if (alpha <= 0 || alpha >= 1) {
      throw new RangeError(`Ewma alpha must be in (0, 1), got ${alpha}`);
    }
    this.#alpha = alpha;
    this.#value = null;
  }

  /**
   * Feeds one sample into the EWMA. The first call initializes the
   * average with the input verbatim; subsequent calls apply the
   * exponential weighting.
   *
   * @param {number} value New sample.
   * @throws {TypeError} If `value` is not a finite number.
   */
  update(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`Ewma update value must be a finite number, got ${value}`);
    }
    if (this.#value === null) {
      this.#value = value;
    } else {
      this.#value = this.#alpha * value + (1 - this.#alpha) * this.#value;
    }
  }

  /**
   * Returns the current EWMA value, or `null` if no sample has been
   * fed yet.
   *
   * @returns {number | null}
   */
  value() {
    return this.#value;
  }
}

/**
 * Dual-signal monitor sampling both `elu` (Event Loop Utilization) and
 * `latencyP99` (Event Loop delay tail latency) on every `tick()`.
 *
 * Signal sources:
 *   - **ELU**: `performance.eventLoopUtilization(prev).utilization` —
 *     delta between the previous snapshot and the current one. The
 *     first sample returns `0` because no baseline exists yet; the
 *     second sample onwards returns a real delta.
 *   - **p99**: `monitorEventLoopDelay({ resolution: 20 }).percentile(99)`
 *     — tail latency in milliseconds over the last tick window. The
 *     histogram is reset after each sample so the next read reflects
 *     only the new window.
 *
 * The latency histogram is enabled by `start()` and disabled by
 * `stop()`. ELU is always available from `performance` (no opt-in).
 */
export class SignalMonitor {
  /** @type {IntervalHistogram} */
  #histogram;
  /** @type {number | null} */
  #prevElu;

  /**
   * Constructs a new SignalMonitor. The latency histogram is created
   * but not enabled — call `start()` to arm it. ELU does not need
   * arming; `performance.eventLoopUtilization()` is always live.
   */
  constructor() {
    this.#histogram = monitorEventLoopDelay({ resolution: 20 });
    this.#prevElu = null;
  }

  /**
   * Enables the latency histogram. Idempotent: calling `start()` while
   * already enabled is harmless (the histogram keeps accumulating).
   */
  start() {
    this.#histogram.enable();
  }

  /**
   * Disables the latency histogram. Existing samples are preserved
   * until the next `reset()` / `sample()` call; the percentile reported
   * after stop still reflects samples accumulated before stop.
   */
  stop() {
    this.#histogram.disable();
  }

  /**
   * Reads both signals and returns a snapshot. The first call returns
   * `elu = 0` (no baseline yet); subsequent calls return the delta
   * between the previous and the current call. The latency histogram
   * is reset after sampling so the next sample reflects only the new
   * window.
   *
   * @returns {{ elu: number, latencyP99: number }}
   */
  sample() {
    let elu = 0;
    if (this.#prevElu !== null) {
      const result = performance.eventLoopUtilization(this.#prevElu);
      elu = result.utilization;
    }
    this.#prevElu = performance.eventLoopUtilization();

    // `monitorEventLoopDelay.percentile()` returns NANOSECONDS in Node.js.
    // The spec, the public `latencyP99Ms` field, and the
    // `shrinkLatencyP99Ms` / `growLatencyP99Ms` thresholds are all in
    // MILLISECONDS — so we convert at the source. Without this conversion
    // a 30ms p99 stores as 30,000,000, the default `growLatencyP99Ms: 10`
    // is interpreted as "10 ns" (essentially unreachable below), and the
    // controller never grows the pool. Found while wiring the T11 example.
    const latencyP99Ms = this.#histogram.percentile(99) / 1_000_000;
    // Reset so the next sample reflects only the new window (between
    // this call and the next). Tiny sample-loss at the boundary is
    // acceptable for an EWMA-driven signal.
    this.#histogram.reset();

    return { elu, latencyP99: latencyP99Ms };
  }
}

/**
 * @typedef {object} DebounceFireEvent
 * @property {'grow' | 'shrink' | 'noop'} reason Direction whose consecutive-tick counter reached the threshold.
 * @property {number} at `performance.now()` timestamp of the fire (ms).
 */

/**
 * @callback DebounceFireListener
 * @param {DebounceFireEvent} event
 */

/**
 * Consecutive-tick debounce state machine.
 *
 * Counts how many ticks in a row have produced the same `direction`.
 * Resets to `1` on direction flip; fires the registered listener
 * (`onFire()`) when the count reaches the configured `threshold` (5 by
 * default), then resets the count to `0` while preserving the direction
 * so the very next same-direction tick starts a fresh window at `1`.
 *
 * The post-fire reset prevents a sustained signal (e.g. ELU stuck below
 * the grow threshold for several seconds) from firing the resize on
 * every subsequent threshold boundary — the controller sees a single
 * fire per "sustained signal episode" instead of one per debounce
 * window. The size cap (`maxWorkers`) is what bounds the actual pool
 * growth; this class only owns the fire cadence.
 *
 * `direction` is one of `'grow' | 'shrink' | 'noop'`. `'noop'` is
 * semantically a direction flip from anything else (and vice-versa),
 * so a noop tick interrupts a grow/shrink streak just like a real flip
 * would — without an explicit noop-breaker, transient noise inside the
 * dead zone could keep the grow/shrink counter alive indefinitely.
 *
 * Validation: `threshold` must be a finite integer `>= 1`. `note()`
 * rejects unknown directions. `onFire()` rejects non-function
 * listeners.
 *
 * @see ADR-0014 §Architectural Mechanics — debounce window, 5 consecutive ticks
 */
export class DebounceCounter {
  /** @type {number} */
  #threshold;
  /** @type {number} */
  #count;
  /** @type {'grow' | 'shrink' | 'noop' | null} */
  #direction;
  /** @type {Set<DebounceFireListener>} */
  #fireListeners;

  /**
   * @param {number} [threshold=5] Consecutive same-direction ticks required to fire.
   * @throws {TypeError} If `threshold` is not a finite number.
   * @throws {RangeError} If `threshold` is not an integer `>= 1`.
   */
  constructor(threshold = 5) {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      throw new TypeError(`DebounceCounter threshold must be a finite number, got ${threshold}`);
    }
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new RangeError(`DebounceCounter threshold must be an integer >= 1, got ${threshold}`);
    }
    this.#threshold = threshold;
    this.#count = 0;
    this.#direction = null;
    this.#fireListeners = new Set();
  }

  /**
   * Feeds one tick's direction into the counter.
   *
   * - If `direction` matches the current direction: increment count.
   * - Otherwise: direction becomes the new direction and count resets to `1`.
   * - If the post-update count reaches `threshold`: fire every registered
   *   listener with `{ reason: direction, at: performance.now() }`, then
   *   reset count to `0` (direction is preserved).
   *
   * @param {'grow' | 'shrink' | 'noop'} direction
   * @throws {TypeError} If `direction` is not one of the three valid values.
   */
  note(direction) {
    if (direction !== 'grow' && direction !== 'shrink' && direction !== 'noop') {
      throw new TypeError(
        `DebounceCounter direction must be 'grow' | 'shrink' | 'noop', got ${direction}`,
      );
    }

    if (this.#direction !== direction) {
      this.#direction = direction;
      this.#count = 1;
    } else {
      this.#count++;
    }

    if (this.#count >= this.#threshold) {
      // Snapshot listeners before iterating so a listener that calls
      // `reset()` (or even `note()` recursively) cannot mutate the set
      // mid-fire and produce a non-deterministic iteration order.
      const listeners = [...this.#fireListeners];
      const reason = /** @type {'grow' | 'shrink' | 'noop'} */ (direction);
      const at = performance.now();
      // Reset BEFORE firing so a listener that reads `value()` from
      // inside its callback sees the post-fire state (0), not the
      // threshold value that triggered the fire.
      this.#count = 0;
      for (const listener of listeners) {
        listener({ reason, at });
      }
    }
  }

  /**
   * Returns the current consecutive-tick count. `0` after `reset()` or
   * immediately after a fire (until the next `note()` arrives).
   *
   * @returns {number}
   */
  value() {
    return this.#count;
  }

  /**
   * Resets the counter and clears the current direction. The next
   * `note()` always starts a fresh streak at `1`.
   */
  reset() {
    this.#count = 0;
    this.#direction = null;
  }

  /**
   * Registers a fire listener. Returns an idempotent unsubscribe so
   * callers can detach without holding a reference to the counter.
   *
   * @param {DebounceFireListener} listener
   * @returns {() => boolean} Unsubscribe function. Returns true if the
   *   listener was registered at the time of the call.
   * @throws {TypeError} If `listener` is not a function.
   */
  onFire(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('DebounceCounter onFire() requires a function listener');
    }
    this.#fireListeners.add(listener);
    return () => this.#fireListeners.delete(listener);
  }
}

/**
 * Classifies a tick's smoothed signals into a resize direction. Pure
 * function — exported so the decision matrix can be unit-tested
 * independently of the controller lifecycle.
 *
 * Rules (per ADR-0014 §Architectural Mechanics):
 *   - `'shrink'`: `elu > shrinkEluThreshold` OR
 *     `latencyP99Ms > shrinkLatencyP99Ms` (either signal alone
 *     triggers shrink — both load and tail latency matter).
 *   - `'grow'`: `elu < growEluThreshold` AND
 *     `latencyP99Ms < growLatencyP99Ms` (both signals must agree —
 *     never grow on disagreement; a low-ELU high-p99 pool is
 *     blocked on I/O, more workers won't help).
 *   - `'noop'`: dead zone, or the two signals disagree in any other
 *     way. Transient noise inside the dead zone keeps the debounce
 *     counter from advancing.
 *
 * Null signals (before the first EWMA sample lands) always classify
 * as `'noop'` — the controller has no information to act on.
 *
 * Thresholds are strict: `> shrinkEluThreshold` (not `>=`) and
 * `< growEluThreshold` (not `<=`). A tick sitting exactly on a
 * threshold edge falls into the dead zone — keeps the decision
 * well-defined at the boundary and avoids oscillation between
 * shrink/noop or grow/noop at the exact threshold.
 *
 * @param {number | null} elu Smoothed Event Loop Utilization.
 * @param {number | null} latencyP99Ms Smoothed Event Loop delay p99 (ms).
 * @param {number} shrinkEluThreshold
 * @param {number} shrinkLatencyP99Ms
 * @param {number} growEluThreshold
 * @param {number} growLatencyP99Ms
 * @returns {'grow' | 'shrink' | 'noop'}
 */
export function classifyTickDirection(
  elu,
  latencyP99Ms,
  shrinkEluThreshold,
  shrinkLatencyP99Ms,
  growEluThreshold,
  growLatencyP99Ms,
) {
  if (elu === null || latencyP99Ms === null) return 'noop';
  if (elu > shrinkEluThreshold || latencyP99Ms > shrinkLatencyP99Ms) {
    return 'shrink';
  }
  if (elu < growEluThreshold && latencyP99Ms < growLatencyP99Ms) {
    return 'grow';
  }
  return 'noop';
}

/**
 * Creates an adaptive concurrency controller. The returned object exposes
 * the lifecycle methods documented at the top of this module.
 *
 * @param {AdaptiveControllerOptions} options
 * @returns {{
 *   start(): void,
 *   stop(): void,
 *   tick(): void,
 *   spawnWorker(): Promise<boolean>,
 *   retireLowestLoadWorker(): Promise<boolean>,
 *   onResize(listener: ResizeListener): () => boolean,
 *   getStats(): AdaptiveStats,
 * }} Adaptive controller with the documented public surface.
 */
export function createAdaptiveController(options) {
  // Band validation (T6 — per ADR-0014 / ADR-0023). Validate BEFORE
  // defaults land so a bogus `minWorkers > maxWorkers` does not silently
  // mutate into a valid band, and so `options.maxWorkers: undefined`
  // can be defaulted to `availableParallelism()` without tripping the
  // finite-integer check.
  //
  // The convention (TypeError vs RangeError) mirrors the existing
  // `Ewma` validation: TypeError for non-numeric / non-finite inputs,
  // RangeError for numeric inputs outside the accepted band. This keeps
  // the type/range split consistent across the module so callers can
  // match on error class without parsing the message.
  if (options == null || typeof options !== 'object') {
    throw new TypeError('createAdaptiveController requires an options object');
  }
  if (typeof options.minWorkers !== 'number' || !Number.isFinite(options.minWorkers)) {
    throw new TypeError(
      `createAdaptiveController: minWorkers must be a finite number, got ${options.minWorkers}`,
    );
  }
  if (!Number.isInteger(options.minWorkers) || options.minWorkers < 1) {
    throw new RangeError(
      `createAdaptiveController: minWorkers must be an integer >= 1, got ${options.minWorkers}`,
    );
  }
  if (options.maxWorkers !== undefined) {
    if (typeof options.maxWorkers !== 'number' || !Number.isFinite(options.maxWorkers)) {
      throw new TypeError(
        `createAdaptiveController: maxWorkers must be a finite number, got ${options.maxWorkers}`,
      );
    }
    if (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1) {
      throw new RangeError(
        `createAdaptiveController: maxWorkers must be an integer >= 1, got ${options.maxWorkers}`,
      );
    }
  }
  // Resolve maxWorkers BEFORE the band check so the error message
  // reflects the actually-applied upper bound (not the raw undefined).
  const resolvedMaxWorkers = options.maxWorkers ?? availableParallelism();
  if (options.minWorkers > resolvedMaxWorkers) {
    throw new RangeError(
      `createAdaptiveController: minWorkers (${options.minWorkers}) must be <= ` +
        `maxWorkers (${resolvedMaxWorkers})`,
    );
  }

  // Defaults are resolved here so downstream code can read a complete
  // config object. `maxWorkers` defaults to `availableParallelism()` per
  // ADR-0023 — Phase E measured the CPU-bound saturation knee at
  // exactly the host core count, and the env-driven production path
  // (T7) will re-resolve via `resolveWorkerCount(options.workers)`
  // before reaching this factory.
  const config = {
    minWorkers: options.minWorkers,
    maxWorkers: resolvedMaxWorkers,
    samplingCadenceMs: 100,
    ewmaAlpha: 0.3,
    debounceTicks: 5,
    shrinkEluThreshold: 0.85,
    shrinkLatencyP99Ms: 50,
    growEluThreshold: 0.5,
    growLatencyP99Ms: 10,
    enabled: true,
    spawnIdleWorker: undefined,
    retireLowestLoadWorker: undefined,
    events: undefined,
    ...options,
  };
  // Re-anchor the resolved defaults after the spread so a caller that
  // passes `{ maxWorkers: undefined }` explicitly still gets the
  // `availableParallelism()` default.
  config.maxWorkers = resolvedMaxWorkers;

  /** @type {Set<ResizeListener>} */
  const resizeListeners = new Set();
  const eluEwma = new Ewma(config.ewmaAlpha);
  const latencyEwma = new Ewma(config.ewmaAlpha);
  const signals = new SignalMonitor();
  const debounce = new DebounceCounter(config.debounceTicks);

  /**
   * Latest telemetry snapshot. Live `elu` / `latencyP99Ms` updates
   * land in `tick()` after the EWMA smooths each fresh sample.
   * `effectiveWorkers`, `ticksSinceResize`, `lastResizeReason`, and
   * `lastResizeAt` mutate on every successful spawn/retire (T4).
   *
   * @type {AdaptiveStats}
   */
  const stats = {
    enabled: config.enabled,
    elu: null,
    latencyP99Ms: null,
    // Initialize from `initialWorkers` (falls back to `minWorkers`). WorkerRuntime
    // passes the resolved initial pool size so `effectiveWorkers` mirrors the
    // real pool at start. Without this, a `workers: 4` config would briefly
    // report `effectiveWorkers: 1` while the pool actually has 4 workers, which
    // is what dashboards see before the first tick — a transient but visible
    // inconsistency. The pre-T9 fix that landed in `ae5c980` (T7) only set
    // `effectiveWorkers` from `minWorkers`, which is the floor, not the start.
    effectiveWorkers: config.initialWorkers ?? config.minWorkers,
    ticksSinceResize: 0,
    lastResizeReason: null,
    lastResizeAt: null,
  };

  /**
   * Resize action wiring (T5): the debounced fire callback is the
   * ONLY place where `tick()` translates into a spawn/retire. It
   * enforces the opt-out flag (`enabled: false`) and the
   * `[minWorkers, maxWorkers]` band, then fire-and-forgets the
   * underlying callbacks that T4 documented as boundary-naïve.
   * Failures (callback throws, returns null/empty) are absorbed
   * inside `spawnWorker` / `retireLowestLoadWorker` — no state
   * mutation, no event fired.
   *
   * Sustained grow signals re-fire every `debounceTicks` ticks (the
   * debounce's post-fire reset starts the counter at 1, so the next
   * same-direction tick accumulates toward another fire). Pool
   * growth is bounded by `maxWorkers`, not the fire rate.
   */
  debounce.onFire(({ reason }) => {
    if (!config.enabled) return;
    if (reason === 'grow' && stats.effectiveWorkers < config.maxWorkers) {
      api.spawnWorker();
    } else if (reason === 'shrink' && stats.effectiveWorkers > config.minWorkers) {
      api.retireLowestLoadWorker();
    }
  });

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  /**
   * Emits a `worker:retiring` runtime event via the injected
   * `events` emitter. Silent no-op when no emitter is configured
   * (T4 is testable in isolation without wiring `runtime.events`).
   *
   * @param {string} event
   * @param {object} payload
   */
  const emitRuntimeEvent = (event, payload) => {
    if (
      config.events &&
      typeof config.events === 'object' &&
      typeof config.events.emit === 'function'
    ) {
      config.events.emit(event, payload);
    }
  };

  /**
   * Fires the on-resize listener set + updates the post-resize stats
   * fields (`ticksSinceResize`, `lastResizeReason`, `lastResizeAt`).
   * Called only when the resize actually mutated `effectiveWorkers`;
   * failed spawn/retries are silent on this path.
   *
   * @param {'grow' | 'shrink'} reason
   */
  const fireResize = (reason) => {
    const at = performance.now();
    stats.lastResizeReason = reason;
    stats.lastResizeAt = at;
    stats.ticksSinceResize = 0;
    const event = {
      reason,
      effectiveWorkers: stats.effectiveWorkers,
      at,
      signals: { elu: stats.elu, latencyP99Ms: stats.latencyP99Ms },
    };
    // Snapshot listeners before iterating — same defensive pattern as
    // DebounceCounter — so a listener that calls `spawnWorker()`
    // recursively cannot mutate the set mid-fire.
    const listeners = [...resizeListeners];
    for (const listener of listeners) {
      listener(event);
    }
  };

  const api = {
    /**
     * Arms the sampling cadence. Idempotent: calling `start()` while
     * already running is a no-op (does NOT double-arm the timer).
     */
    start() {
      if (timer !== null) return;
      signals.start();
      timer = setInterval(api.tick, config.samplingCadenceMs);
      // Allow the process to exit naturally even if the controller is
      // the only thing keeping the loop alive. Resize ticks are
      // best-effort observability, not a hard contract.
      if (typeof timer.unref === 'function') timer.unref();
    },

    /**
     * Cancels the sampling cadence and detaches every resize listener.
     * Idempotent: calling `stop()` after stop is a no-op.
     */
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      signals.stop();
      resizeListeners.clear();
    },

    /**
     * Runs a single sampling + decision cycle. Safe to call manually
     * for tests and benchmarks; the supervisor heartbeat will invoke
     * this on `samplingCadenceMs` once `start()` has been called.
     *
     * Pipeline:
     *   1. `SignalMonitor.sample()` → raw `elu` + `latencyP99`.
     *   2. Feed both EWMAs; refresh `stats.elu` / `stats.latencyP99Ms`.
     *   3. `classifyTickDirection` maps the smoothed signals to
     *      `'grow' | 'shrink' | 'noop'` using the configured band
     *      thresholds.
     *   4. `debounce.note(direction)` accumulates the direction; the
     *      fire listener registered at factory time invokes
     *      `spawnWorker()` / `retireLowestLoadWorker()` after
     *      `debounceTicks` consecutive same-direction ticks (with the
     *      band + `enabled` gate enforced there).
     */
    tick() {
      const { elu, latencyP99 } = signals.sample();
      eluEwma.update(elu);
      latencyEwma.update(latencyP99);
      stats.elu = eluEwma.value();
      stats.latencyP99Ms = latencyEwma.value();
      stats.ticksSinceResize++;

      const direction = classifyTickDirection(
        stats.elu,
        stats.latencyP99Ms,
        config.shrinkEluThreshold,
        config.shrinkLatencyP99Ms,
        config.growEluThreshold,
        config.growLatencyP99Ms,
      );
      debounce.note(direction);
    },

    /**
     * Spawns a new idle worker via the injected `spawnIdleWorker`
     * callback (T7 wires this to `WorkerRuntime.spawnIdleWorker()`).
     *
     * On success: increments `stats.effectiveWorkers`, fires every
     * registered `onResize` listener with `reason: 'grow'`, and
     * resets `stats.ticksSinceResize` to `0`.
     *
     * Failures (no callback configured, callback throws, callback
     * resolves to a non-string or empty string) are silent: no state
     * mutation, no event fired, the method returns `false`.
     *
     * Boundary enforcement (`effectiveWorkers < maxWorkers`) is the
     * caller's responsibility — T5's decision matrix gates this call
     * before invocation. The controller itself does NOT refuse to
     * spawn past the band.
     *
     * @returns {Promise<boolean>} `true` if the worker was spawned,
     *   `false` otherwise.
     */
    async spawnWorker() {
      if (typeof config.spawnIdleWorker !== 'function') {
        return false;
      }
      let workerId;
      try {
        workerId = await config.spawnIdleWorker();
      } catch {
        return false;
      }
      if (typeof workerId !== 'string' || workerId.length === 0) {
        return false;
      }
      stats.effectiveWorkers++;
      fireResize('grow');
      return true;
    },

    /**
     * Retires the lowest-load worker via the injected
     * `retireLowestLoadWorker` callback (T7 wires this to the
     * matching `WorkerRuntime.retireLowestLoadWorker()`, which picks
     * the worker with the smallest `tasksCompletedSinceBoot`, marks
     * it `draining`, and awaits natural in-flight completion — NO
     * `worker.terminate()`).
     *
     * On success: emits `runtime.events` `worker:retiring` with
     * `{ workerId, reason: 'drain' }` BEFORE decrementing
     * `effectiveWorkers` and firing `onResize` with `reason: 'shrink'`.
     *
     * No-op outcomes (no callback configured, callback returns
     * `null` or an empty string, callback throws) are silent: no
     * `worker:retiring` event, no state mutation, the method returns
     * `false`. `null` typically means "already at the floor — T5's
     * decision matrix should have gated this call, but the runtime
     * is the authoritative source of truth on what can be retired".
     *
     * Boundary enforcement (`effectiveWorkers > minWorkers`) is the
     * caller's responsibility — T5's decision matrix gates this call
     * before invocation. The controller itself does NOT refuse to
     * retire below the band.
     *
     * @returns {Promise<boolean>} `true` if a worker was retired,
     *   `false` otherwise.
     */
    async retireLowestLoadWorker() {
      if (typeof config.retireLowestLoadWorker !== 'function') {
        return false;
      }
      let workerId;
      try {
        workerId = await config.retireLowestLoadWorker();
      } catch {
        return false;
      }
      if (typeof workerId !== 'string' || workerId.length === 0) {
        return false;
      }
      // Emit `worker:retiring` BEFORE decrementing / firing resize so
      // observers see a consistent snapshot: the worker is on its way
      // out, but `effectiveWorkers` still reflects the pre-retire
      // count when this event lands.
      emitRuntimeEvent('worker:retiring', { workerId, reason: 'drain' });
      stats.effectiveWorkers--;
      fireResize('shrink');
      return true;
    },

    /**
     * Registers a resize listener. Returns an idempotent unsubscribe
     * function so callers can detach without holding a reference to
     * the controller.
     *
     * @param {ResizeListener} listener
     * @returns {() => boolean} Unsubscribe function. Returns true if
     *   the listener was registered at the time of the call.
     */
    onResize(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('onResize() requires a function listener');
      }
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },

    /**
     * Returns the latest stats snapshot. Safe to call at any time.
     * The returned object is the controller's internal reference, so
     * callers MUST NOT mutate it.
     *
     * @returns {AdaptiveStats}
     */
    getStats() {
      return stats;
    },
  };

  return api;
}
