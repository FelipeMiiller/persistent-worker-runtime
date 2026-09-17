/**
 * Stream runner — worker-side protocol for `runtime.stream()`.
 *
 * Detects `AsyncGeneratorFunction` / `GeneratorFunction` task functions
 * and iterates them, emitting structured IPC frames to the main thread:
 *
 *   { type: 'MSG_STREAM_CHUNK',  taskId, seq, chunk }
 *   { type: 'MSG_STREAM_END',    taskId, returnValue, memoryUsageBytes }
 *   { type: 'MSG_STREAM_ERROR',  taskId, error: { message, stack, name } }
 *
 * The main thread replies with `MSG_STREAM_ABORT` (which signals
 * `signal.abort()`) to cancel a stream cleanly so the generator's
 * `finally` blocks can run.
 *
 * Kept as a separate module so the streaming loop can be unit-tested
 * with a mocked `parentPort` — see test/streaming.test.js.
 *
 * @see ADR-0012 / .specs/features/streaming-results/spec.md
 */

/**
 * Returns true when `fn` is an async or sync generator function.
 * Detection uses `Function.prototype.constructor.name` (per ADR-0012 spec).
 *
 * When `fn` was created via `new Function(...)` (the worker's fnCode path),
 * the generator-ness is lost — the resulting function is just a plain
 * `Function`. To work around that, callers can pass the original
 * `fnCode` source string and we'll fall back to a regex check for
 * `function*` / `async function*` tokens.
 *
 * @param {*}     fn
 * @param {string} [fnCode]  The original function source (optional).
 * @returns {boolean}
 */
export function isGeneratorFunction(fn, fnCode) {
  if (typeof fnCode === 'string' && /\b(?:async\s+)?function\s*\*/.test(fnCode)) {
    return true;
  }
  if (typeof fn !== 'function') return false;
  const name = fn.constructor?.name;
  return name === 'AsyncGeneratorFunction' || name === 'GeneratorFunction';
}

/**
 * Runs a generator function on the worker side and posts each yield as a
 * `MSG_STREAM_CHUNK` IPC message, terminating with `MSG_STREAM_END` (on
 * normal completion or abort) or `MSG_STREAM_ERROR` (on uncaught throw).
 *
 * Aborts: when `signal` aborts, the next `iterator.next()` is skipped and
 * `gen.return()` is awaited so any `finally` blocks run deterministically
 * before MSG_STREAM_END is posted. The terminating frame is posted
 * exactly once.
 *
 * @param {Object}   ctx
 * @param {Object}   ctx.parentPort        The worker's parent port (parentPort from `node:worker_threads`)
 * @param {string}   ctx.taskId            Task identifier echoed on every frame
 * @param {Function} ctx.fn                The (Async)GeneratorFunction returned by `new Function(...)`
 * @param {*}        ctx.payload           Caller payload
 * @param {Object}   ctx.localStorage      Per-worker Persistent local-state Map (L1)
 * @param {Object}   ctx.context           The execution context exposed to user code
 * @param {Object}   [ctx.signal]          An `AbortSignal`; when aborted, calls `.return()` on the iterator
 * @returns {Promise<void>}                Resolves when the stream has been fully drained or aborted
 */
export async function runStream({
  parentPort,
  taskId,
  fn,
  payload,
  localStorage,
  context,
  signal,
}) {
  let gen;
  try {
    gen = fn(payload, localStorage, context);
  } catch (err) {
    postError(parentPort, taskId, err);
    return;
  }

  // Early-exit when the signal is already aborted at call time. Skip
  // even the first iterator.next() so the generator body never runs.
  if (signal?.aborted) {
    postEnd(parentPort, taskId, { aborted: true, reason: signal.reason });
    return;
  }

  // Signal listener only flips a flag; the main loop drives
  // `gen.return()` itself so the await is sequenced correctly.
  let aborted = false;
  let abortReason;
  if (signal) {
    signal.addEventListener(
      'abort',
      () => {
        if (aborted) return;
        aborted = true;
        abortReason = signal.reason || 'abort';
      },
      { once: true },
    );
  }

  let seq = 0;
  try {
    // For both AsyncGenerator and sync Generator, [Symbol.asyncIterator]()
    // exists; for the sync case it returns the same object so the loop
    // below works uniformly.
    const iterator = gen[Symbol.asyncIterator] ? gen[Symbol.asyncIterator]() : gen;
    let step = await iterator.next();
    while (!step.done) {
      if (aborted) {
        // Caller cancelled before this chunk could be emitted. Drive the
        // iterator to a completed state via return() so finally blocks
        // run, then exit the loop and post MSG_STREAM_END.
        try {
          await gen.return();
        } catch {
          // Generator threw during cleanup — swallow; we treat the
          // stream as aborted regardless.
        }
        break;
      }

      parentPort.postMessage({
        type: 'MSG_STREAM_CHUNK',
        taskId,
        seq: seq++,
        chunk: step.value,
      });

      step = await iterator.next();
    }

    // Normal completion — `step.value` is the generator's return value.
    if (!aborted) {
      postEnd(parentPort, taskId, { returnValue: step.value });
    } else {
      // We exited the loop via the abort path; emit the end frame now
      // (only if a return() on a never-started iterator didn't already
      // do it — gen.return() on a completed generator is a no-op).
      postEnd(parentPort, taskId, { aborted: true, reason: abortReason });
    }
  } catch (err) {
    if (!aborted) {
      postError(parentPort, taskId, err);
    }
    // When aborted, treat the abort as the canonical termination; do not
    // surface a generator throw as MSG_STREAM_ERROR (it may simply be
    // the finally block cleanup failing).
  }
}

function postEnd(parentPort, taskId, extra) {
  parentPort.postMessage({
    type: 'MSG_STREAM_END',
    taskId,
    memoryUsageBytes: process.memoryUsage().heapUsed,
    ...extra,
  });
}

function postError(parentPort, taskId, err) {
  parentPort.postMessage({
    type: 'MSG_STREAM_ERROR',
    taskId,
    error: {
      message: err?.message || String(err),
      stack: err?.stack,
      name: err?.name,
      code: err?.code,
    },
    memoryUsageBytes: process.memoryUsage().heapUsed,
  });
}
