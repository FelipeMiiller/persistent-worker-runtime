/**
 * Adaptive Concurrency Controller (ADR-0014).
 *
 * Resizes the WorkerRuntime pool between `[minWorkers, maxWorkers]` using
 * two complementary main-thread Event Loop signals:
 *
 *   - `perf_hooks.eventLoopUtilization()` — utilization ratio in `[0, 1]`.
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
 * T1 scope: factory + public method surface + JSDoc contract. Signal
 * acquisition (T2), debounce state machine (T3), resize actions (T4),
 * decision logic (T5), runtime wiring (T6, T7), and telemetry (T8) follow
 * in subsequent tasks.
 *
 * @see ADR-0014 — Adaptive Concurrency via Event Loop Utilization
 * @see .specs/features/adaptive-concurrency/{spec.md,tasks.md}
 */

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
 * Creates an adaptive concurrency controller. The returned object exposes
 * the lifecycle methods documented at the top of this module.
 *
 * T1 returns a no-op controller with the full public surface. T2..T8 fill
 * in signal acquisition, EWMA smoothing, debounce, decision logic, and
 * runtime integration while preserving this contract.
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
  // T1: configuration is captured verbatim. Full validation (band bounds,
  // type checks) lands in T6 alongside WorkerRuntime wiring. Defaults are
  // resolved here so downstream code can read a complete config object.
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

  /**
   * Latest telemetry snapshot. T1 only initializes the static shape; live
   * `elu` / `latencyP99Ms` updates arrive in T2 (SignalMonitor + Ewma) and
   * the per-tick refresh lands in T7 / T8.
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
      timer = setInterval(api.tick, config.samplingCadenceMs);
      // Allow the process to exit naturally even if the controller is the
      // only thing keeping the loop alive. Resize ticks are best-effort
      // observability, not a hard contract.
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
      resizeListeners.clear();
    },

    /**
     * Runs a single sampling + decision cycle. Safe to call manually for
     * tests and benchmarks; the supervisor heartbeat will invoke this on
     * `samplingCadenceMs` once `start()` has been called.
     *
     * T1 scaffold: no-op. Signal acquisition (T2), EWMA smoothing (T2),
     * debounce counter (T3), decision matrix (T5), and resize actions (T4)
     * all land in subsequent tasks. This body intentionally has no logic
     * so the public surface stays testable today without implying
     * behavior that has not been built.
     */
    tick() {
      // Placeholder until T2 wires the SignalMonitor.
      return;
    },

    /**
     * Registers a resize listener. Returns an idempotent unsubscribe
     * function so callers can detach without holding a reference to the
     * controller.
     *
     * @param {ResizeListener} listener
     * @returns {() => boolean} Unsubscribe function. Returns true if the
     *   listener was registered at the time of the call.
     */
    onResize(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('onResize() requires a function listener');
      }
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },

    /**
     * Returns the latest stats snapshot. Safe to call at any time. The
     * returned object is the controller's internal reference, so callers
     * MUST NOT mutate it.
     *
     * @returns {AdaptiveStats}
     */
    getStats() {
      return stats;
    },
  };

  return api;
}
