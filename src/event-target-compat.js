/**
 * EventEmitter → EventTarget compatibility shim.
 *
 * Background: the runtime migrated from Node's `EventEmitter` to web-standard
 * `EventTarget` (see HANDOVER.md / migration discussion 2026-09-23). `EventTarget`
 * is the modern API — web standard, structured payloads via `CustomEvent.detail`,
 * AbortController cleanup via `{ signal }` option, and aligned with Node core's
 * direction (BroadcastChannel / AbortSignal / EventTarget are the foundations of
 * the proposed `node:worker_runtime` built-in).
 *
 * `EventTarget` does NOT have `.emit()`, `.on()`, `.once()`, `.off()`,
 * `.removeListener()`, `.removeAllListeners()`, `.listenerCount()`, or the
 * special 'error' event handling. This module adds those methods back as a
 * thin shim so existing consumers keep working without changes.
 *
 * Internally, every dispatch goes through `dispatchEvent(new CustomEvent(name,
 * { detail: payload }))`. The shim unwraps `.detail` so listeners see the same
 * `(payload)` signature EventEmitter used to give them.
 *
 * Migration plan (recorded here so it's durable across sessions):
 *   - v0.2.x (current): Shim active. `extends EventTarget` + compat methods.
 *     Full backward compat. Internal `emit` already migrated to `dispatchEvent`.
 *   - v0.3.x: Deprecate `.on()` / `.emit()` / `.off()` (point to
 *     `addEventListener` / `dispatchEvent` / `removeEventListener`).
 *   - v0.4.x: Drop the shim. Public API is pure `EventTarget`.
 */

const kAppliedSymbol = Symbol.for('persistent-worker-runtime.emitter-compat-applied');

// Per-listener registry: original listener -> Map<eventName, wrapped listener>.
// Needed because the shim wraps listeners (to unwrap `.detail`), and
// `.off()`/`removeListener()` must retrieve the SAME wrapped reference.
const kWrappedListeners = new WeakMap();

/**
 * Wraps a listener so it receives `event.detail` (the original payload) instead
 * of the full `CustomEvent` object. Mimics EventEmitter's variadic-arg API.
 *
 * @param {Function} listener
 * @returns {Function}
 */
function wrapListener(listener) {
  return function compatListener(event) {
    if (event && typeof event === 'object' && 'detail' in event) {
      return listener(event.detail);
    }
    return listener(event);
  };
}

/**
 * Applies EventEmitter-compatible methods to an EventTarget instance.
 * Idempotent: subsequent calls are no-ops.
 *
 * Adds: `.on()` / `.addListener()` / `.once()` / `.off()` / `.removeListener()` /
 *        `.emit()` / `.removeAllListeners()` / `.listenerCount()` /
 *        `.hasErrorListener()` (internal helper).
 *
 * Wraps: `addEventListener()` / `removeEventListener()` to track listeners per
 *        event type so `removeAllListeners()` / `listenerCount()` /
 *        `hasErrorListener()` can work without breaking EventTarget semantics.
 *
 * Does NOT add: `.prependListener()`, `.prependOnceListener()`,
 *        `.setMaxListeners()`, `.rawListeners()`, `.eventNames()`,
 *        `'newListener'` / `'removeListener'` meta-events.
 *        (None used by the runtime or its tests as of 2026-09-23.)
 *
 * @param {EventTarget} target
 * @returns {EventTarget} the same target, for chaining
 */
export function applyEmitterCompat(target) {
  if (typeof target.addEventListener !== 'function') {
    throw new TypeError('applyEmitterCompat requires an EventTarget instance');
  }
  if (target[kAppliedSymbol]) {
    return target;
  }

  // Idempotency marker (non-enumerable so it doesn't pollute Object.keys / for-in).
  Object.defineProperty(target, kAppliedSymbol, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  // Per-instance listener tracking. Keyed by event name -> Set of listeners
  // (wrappers, not originals). Populated by the addEventListener/removeEventListener
  // overrides below.
  const tracking = new Map();
  Object.defineProperty(target, '__emitterCompatTracking', {
    value: tracking,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  // ── Listener registration ───────────────────────────────────────────────

  /**
   * Register a listener for `eventName`. Returns the target for chaining.
   * Mirrors EventEmitter's `.on()` / `.addListener()`.
   */
  function on(eventName, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('The listener must be a function');
    }
    const wrapped = wrapListener(listener);
    let perEvent = kWrappedListeners.get(listener);
    if (!perEvent) {
      perEvent = new Map();
      kWrappedListeners.set(listener, perEvent);
    }
    perEvent.set(eventName, wrapped);
    this.addEventListener(eventName, wrapped);
    return this;
  }

  /**
   * Register a one-shot listener. Returns the target for chaining.
   * Mirrors EventEmitter's `.once()`.
   */
  function once(eventName, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('The listener must be a function');
    }
    const wrapped = function compatOnceListener(event) {
      const payload =
        event && typeof event === 'object' && 'detail' in event ? event.detail : event;
      return listener(payload);
    };
    this.addEventListener(eventName, wrapped, { once: true });
    return this;
  }

  /**
   * Remove a previously-registered listener. Returns the target for chaining.
   * Mirrors EventEmitter's `.off()` / `.removeListener()`.
   *
   * If `listener` was registered for multiple events, only the matching event
   * is removed. Pass no `listener` to remove all listeners for the event
   * (handled by `removeAllListeners()`).
   */
  function off(eventName, listener) {
    if (listener === undefined) {
      return this.removeAllListeners(eventName);
    }
    if (typeof listener !== 'function') {
      throw new TypeError('The listener must be a function');
    }
    const perEvent = kWrappedListeners.get(listener);
    const wrapped = perEvent?.get(eventName);
    if (wrapped) {
      this.removeEventListener(eventName, wrapped);
      perEvent.delete(eventName);
      if (perEvent.size === 0) {
        kWrappedListeners.delete(listener);
      }
    }
    return this;
  }

  // ── Dispatch (the EventEmitter `.emit()` shim) ──────────────────────────

  /**
   * Dispatch an event with a payload. Returns the result of `dispatchEvent`.
   *
   * **Semantics differ from EventEmitter:**
   * - EventEmitter: `true` if listeners exist, `false` otherwise.
   * - EventTarget (`dispatchEvent`): `false` if `preventDefault()` was called,
   *   `true` otherwise.
   *
   * Most consumers don't rely on the boolean return value.
   *
   * **Special case for `'error'` event:** preserves EventEmitter semantics —
   * throws the error if no listener is registered. This matches Node's
   * long-standing convention (uncaught 'error' events crash the process).
   */
  function emit(eventName, payload) {
    if (eventName === 'error' && !hasErrorListener.call(this)) {
      if (payload instanceof Error) {
        throw payload;
      }
      throw new Error(`Unhandled "error" event: ${String(payload)}`);
    }
    const event =
      payload === undefined
        ? new Event(eventName)
        : new CustomEvent(eventName, { detail: payload });
    return this.dispatchEvent(event);
  }

  // ── Bulk listener operations ────────────────────────────────────────────

  function removeAllListeners(eventName) {
    if (eventName === undefined) {
      // Remove all listeners for all events
      for (const [type, listeners] of [...tracking.entries()]) {
        for (const listener of [...listeners]) {
          origRemoveEventListener.call(this, type, listener);
        }
        tracking.delete(type);
      }
      // Also clear the WeakMap registrations we made
      kWrappedListeners.clear();
      return this;
    }
    const listeners = tracking.get(eventName);
    if (listeners) {
      for (const listener of [...listeners]) {
        origRemoveEventListener.call(this, eventName, listener);
      }
      tracking.delete(eventName);
    }
    // Also drop WeakMap entries pointing to this event
    for (const [originalListener, perEvent] of [...kWrappedListeners.entries()]) {
      if (perEvent.has(eventName)) {
        perEvent.delete(eventName);
        if (perEvent.size === 0) {
          kWrappedListeners.delete(originalListener);
        }
      }
    }
    return this;
  }

  function listenerCount(eventName) {
    if (eventName === undefined) {
      // EventTarget doesn't have a global count without enumerating; return 0
      // to match EventEmitter's "no listeners for any event" semantic for the
      // single-event overload.
      return 0;
    }
    return tracking.get(eventName)?.size ?? 0;
  }

  function hasErrorListener() {
    const listeners = tracking.get('error');
    return listeners !== undefined && listeners.size > 0;
  }

  // ── Wrap addEventListener / removeEventListener for tracking ────────────
  //
  // We preserve references to the originals so removeAllListeners can call them
  // without re-entering our overrides (avoiding double-tracking during bulk
  // removal).

  const origAddEventListener = target.addEventListener.bind(target);
  const origRemoveEventListener = target.removeEventListener.bind(target);

  target.addEventListener = function compatAddEventListener(type, listener, options) {
    let perType = tracking.get(type);
    if (!perType) {
      perType = new Set();
      tracking.set(type, perType);
    }
    perType.add(listener);
    return origAddEventListener(type, listener, options);
  };

  target.removeEventListener = function compatRemoveEventListener(type, listener, options) {
    const perType = tracking.get(type);
    if (perType) {
      perType.delete(listener);
      if (perType.size === 0) {
        tracking.delete(type);
      }
    }
    return origRemoveEventListener(type, listener, options);
  };

  // ── Attach the EventEmitter-like methods ────────────────────────────────

  target.on = on;
  target.addListener = on; // alias
  target.once = once;
  target.off = off;
  target.removeListener = off;
  target.emit = emit;
  target.removeAllListeners = removeAllListeners;
  target.listenerCount = listenerCount;
  target.hasErrorListener = hasErrorListener;

  return target;
}
