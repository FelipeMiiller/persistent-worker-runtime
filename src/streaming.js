/**
 * Main-thread Stream class for ADR-0012 streaming results.
 *
 * `Stream` is the consumer-facing side of `runtime.stream()`. It exposes
 * `Symbol.asyncIterator` so callers can consume chunks via `for await…of`,
 * bounded buffering for backpressure awareness, an AbortSignal for
 * cancellation, and a tiny event emitter (`on` / `off`) for telemetry.
 *
 * The producer side (`pushChunk`, `pushEnd`, `pushError`) is wired in T4
 * from the worker's `MSG_STREAM_*` IPC frames; T3 keeps the producer
 * surface on the class itself so the lifecycle can be unit-tested in
 * isolation against a mocked IPC source.
 *
 * @see ADR-0012 / .specs/features/streaming-results/spec.md
 */

const DEFAULTS = Object.freeze({
  HIGH_WATER_MARK: 1024,
});

/**
 * Throws a `TypeError` / `RangeError` when `highWaterMark` is not a
 * positive integer. Kept private to this module; the public surface is
 * the constructor.
 */
function validateHighWaterMark(value) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`highWaterMark must be a positive integer (got ${typeof value})`);
  }
  if (value <= 0) {
    throw new RangeError(`highWaterMark must be a positive integer (got ${value})`);
  }
}

export class Stream {
  /**
   * @param {Object}        [options]
   * @param {number}        [options.highWaterMark=1024]  Buffer size at which `stream:backpressure` fires.
   * @param {AbortSignal}   [options.signal]              External signal that aborts the stream.
   */
  constructor({ highWaterMark = DEFAULTS.HIGH_WATER_MARK, signal } = {}) {
    validateHighWaterMark(highWaterMark);
    if (
      signal !== undefined &&
      !(signal instanceof AbortSignal) &&
      typeof signal?.aborted !== 'boolean'
    ) {
      throw new TypeError('signal must be an AbortSignal or undefined');
    }

    this._highWaterMark = highWaterMark;
    this._buffered = [];
    this._waiter = null; // { resolve, reject } of the pending next() call

    this._aborted = false;
    this._abortedReason = null;
    this._settled = false;
    // _settleInfo holds the not-yet-consumed termination detail (an error
    // that hasn't been thrown yet, or an end that hasn't been returned
    // yet). After the consumer drains it via next(), it is set to null.
    /** @type {null | {type: 'end', returnValue: any} | {type: 'aborted', reason: any} | {type: 'error', error: Error}} */
    this._settleInfo = null;
    // Persisted flags for stats: these outlive the _settleInfo lifecycle
    // so callers can inspect the stream's terminal state after the
    // consumer has already iterated past it.
    this._endPushed = false;
    this._returnValue = undefined;
    this._terminalError = null;

    this._totalChunks = 0;
    this._totalErrors = 0;
    // T5 backpressure tracking: flips true once the buffer crosses the
    // high-water mark upward; reset when it drops below HWM / 2. Drives
    // `stream:backpressure { state: 'paused' | 'resumed' }` events so
    // the runtime can post MSG_STREAM_PAUSE / MSG_STREAM_RESUME to the
    // worker.
    this._isBackpressured = false;
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();

    if (signal) {
      if (signal.aborted) {
        this._abort(signal.reason);
      } else {
        signal.addEventListener('abort', () => this._abort(signal.reason), { once: true });
      }
    }
  }

  // ---- Read-only getters ----

  get highWaterMark() {
    return this._highWaterMark;
  }

  get aborted() {
    return this._aborted;
  }

  get abortedReason() {
    return this._abortedReason;
  }

  get endReceived() {
    // True once pushEnd() or pushAbortEnd() has been called, regardless
    // of whether the consumer has since drained the terminal frame.
    return this._endPushed || this._aborted;
  }

  get returnValue() {
    return this._returnValue;
  }

  get errorReceived() {
    return this._terminalError !== null;
  }

  get queueLength() {
    return this._buffered.length;
  }

  get stats() {
    return {
      totalChunks: this._totalChunks,
      totalErrors: this._totalErrors,
      aborted: this._aborted,
      abortedReason: this._abortedReason,
      endReceived: this.endReceived,
      errorReceived: this.errorReceived,
      queueLength: this._buffered.length,
      highWaterMark: this._highWaterMark,
    };
  }

  // ---- Producer side ----
  // These are wired to MSG_STREAM_* IPC frames in T4. Exposed publicly so
  // the class can be unit-tested without a live worker.

  /** @param {*} chunk  Push a chunk into the buffer; fires `stream:backpressure {state:'paused'}` once length >= highWaterMark. */
  pushChunk(chunk) {
    if (this._settled || this._aborted) return;
    const wasBelowThreshold = this._buffered.length < this._highWaterMark;
    this._buffered.push(chunk);
    this._totalChunks++;
    const isAtOrAbove = this._buffered.length >= this._highWaterMark;
    // Fire only on the upward crossing (spec STREAM-10). Repeated pushes
    // while the consumer hasn't drained don't refire because
    // _isBackpressured is already true.
    if (wasBelowThreshold && isAtOrAbove) {
      this._isBackpressured = true;
      this._emit('stream:backpressure', {
        state: 'paused',
        queueLength: this._buffered.length,
      });
    }
    this._deliverIfWaiting();
  }

  /**
   * Internal: if we're currently in the backpressured state and the
   * buffer just drained past the low-water mark (HWM / 2), emit
   * `stream:backpressure {state:'resumed'}`. Called after every shift
   * (next() / _deliverIfWaiting()).
   *
   * Per spec P2 §3, the resume fires when the buffer falls *below*
   * HWM / 2 — strictly less than, not ≤. The previous T3 lesson
   * (see completion-checklist.md) established the same asymmetry on
   * the pause side (crosses *above* HWM, not ≥).
   */
  _maybeEmitResume() {
    if (!this._isBackpressured) return;
    // Use the same `floor(HWM / 2)` shape as the spec wording. For HWM=4
    // the low-water is 2, and "below 2" means strictly < 2 (i.e. 0 or 1).
    const lowWater = Math.floor(this._highWaterMark / 2);
    if (this._buffered.length < lowWater) {
      this._isBackpressured = false;
      this._emit('stream:backpressure', {
        state: 'resumed',
        queueLength: this._buffered.length,
      });
    }
  }

  /** @param {{returnValue?: any}} [info]  Push a normal end; subsequent next() resolves with `{value: undefined, done: true}`. */
  pushEnd({ returnValue } = {}) {
    if (this._settled) return;
    this._settled = true;
    this._endPushed = true;
    this._returnValue = returnValue;
    this._settleInfo = { type: 'end', returnValue };
    this._emit('stream:end', { returnValue });
    this._deliverIfWaiting();
  }

  /** @param {{reason?: any}} [info]  Push an abort end (MSG_STREAM_END { aborted: true }). */
  pushAbortEnd({ reason } = {}) {
    if (this._settled) return;
    this._settled = true;
    this._aborted = true;
    this._abortedReason = reason || 'aborted';
    this._settleInfo = { type: 'aborted', reason: this._abortedReason };
    this._emit('stream:aborted', { reason: this._abortedReason });
    this._deliverIfWaiting();
  }

  /** @param {Error|Object} error  Push an error; the next next() call throws it. */
  pushError(error) {
    if (this._settled) return;
    this._settled = true;
    this._totalErrors++;
    // Normalize: tests may pass a plain object with message/stack/name.
    const err =
      error instanceof Error
        ? error
        : Object.assign(new Error(error?.message || String(error)), error);
    this._settleInfo = { type: 'error', error: err };
    this._terminalError = err;
    this._emit('stream:error', { error: err });
    this._deliverIfWaiting();
  }

  // ---- Consumer side ----

  [Symbol.asyncIterator]() {
    return this;
  }

  /**
   * Pull the next chunk. Resolves to `{value, done}` or throws on error.
   * Blocks until a chunk is buffered, the stream ends, or an error fires.
   *
   * After the stream has settled, subsequent next() calls (after the
   * terminal frame has been delivered) return `{value: undefined, done: true}`
   * so consumers using `for await…of` exit cleanly.
   */
  async next() {
    // Fast path: a chunk is already buffered.
    if (this._buffered.length > 0) {
      const value = this._buffered.shift();
      this._maybeEmitResume();
      return { value, done: false };
    }

    // Settled but the terminal frame is still pending delivery.
    if (this._settled && this._settleInfo) {
      const info = this._settleInfo;
      this._settleInfo = null; // consume once
      if (info.type === 'error') throw info.error;
      return { value: undefined, done: true };
    }

    // Already settled AND the terminal frame was already consumed —
    // subsequent calls collapse to done:true so for-await-of terminates.
    if (this._settled) {
      return { value: undefined, done: true };
    }

    // Aborted but not yet settled (consumer aborted before any push).
    if (this._aborted) {
      return { value: undefined, done: true };
    }

    // Slow path: park the consumer until something arrives.
    return new Promise((resolve, reject) => {
      this._waiter = { resolve, reject };
    });
  }

  /**
   * Called when the consumer uses `break` / `return` / `throw` inside a
   * `for await…of` loop. Marks the stream aborted and notifies listeners
   * via `stream:aborted` (unified with the external-signal abort path in
   * T5) so the IPC layer can send MSG_STREAM_ABORT to the worker.
   */
  async return(value) {
    if (!this._aborted) {
      this._aborted = true;
      this._abortedReason = 'consumer-return';
      this._emit('stream:aborted', { reason: this._abortedReason });
    }
    this._settled = true;
    if (this._waiter) {
      const waiter = this._waiter;
      this._waiter = null;
      waiter.resolve({ value, done: true });
    }
    return { value, done: true };
  }

  /**
   * Called when the consumer uses `throw` inside a `for await…of` loop.
   * Aborts the stream and re-throws the error.
   */
  async throw(err) {
    this._aborted = true;
    this._abortedReason = err?.message || 'consumer-throw';
    this._settled = true;
    this._settleInfo = { type: 'error', error: err };
    if (this._waiter) {
      const waiter = this._waiter;
      this._waiter = null;
      waiter.reject(err);
    }
    throw err;
  }

  // ---- Event emitter ----

  on(event, handler) {
    if (typeof handler !== 'function') return this;
    let arr = this._listeners.get(event);
    if (!arr) {
      arr = [];
      this._listeners.set(event, arr);
    }
    arr.push(handler);
    return this;
  }

  off(event, handler) {
    const arr = this._listeners.get(event);
    if (!arr) return this;
    const idx = arr.indexOf(handler);
    if (idx >= 0) arr.splice(idx, 1);
    return this;
  }

  // ---- Internal helpers ----

  _abort(reason) {
    if (this._aborted) return;
    this._aborted = true;
    this._abortedReason = reason || 'abort';
    this._settled = true;
    if (!this._settleInfo) {
      this._settleInfo = { type: 'aborted', reason: this._abortedReason };
    }
    this._emit('stream:aborted', { reason: this._abortedReason });
    this._deliverIfWaiting();
  }

  _deliverIfWaiting() {
    if (!this._waiter) return;
    if (this._buffered.length > 0) {
      const { resolve } = this._waiter;
      this._waiter = null;
      resolve({ value: this._buffered.shift(), done: false });
      this._maybeEmitResume();
      return;
    }
    if (this._settled && this._settleInfo) {
      const waiter = this._waiter;
      this._waiter = null;
      const info = this._settleInfo;
      this._settleInfo = null;
      if (info.type === 'error') waiter.reject(info.error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  _emit(event, data) {
    const arr = this._listeners.get(event);
    if (!arr) return;
    for (const h of arr.slice()) h(data);
  }
}
