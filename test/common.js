/**
 * test/common.js — Node.js-style test helpers (ESM)
 *
 * Translated from nodejs/node `test/common/index.js` to:
 *   - ESM imports (no `require`)
 *   - Our zero-deps constraint (no `internal/test/binding`)
 *   - Our test runner (`node:test`) — but helpers are runner-agnostic
 *
 * Each helper mirrors Node's API 1:1 where it makes sense; deviations are
 * documented inline. Goal: tests read like Node tests, gain Node's "mustCall
 * exact N times" and "expectWarning" coverage.
 */

import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { isMainThread } from 'node:worker_threads';

// ─── Platform constants ──────────────────────────────────────────────────────
//
// Like Node's `common.isWindows` / `common.isLinux` etc. — use these instead of
// `process.platform === 'win32'` everywhere so the test intent reads at a
// glance. (Lifted from test/common/index.js.)
export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';
export const isMacOS = process.platform === 'darwin';
export const isFreeBSD = process.platform === 'freebsd';
export const isOpenBSD = process.platform === 'openbsd';
export const isSunOS = process.platform === 'sunos';

// ─── mustCall / mustNotCall ───────────────────────────────────────────────────
//
// `common.mustCall(fn, exact=N)` — wraps a callback so it asserts the callback
// was called EXACTLY N times by process exit. If the runtime is still alive
// when the test exits, the assertion fires on `process.on('exit')`.
//
// Why this matters: in our tests, "did event X fire?" is currently tracked
// with ad-hoc counter variables. A counter that stops at 1 can't tell you if
// the event also fired a 2nd time after the assert. mustCall fixes this.
//
// Usage:
//   runtime.on('task:completed', common.mustCall((result) => {
//     assert.equal(result.value, 42);
//   }, 1));  // exactly 1 completion
//
// If `task:completed` fires 0 or 2 times, the test FAILS at process exit.

const callChecks = [];

function runCallChecks(exitCode) {
  // Only fail mustCall assertions on a clean exit — failures during shutdown
  // can hide legitimate early-exit cases (e.g. uncaught exception test).
  if (exitCode !== 0) return;

  const failed = callChecks.filter((c) => {
    if ('minimum' in c) {
      c.messageSegment = `at least ${c.minimum}`;
      return c.actual < c.minimum;
    }
    c.messageSegment = `exactly ${c.exact}`;
    return c.actual !== c.exact;
  });

  if (failed.length === 0) return;

  for (const ctx of failed) {
    console.log(
      `Mismatched ${ctx.name}() calls. Expected ${ctx.messageSegment}, actual ${ctx.actual}.`,
    );
    console.log(ctx.stack.split('\n').slice(2).join('\n'));
  }
  process.exit(1);
}

// Install the exit listener exactly once.
if (callChecks.length === 0) {
  process.on('exit', runCallChecks);
}

const noop = () => {};

function _mustCallInner(fn, criteria, field) {
  if (process._exiting) {
    throw new Error('Cannot use mustCall() in process exit handler');
  }
  if (typeof fn === 'number') {
    criteria = fn;
    fn = noop;
  } else if (fn === undefined) {
    fn = noop;
  }
  if (typeof criteria !== 'number') {
    throw new TypeError(`Invalid ${field} value: ${criteria}`);
  }

  const context = {
    [field]: criteria,
    actual: 0,
    stack: inspect(new Error()),
    name: fn.name || '<anonymous>',
  };
  callChecks.push(context);

  const wrapped = function (...args) {
    context.actual++;
    return fn.apply(this, args);
  };
  // Preserve the wrapped fn's identity (`.name`, `.length`) so stack traces
  // and `instanceof` checks still work.
  Object.defineProperties(wrapped, {
    name: {
      value: fn.name,
      writable: false,
      enumerable: false,
      configurable: true,
    },
    length: {
      value: fn.length,
      writable: false,
      enumerable: false,
      configurable: true,
    },
  });
  return wrapped;
}

/**
 * Wrap a callback to assert it was called EXACTLY `exact` times.
 * @param {Function|number} fn - the callback to wrap (or a number to assert a no-op was called N times)
 * @param {number} [exact=1] - the expected call count
 * @returns {Function} the wrapped callback
 */
export function mustCall(fn, exact = 1) {
  return _mustCallInner(fn, exact, 'exact');
}

/**
 * Wrap a callback to assert it was called AT LEAST `minimum` times.
 * Useful for "at least one event fired" assertions where 0 fires is fatal
 * but 2+ is fine (e.g. retry loops).
 *
 * @param {Function|number} fn
 * @param {number} [minimum=1]
 * @returns {Function}
 */
export function mustCallAtLeast(fn, minimum = 1) {
  return _mustCallInner(fn, minimum, 'minimum');
}

/**
 * Wrap a callback to assert it was NEVER called. Throws immediately if
 * invoked. Use to assert "this should not happen" paths — e.g. an event that
 * should NOT fire after `runtime.shutdown()`.
 *
 * @param {string} [msg] - message to show if the callback is invoked
 * @returns {Function} the wrapped callback
 */
export function mustNotCall(msg) {
  return function mustNotCallImpl(...args) {
    const argsInfo =
      args.length > 0 ? `\ncalled with arguments: ${args.map((a) => inspect(a)).join(', ')}` : '';
    assert.fail(`${msg || 'function should not have been called'}${argsInfo}`);
  };
}

/**
 * Wrap a Node-style callback `(err, ...args)` to assert no error was thrown
 * AND it was called exactly `exact` times. Combines `mustCall` +
 * `assert.ifError(err)`.
 *
 * @param {Function} [fn]
 * @param {number} [exact=1]
 * @returns {Function}
 */
export function mustSucceed(fn, exact = 1) {
  return mustCall((err, ...args) => {
    assert.ifError(err);
    if (typeof fn === 'function') return fn.apply(this, args);
  }, exact);
}

// ─── expectWarning ───────────────────────────────────────────────────────────
//
// Asserts a `process.emit('warning', ...)` event fires with the expected name,
// message, and code. Catches drift in `PersistentWorkerRuntimeDefaultSizing`
// or any other runtime-emitted warning.
//
// Usage:
//   common.expectWarning(
//     'PersistentWorkerRuntimeDefaultSizing',
//     /started with default workers=1 on a 28-core host/,
//     'ERR_PERSISTENT_WORKER_DEFAULT_SIZING',
//   );
//   createWorkerRuntime();  // should emit the warning
//
// If the warning fires with a different message/code, the test FAILS.
// If the warning does NOT fire, the test FAILS.

let warningTrap;

export function expectWarning(name, expected, code) {
  if (warningTrap === undefined) {
    warningTrap = {};
    process.on('warning', (warning) => {
      const handler = warningTrap[warning.name];
      if (!handler) {
        // Un-expected warning: surface immediately with full inspect dump.
        throw new TypeError(
          `"${warning.name}" was triggered without being expected.\n${inspect(warning)}`,
        );
      }
      handler(warning);
    });
  }

  // Normalize `expected` to a list of [message, code] tuples.
  let expectedList;
  if (typeof expected === 'string') {
    expectedList = [[expected, code]];
  } else if (!Array.isArray(expected)) {
    // Object form: { message: code }
    expectedList = Object.entries(expected).map(([msg, c]) => [c, msg]);
  } else if (expected.length === 0 || !Array.isArray(expected[0])) {
    // Single [message, code] tuple.
    expectedList = [[expected[0], expected[1]]];
  } else {
    expectedList = expected;
  }

  warningTrap[name] = mustCall((warning) => {
    const [expectedMessage, expectedCode] = expectedList.shift();
    if (!expectedMessage) {
      assert.fail(`Unexpected extra warning received: ${inspect(warning)}`);
    }
    assert.strictEqual(warning.name, name);
    if (typeof expectedMessage === 'string') {
      assert.strictEqual(warning.message, expectedMessage);
    } else {
      assert.match(warning.message, expectedMessage);
    }
    assert.strictEqual(warning.code, expectedCode);
  }, expectedList.length);
}

// ─── sleepSync ───────────────────────────────────────────────────────────────
//
// Synchronous sleep via `Atomics.wait`. Use when a test needs to deterministically
// advance time WITHOUT yielding the event loop. Distinct from the common
// `await sleep(ms)` helper which uses `setTimeout` and DOES yield.
//
// Use cases:
//   - inside a synchronous test body where `await` isn't possible
//   - when you need the main thread to be blocked while a worker computes
//
// Limit: blocks the main thread. Don't use for > 5 seconds.

export function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  Atomics.wait(i32, 0, 0, ms);
}

// ─── async sleep ─────────────────────────────────────────────────────────────
//
// The workhorse. `await sleep(ms)` in any test body.
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── platformTimeout ─────────────────────────────────────────────────────────
//
// Multiplies a base timeout by a platform factor so tests don't flake on
// slower CI runners (Raspberry Pi, AIX, debug builds). Lifted from
// test/common/index.js.
//
// Default multipliers:
//   - Debug build: × 2
//   - RISC-V 64: × 4
//   - AIX / IBM i / Raspberry Pi: × 2
//
// Windows + Linux + macOS default CI: × 1 (no adjustment).

const isDebug = process.features.debug;
const isRiscv64 = process.arch === 'riscv64';
const isAIX = (() => {
  // `process.platform` is 'aix' on AIX/IBMi; `os.type()` differentiates.
  // Lazy import — only on AIX.
  if (process.platform === 'aix') {
    return true;
  }
  return false;
})();

export function platformTimeout(ms) {
  if (isDebug) ms *= 2;
  if (isRiscv64) ms *= 4;
  if (isAIX) ms *= 2;
  return ms;
}

// ─── getArrayBufferViews / getBufferSources ──────────────────────────────────
//
// Enumerate every TypedArray view that maps onto a given buffer's underlying
// ArrayBuffer. Used by zero-copy tests to verify ALL views see the transfer,
// not just the one passed via transferList.
//
// Example:
//   const buf = new ArrayBuffer(16);
//   const views = common.getArrayBufferViews(buf);
//   // views = [Int8Array, Uint8Array, ..., DataView] (each with byteLength 16)
//   runtime.dispatch({ payload: { buf }, transferList: [buf] });
//   for (const v of views) {
//     assert.equal(v.byteLength, 0);  // detached
//   }

const ARRAY_BUFFER_VIEWS = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
];

export function getArrayBufferViews(buf) {
  // Accept both ArrayBuffer and TypedArray views. For an ArrayBuffer,
  // `buf.buffer` is undefined — fall back to `buf` itself.
  const targetBuf = buf.buffer ?? buf;
  const byteOffset = buf.byteOffset ?? 0;
  const byteLength = buf.byteLength;
  const out = [];
  for (const type of ARRAY_BUFFER_VIEWS) {
    const { BYTES_PER_ELEMENT = 1 } = type;
    if (byteLength % BYTES_PER_ELEMENT === 0) {
      out.push(new type(targetBuf, byteOffset, byteLength / BYTES_PER_ELEMENT));
    }
  }
  return out;
}

export function getBufferSources(buf) {
  const targetBuf = buf.buffer ?? buf;
  return [...getArrayBufferViews(buf), targetBuf];
}

// ─── isMainThread guard ──────────────────────────────────────────────────────
//
// Tests that exercise worker_threads behavior should be gated by `isMainThread`
// so they don't run inside the worker they spawn (which would loop).
// Lifted from test/parallel/test-async-hooks-promise.js.

export { isMainThread };

// ─── allowGlobals / getLeakedGlobals ──────────────────────────────────────────
//
// Phase 6: leaked-globals enforcement. Node tests fail on `process.exit` if
// any unexpected global appears in `globalThis`. Catches: leaked listeners,
// unclosed handles, accidental globals.
//
// Detection is KEY-based (not value-based): `expectedGlobalKeys` is a Set of
// property names. Any `Object.getOwnPropertyNames(globalThis)` entry NOT in
// the set is a leak. Using keys instead of values avoids the `globalThis.X`
// being `undefined` problem — what matters is the NAME the test created on
// globalThis, not whether it's bound to a known value.
//
// Allow Globals via PWR_ALLOW_GLOBALS=foo,bar env var (CI escape hatch) or
// `common.allowGlobals('foo', 'bar')` from a test. The exit-time check fires
// only if `PWR_SKIP_LEAK_CHECK` is unset (default = enforce).

const expectedGlobalKeys = new Set([
  // JS primitives + intrinsic constructors (always present)
  'Array',
  'ArrayBuffer',
  'AsyncDisposableStack',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Function',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'SharedArrayBuffer',
  'String',
  'SubtleCrypto',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'WebAssembly',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'eval',
  'global',
  'globalThis',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'undefined',
  'unescape',

  // Node.js globals
  'AbortController',
  'AbortSignal',
  'AggregateError',
  'Buffer',
  'ByteLengthQueuingStrategy',
  'CloseEvent',
  'CompressionStream',
  'CountQueuingStrategy',
  'Crypto',
  'CryptoKey',
  'CustomEvent',
  'DOMException',
  'DecompressionStream',
  'DisposableStack',
  'Event',
  'EventTarget',
  'File',
  'FormData',
  'Headers',
  'Intl',
  'MessageChannel',
  'MessageEvent',
  'MessagePort',
  'Navigator',
  'Performance',
  'PerformanceEntry',
  'PerformanceMark',
  'PerformanceMeasure',
  'PerformanceObserver',
  'PerformanceObserverEntryList',
  'PerformanceResourceTiming',
  'ReadableByteStreamController',
  'ReadableStream',
  'ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest',
  'ReadableStreamDefaultController',
  'ReadableStreamDefaultReader',
  'Request',
  'Response',
  'SuppressedError',
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoder',
  'TextEncoderStream',
  'TransformStream',
  'TransformStreamDefaultController',
  'URL',
  'URLPattern',
  'URLSearchParams',
  'WebSocket',
  'WritableStream',
  'WritableStreamDefaultController',
  'WritableStreamDefaultWriter',
  'atob',
  'btoa',
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'fetch',
  'navigator',
  'performance',
  'process',
  'queueMicrotask',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'structuredClone',

  // Web platform blobs
  'Blob',
  'BroadcastChannel',
]);

export function allowGlobals(...keys) {
  for (const key of keys) expectedGlobalKeys.add(key);
}

export function getLeakedGlobals() {
  const leaked = [];
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!expectedGlobalKeys.has(name)) leaked.push(name);
  }
  return leaked;
}

// Env-var escape hatch: `PWR_ALLOW_GLOBALS=foo,bar` adds names at startup.
// Use for tests that legitimately need to add a temporary global (rare).
if (process.env.PWR_ALLOW_GLOBALS) {
  for (const name of process.env.PWR_ALLOW_GLOBALS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    expectedGlobalKeys.add(name);
  }
}

// Phase 6 enforcement: at process.exit, fail if any global was added during
// the test run that we didn't whitelist. Hook is installed on FIRST import
// of test/common.js. Disable via `PWR_SKIP_LEAK_CHECK=1`.
if (!process.env.PWR_SKIP_LEAK_CHECK) {
  let leakCheckInstalled = false;
  const installLeakCheck = () => {
    if (leakCheckInstalled) return;
    leakCheckInstalled = true;
    process.on('exit', (exitCode) => {
      if (exitCode !== 0) return; // skip on test failure (avoid noise)
      const leaked = getLeakedGlobals();
      if (leaked.length > 0) {
        console.error(`\n[leaked-globals] ${leaked.length} unexpected global(s):`);
        for (const name of leaked) {
          console.error(`  - ${name} (${typeof globalThis[name]})`);
        }
        console.error(
          "\nFix: call `common.allowGlobals('...')` in the test, or set `PWR_ALLOW_GLOBALS=name1,name2`, or remove the global pollution.",
        );
        // process.exit overrides the (0) of clean exit so CI fails on leaks.
        process.exit(1);
      }
    });
  };
  installLeakCheck();
}

// ─── expectsError (skeleton) ─────────────────────────────────────────────────
//
// Asserts a callback throws N times with an error matching `validator`. Like
// Node's `common.expectsError(validator, exact)`. We use it in tests that
// expect multiple errors (e.g. dispatch to multiple failing tasks).

export function expectsError(validator, exact = 1) {
  return mustCall((...args) => {
    if (args.length !== 1) {
      assert.fail(`Expected one argument (the error), got ${inspect(args)}`);
    }
    const error = args[0];
    // The error message should be non-enumerable (per V8 spec).
    assert.strictEqual(Object.prototype.propertyIsEnumerable.call(error, 'message'), false);
    assert.throws(() => {
      throw error;
    }, validator);
    return true;
  }, exact);
}

// ─── waitForEvent ─────────────────────────────────────────────────────────────
//
// Waits for an event to fire on an EventEmitter (or Node-style .on/.off API).
// Wraps the listener with `common.mustCall(fn, exact=N)` so the test asserts
// the event fires EXACTLY N times — catches "fired 0 times", "fired twice",
// and "fired on the wrong emitter".
//
// Replaces the ad-hoc polling pattern:
//
//   let count = 0;
//   runtime.on('worker:recycled', () => { count++; });
//   await runtime.dispatch({ fn: work });
//   const deadline = Date.now() + 3000;
//   while (count === 0 && Date.now() < deadline) await sleep(50);
//   assert.ok(count === 1);  // passes even if event fires again post-assert
//
//   const event = await common.waitForEvent(runtime, 'worker:recycled', 1, 3000);
//   assert.equal(event.workerId, expected);  // event fires EXACTLY 1x
//
// The Promise RESOLVES with the FIRST event payload. Subsequent firings are
// captured by mustCall and asserted at process.exit.
//
// @param {EventEmitter} emitter - any object with .on/.off (Node EventEmitter)
// @param {string} eventName - event to subscribe to
// @param {number} exact - expected call count (default 1)
// @param {number} [timeoutMs=3000] - timeout for resolving the Promise
// @returns {Promise<unknown>} resolves with the event payload (first fire)
// @throws {Error} if timeout elapses before event fires

export function waitForEvent(emitter, eventName, exact = 1, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let timer;
    let fired = false;
    // Capture the mustCall context for cleanup if the promise rejects. Without
    // this, a timeout leaves an unfulfilled mustCall(N) registered, and
    // process.exit complains that the listener was called 0 times.
    let mustCallContext = null;

    const handler = mustCall((payload) => {
      if (fired) return; // only resolve once
      fired = true;
      clearTimeout(timer);
      try {
        emitter.off(eventName, handler);
      } catch {
        // Some emitters use removeListener; ignore if .off doesn't exist.
      }
      resolve(payload);
    }, exact);

    timer = setTimeout(() => {
      if (fired) return;
      try {
        emitter.off(eventName, handler);
      } catch {
        // ignore
      }
      // Remove the mustCall context so a timeout doesn't fail at process.exit.
      if (mustCallContext && callChecks.includes(mustCallContext)) {
        callChecks.splice(callChecks.indexOf(mustCallContext), 1);
      }
      reject(
        new Error(
          `waitForEvent: '${eventName}' did not fire ${exact} time(s) within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    // mustCall just pushed a context; record it for cleanup.
    mustCallContext = callChecks[callChecks.length - 1];

    try {
      emitter.on(eventName, handler);
    } catch (err) {
      clearTimeout(timer);
      if (mustCallContext && callChecks.includes(mustCallContext)) {
        callChecks.splice(callChecks.indexOf(mustCallContext), 1);
      }
      reject(new Error(`waitForEvent: failed to subscribe to '${eventName}': ${err.message}`));
    }
  });
}

// ─── waitForSubscription ──────────────────────────────────────────────────────
//
// Same as `waitForEvent` but for the `runtime.subscribe(channelName, handler)`
// API (which returns an unsubscribe function, not an EventEmitter).
//
// Wraps `handler` with `mustCall(exact=N)` so the test asserts the listener
// fires EXACTLY N times. Replaces this ad-hoc pattern:
//
//   let received = null;
//   runtime.subscribe('ch', (msg) => { received = msg; });
//   await runtime.execute({ ... });
//   while (received === null && Date.now() < deadline) await sleep(50);
//   assert.deepEqual(received, expected);
//
// With:
//
//   const received = await common.waitForSubscription(
//     runtime, 'ch', 1, 2000,
//   );
//   assert.deepEqual(received, expected);
//
// Both `mustCall` (for the EXACTLY-N contract) AND the Promise (for waiting)
// are wired up; the timeout fires if the listener never gets called.
//
// @param {object} target - the runtime / publisher
// @param {string} channelName
// @param {number} exact - expected call count (default 1)
// @param {number} [timeoutMs=3000]
// @returns {Promise<unknown>} resolves with the FIRST handler payload

export function waitForSubscription(target, channelName, exact = 1, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let timer;
    let fired = false;
    let mustCallContext = null;

    const handler = mustCall((payload) => {
      if (fired) return;
      fired = true;
      clearTimeout(timer);
      try {
        unsub();
      } catch {
        // ignore
      }
      resolve(payload);
    }, exact);

    timer = setTimeout(() => {
      if (fired) return;
      try {
        unsub();
      } catch {
        // ignore
      }
      if (mustCallContext && callChecks.includes(mustCallContext)) {
        callChecks.splice(callChecks.indexOf(mustCallContext), 1);
      }
      reject(
        new Error(
          `waitForSubscription: channel '${channelName}' handler did not fire ${exact} time(s) within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    mustCallContext = callChecks[callChecks.length - 1];
    const unsub = target.subscribe(channelName, handler);
  });
}

// ─── awaitWarning ─────────────────────────────────────────────────────────────
//
// Async helper for per-test process warning assertions. Subscribes to
// `process.on('warning')`, asserts the named warning with the expected
// message/code, then auto-unsubscribes.
//
// Distinct from `expectWarning` (which uses mustCall + fires at
// process.exit). `awaitWarning` resolves during the test body, so it's
// the right choice when a SINGLE warning is expected in a SINGLE test.
//
// Usage:
//
//   let fired = null;
//   process.on('warning', (w) => { fired = w; });
//   try {
//     createWorkerRuntime({});  // emits the warning asynchronously
//     await common.awaitWarning(
//       'PersistentWorkerRuntimeDefaultSizing',
//       /started with default workers=1/,
//       1000,
//     );
//     // do more assertions on `fired`...
//   } finally {
//     process.off('warning', trap);
//   }
//
// @param {string} name - expected warning.name
// @param {string|RegExp} [expectedMessage] - optional message matcher (substring or regex)
// @param {number} [timeoutMs=3000]
// @returns {Promise<Warning>} resolves with the matching warning

export function awaitWarning(name, expectedMessage, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let timer;
    const handler = (warning) => {
      if (warning.name !== name) return;
      clearTimeout(timer);
      process.off('warning', handler);
      if (expectedMessage !== undefined) {
        if (typeof expectedMessage === 'string') {
          assert.strictEqual(warning.message, expectedMessage);
        } else {
          assert.match(warning.message, expectedMessage);
        }
      }
      resolve(warning);
    };
    process.on('warning', handler);
    timer = setTimeout(() => {
      process.off('warning', handler);
      reject(new Error(`awaitWarning: '${name}' did not fire within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}
