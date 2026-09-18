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
 *   - T3 — debounce state machine: pending.
 *   - T4-T5 — resize actions + decision logic: pending.
 *
 * @see ADR-0014 — Adaptive Concurrency via Event Loop Utilization
 * @see .specs/features/adaptive-concurrency/{spec.md,tasks.md}
 */

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

    const latencyP99 = this.#histogram.percentile(99);
    // Reset so the next sample reflects only the new window (between
    // this call and the next). Tiny sample-loss at the boundary is
    // acceptable for an EWMA-driven signal.
    this.#histogram.reset();

    return { elu, latencyP99 };
  }
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
 *   onResize(listener: ResizeListener): () => boolean,
 *   getStats(): AdaptiveStats,
 * }} Adaptive controller with the documented public surface.
 */
export function createAdaptiveController(options) {
  // Defaults are resolved here so downstream code can read a complete
  // config object. Full validation (band bounds, type checks) lands in
  // T6 alongside WorkerRuntime wiring.
  const config = {
    minWorkers: options?.minWorkers,
    maxWorkers: options?.maxWorkers,
    samplingCadenceMs: 100,
    ewmaAlpha: 0.3,
    debounceTicks: 5,
    shrinkEluThreshold: 0.85,
    shrinkLatencyP99Ms: 50,
    growEluThreshold: 0.5,
    growLatencyP99Ms: 10,
    enabled: true,
    ...options,
  };

  /** @type {Set<ResizeListener>} */
  const resizeListeners = new Set();
  const eluEwma = new Ewma(config.ewmaAlpha);
  const latencyEwma = new Ewma(config.ewmaAlpha);
  const signals = new SignalMonitor();

  /**
   * Latest telemetry snapshot. Live `elu` / `latencyP99Ms` updates
   * land in `tick()` after the EWMA smooths each fresh sample.
   *
   * @type {AdaptiveStats}
   */
  const stats = {
    enabled: config.enabled,
    elu: null,
    latencyP99Ms: null,
    effectiveWorkers: config.minWorkers,
    ticksSinceResize: 0,
    lastResizeReason: null,
    lastResizeAt: null,
  };

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

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
     * T2 wires the SignalMonitor + Ewma chain: sample raw signals,
     * feed both EWMAs, refresh the telemetry block. Debounce (T3),
     * decision logic (T5), and resize actions (T4) all land in
     * subsequent tasks; this method does NOT currently fire any
     * resize event.
     */
    tick() {
      const { elu, latencyP99 } = signals.sample();
      eluEwma.update(elu);
      latencyEwma.update(latencyP99);
      stats.elu = eluEwma.value();
      stats.latencyP99Ms = latencyEwma.value();
      stats.ticksSinceResize++;
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
