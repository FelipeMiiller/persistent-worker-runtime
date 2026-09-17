/**
 * T4 integration tests — `runtime.stream(fn, payload, options)`.
 *
 * These run an actual `WorkerRuntime` with a real worker thread and
 * exercise the end-to-end IPC path:
 *   runtime.stream() → WorkerHandle.executeStreamTask() →
 *   worker-thread-entry (T2) → runStream() → MSG_STREAM_* IPC frames →
 *   WorkerHandle stream handler → Stream.push*().
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { StreamConfigError, WorkerRuntimeError } from '../src/errors.js';
import { createWorkerRuntime } from '../src/index.js';

let runtime;
afterEach(async () => {
  if (runtime) {
    await runtime.shutdown();
    runtime = null;
  }
});

describe('ADR-0012 — runtime.stream() API (T4)', () => {
  describe('input validation', () => {
    it('throws StreamConfigError (a TypeError) for non-function taskFn', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      assert.throws(
        () => runtime.stream(42, null),
        (err) => {
          assert.ok(err instanceof StreamConfigError);
          assert.ok(err instanceof TypeError);
          assert.match(err.message, /taskFn/);
          return true;
        },
      );
    });

    it('throws StreamConfigError for a regular (non-generator) function', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      assert.throws(
        () => runtime.stream(async () => 1, null),
        (err) => err instanceof StreamConfigError,
      );
    });

    it('throws WorkerRuntimeError when the runtime is shutting down', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      await runtime.shutdown();
      // After shutdown the runtime rejects any further stream() calls.
      assert.throws(
        () =>
          runtime.stream(async function* () {
            yield 1;
          }, null),
        (err) => {
          assert.ok(err instanceof WorkerRuntimeError);
          return true;
        },
      );
    });
  });

  describe('end-to-end AsyncGenerator', () => {
    it('returns a Stream instance', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        yield 'a';
        yield 'b';
      });
      // Drain
      const collected = [];
      for await (const c of stream) collected.push(c);
      assert.deepEqual(collected, ['a', 'b']);
    });

    it('exposes totalChunks + endReceived in stats after completion', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        yield 1;
        yield 2;
        yield 3;
      });
      const collected = [];
      for await (const c of stream) collected.push(c);
      assert.deepEqual(collected, [1, 2, 3]);
      assert.equal(stream.stats.totalChunks, 3);
      assert.equal(stream.stats.endReceived, true);
      assert.equal(stream.stats.aborted, false);
    });

    it('propagates payload into the generator', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(
        async function* (payload) {
          yield payload.start;
          yield payload.start + 1;
        },
        { start: 100 },
      );
      const collected = [];
      for await (const c of stream) collected.push(c);
      assert.deepEqual(collected, [100, 101]);
    });

    it('propagates the generator return value via stream.returnValue', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        yield 'a';
        return { totalChunks: 1, sentinel: 'ok' };
      });
      // Drain
      for await (const _ of stream) {
        /* eslint-disable-line no-unused-vars */
      }
      assert.deepEqual(stream.returnValue, { totalChunks: 1, sentinel: 'ok' });
    });

    it('converts generator throws into pushError()', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        yield 'first';
        throw new Error('stream boom');
      });
      const collected = [];
      await assert.rejects(
        async () => {
          for await (const c of stream) collected.push(c);
        },
        (err) => err.message === 'stream boom',
      );
      assert.deepEqual(collected, ['first']);
      assert.equal(stream.stats.errorReceived, true);
    });

    it('integrates with consumer break in for-await-of', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        try {
          yield 1;
          yield 2;
          yield 3;
          yield 4;
        } finally {
          // marker — observable via stream.stats only, not user-visible
        }
      });
      const collected = [];
      for await (const c of stream) {
        collected.push(c);
        if (c === 2) break;
      }
      assert.deepEqual(collected, [1, 2]);
      assert.equal(stream.aborted, true);
      assert.equal(stream.abortedReason, 'consumer-return');
    });

    it('integrates with external AbortSignal', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const ac = new AbortController();
      const stream = runtime.stream(
        async function* ({ signal }) {
          try {
            yield 1;
            yield 2;
            // Pretend to be a long-running source that respects the signal
            // in a for-await-of-style loop.
            for (let i = 0; i < 10; i++) {
              if (signal?.aborted) return;
              yield i;
            }
          } finally {
            // cleanup
          }
        },
        { signal: ac.signal },
        { signal: ac.signal },
      );
      const collected = [];
      let aborted = false;
      for await (const c of stream) {
        collected.push(c);
        if (c === 2) {
          ac.abort('test-abort');
        }
        if (collected.length > 5) break; // safety
        aborted = stream.aborted;
      }
      assert.equal(aborted, true);
      assert.ok(collected.length > 0, 'stream should have yielded at least one chunk');
    });
  });

  describe('end-to-end sync Generator', () => {
    it('streams chunks from a sync generator function', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(function* () {
        yield 'x';
        yield 'y';
        yield 'z';
      });
      const collected = [];
      for await (const c of stream) collected.push(c);
      assert.deepEqual(collected, ['x', 'y', 'z']);
    });
  });
});
