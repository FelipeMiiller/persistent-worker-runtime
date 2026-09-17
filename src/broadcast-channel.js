/**
 * Inter-Worker BroadcastChannel wrapper.
 *
 * Wraps Node.js's native `BroadcastChannel` (web-standard API) with a
 * validated, ergonomic, lifecycle-aware API. Provides:
 *
 *   - Per-name channel caching (same name → same underlying BroadcastChannel)
 *   - Multi-subscriber fan-out within the same thread
 *   - Auto-close tracking via FinalizationRegistry so channels opened in a
 *     worker context are closed if the wrapper is garbage-collected before
 *     an explicit close()
 *   - Defensive subscriber dispatch: one throwing subscriber does not
 *     break the others
 *
 * Why native BroadcastChannel?
 *   - Zero external dependencies (Node.js >= 22 has it built-in)
 *   - O(1) bus topology: any thread with a listener on the named channel
 *     receives every publish, completely bypassing the main-thread Event
 *     Loop
 *   - Structured-clone serialization is consistent with postMessage
 *
 * @see ADR-0013 — Worker Inter-Communication via Native BroadcastChannel
 */

import { BroadcastChannel } from 'node:worker_threads';

/**
 * Registry of named BroadcastChannels owned by a single thread
 * (main thread OR a single worker thread).
 *
 * Construct one per thread; share it across that thread's code paths.
 */
export class ChannelRegistry {
  /** @type {Map<string, { wrapper: object, bc: BroadcastChannel }>} */
  #channels = new Map();

  /**
   * FinalizationRegistry that closes the underlying BroadcastChannel if
   * the wrapper object is garbage-collected before an explicit close().
   * This handles the worker-shutdown cleanup case automatically.
   */
  #finalizer = new FinalizationRegistry((bc) => {
    try {
      bc.close();
    } catch {
      // Already closed or invalid; nothing to do.
    }
  });

  /**
   * Returns a wrapper for the named channel. The wrapper exposes
   * `publish`, `subscribe`, `unsubscribe`, and `close`. Multiple calls
   * with the same name return the same wrapper (and the same underlying
   * BroadcastChannel instance).
   *
   * @param {string} name Channel name. Must be a non-empty string.
   * @returns {{ publish: Function, subscribe: Function, unsubscribe: Function, close: Function }}
   * @throws {TypeError} If `name` is not a string.
   * @throws {RangeError} If `name` is an empty string.
   */
  getChannel(name) {
    validateChannelName(name);
    const existing = this.#channels.get(name);
    if (existing) return existing.wrapper;
    return this.#createChannel(name);
  }

  /**
   * Registry-level shortcut: publishes without needing to first call
   * `getChannel(name)`.
   *
   * @param {string} name Channel name.
   * @param {*} message Structured-clone-serializable payload.
   */
  publish(name, message) {
    this.getChannel(name).publish(message);
  }

  /**
   * Registry-level shortcut: subscribes without needing to first call
   * `getChannel(name)`. Returns the same unsubscribe function as the
   * wrapper's `subscribe`.
   *
   * @param {string} name Channel name.
   * @param {(message: any) => void} handler Subscriber function.
   * @returns {() => boolean} Unsubscribe function.
   */
  subscribe(name, handler) {
    return this.getChannel(name).subscribe(handler);
  }

  /**
   * Registry-level shortcut: unsubscribes a handler from a named channel
   * without needing to first call `getChannel(name)`. Returns false if
   * the channel does not exist (i.e. never created or already closed)
   * or the handler was not registered.
   *
   * @param {string} name Channel name.
   * @param {(message: any) => void} handler Subscriber function to remove.
   * @returns {boolean} True if the handler was removed, false otherwise.
   * @throws {TypeError} If `name` is not a string.
   * @throws {RangeError} If `name` is an empty string.
   */
  unsubscribe(name, handler) {
    validateChannelName(name);
    const entry = this.#channels.get(name);
    if (!entry) return false;
    return entry.wrapper.unsubscribe(handler);
  }

  /**
   * Returns true if the named channel exists in this registry AND has
   * at least one active subscriber. A channel that has been closed or
   * never created returns false. A channel whose last subscriber was
   * removed (but the channel wrapper still exists) also returns false.
   *
   * @param {string} name Channel name.
   * @returns {boolean}
   * @throws {TypeError} If `name` is not a string.
   * @throws {RangeError} If `name` is an empty string.
   */
  hasSubscribers(name) {
    validateChannelName(name);
    const entry = this.#channels.get(name);
    if (!entry) return false;
    return entry.wrapper.subscriberCount() > 0;
  }

  /**
   * Closes every channel this registry owns. Used during worker
   * recycle, runtime shutdown, or worker-thread termination.
   *
   * @returns {number} Number of channels closed.
   */
  closeAll() {
    let count = 0;
    for (const entry of [...this.#channels.values()]) {
      if (entry.wrapper.close()) count++;
    }
    return count;
  }

  /**
   * Whether a channel with the given name exists in this registry.
   *
   * @param {string} name Channel name.
   * @returns {boolean}
   */
  has(name) {
    return this.#channels.has(name);
  }

  /** Number of channels currently registered. */
  get size() {
    return this.#channels.size;
  }

  /**
   * Internal: creates a new BroadcastChannel and its wrapper. Called
   * the first time `getChannel(name)` is invoked for a fresh name.
   *
   * @param {string} name
   * @returns {object} The wrapper exposing the channel API.
   */
  #createChannel(name) {
    const channels = this.#channels;
    const finalizer = this.#finalizer;
    const bc = new BroadcastChannel(name);
    const subscribers = new Set();
    let closed = false;

    // Single event listener that fans out to all subscribers. One bad
    // subscriber MUST NOT prevent others from receiving the message.
    bc.addEventListener('message', (event) => {
      if (closed) return;
      for (const handler of subscribers) {
        try {
          handler(event.data);
        } catch {
          // Intentionally swallowed: a throwing subscriber must not
          // disrupt the other subscribers. Production callers should
          // attach their own error logging inside the handler.
        }
      }
    });

    const wrapper = {
      publish(message) {
        if (closed) {
          throw new Error(`Channel '${name}' is closed`);
        }
        bc.postMessage(message);
      },

      subscribe(handler) {
        if (closed) {
          throw new Error(`Channel '${name}' is closed`);
        }
        if (typeof handler !== 'function') {
          throw new TypeError('subscribe() requires a function handler');
        }
        subscribers.add(handler);
        // Return an idempotent unsubscribe function so callers can
        // detach without needing the registry reference.
        return () => subscribers.delete(handler);
      },

      unsubscribe(handler) {
        return subscribers.delete(handler);
      },

      subscriberCount() {
        return subscribers.size;
      },

      close() {
        if (closed) return false;
        closed = true;
        subscribers.clear();
        try {
          bc.close();
        } catch {
          // Already closed; nothing to do.
        }
        // The wrapper will be GC'd shortly. Unregister it from the
        // finalizer so we don't double-close.
        finalizer.unregister(wrapper);
        channels.delete(name);
        return true;
      },
    };

    // If the wrapper is GC'd before close() is called (e.g. worker
    // crashes without cleanup), the finalizer closes the BC. This is
    // the safety net that prevents dangling handles from blocking
    // thread exit.
    finalizer.register(wrapper, bc, wrapper);

    channels.set(name, { wrapper, bc });
    return wrapper;
  }
}

/**
 * Internal helper: validates a channel name. Exported via the module
 * only for testability.
 *
 * @param {*} name Candidate channel name.
 * @throws {TypeError} If `name` is not a string.
 * @throws {RangeError} If `name` is an empty string.
 */
export function validateChannelName(name) {
  if (typeof name !== 'string') {
    throw new TypeError(
      `Channel name must be a string, got ${name === null ? 'null' : typeof name}`,
    );
  }
  if (name.length === 0) {
    throw new RangeError('Channel name must be a non-empty string');
  }
}
