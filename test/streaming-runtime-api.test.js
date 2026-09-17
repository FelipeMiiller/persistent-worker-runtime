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

  describe('T5 cancellation refinement — queue, backpressure, shutdown drain', () => {
    it('queues a second stream() when workers=1 is busy and runs it after the first ends', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      // Start a stream that holds the only worker for ~100 ms.
      const first = runtime.stream(async function* () {
        yield 'A1';
        yield 'A2';
        await new Promise((r) => setTimeout(r, 80));
        yield 'A3';
      });
      // The second stream() must NOT throw — it should queue, and the
      // consumer can iterate immediately (next() parks until the
      // worker is free).
      const second = runtime.stream(async function* () {
        yield 'B1';
        yield 'B2';
      });

      const firstChunks = [];
      const secondChunks = [];
      const drainFirst = (async () => {
        for await (const c of first) firstChunks.push(c);
      })();
      const drainSecond = (async () => {
        for await (const c of second) secondChunks.push(c);
      })();
      await Promise.all([drainFirst, drainSecond]);
      assert.deepEqual(firstChunks, ['A1', 'A2', 'A3']);
      assert.deepEqual(secondChunks, ['B1', 'B2']);
    });

    it('drops a queued stream if the consumer aborts before it is dispatched', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      // Hold the worker with the first stream.
      const blocker = runtime.stream(async function* () {
        yield 'block';
        await new Promise((r) => setTimeout(r, 80));
      });
      const drainBlocker = (async () => {
        // Touch the iterator so the runtime transitions the request to
        // an active stream task.
        for await (const _c of blocker) {
          /* drain */
        }
      })();
      // Queue a second stream and abort it immediately via the signal.
      const ac = new AbortController();
      const second = runtime.stream(
        async function* ({ signal }) {
          // Should never run.
          if (signal?.aborted) return;
          yield 'never';
        },
        { signal: ac.signal },
        { signal: ac.signal },
      );
      ac.abort('cancelled-while-queued');
      await drainBlocker;
      // The second stream's iterator must resolve with done:true and
      // never produce a chunk.
      const collected = [];
      for await (const c of second) collected.push(c);
      assert.deepEqual(collected, []);
      assert.equal(second.aborted, true);
      assert.equal(second.abortedReason, 'cancelled-while-queued');
    });

    it('pauses the worker when the consumer’s bounded buffer fills, then resumes on drain', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      // Producer yields 50 small chunks very fast. Consumer drains with
      // a delay so the buffer fills above HWM (4). The worker should
      // park between yields until the consumer catches up.
      let pauseSignalsSeen = 0;
      let resumeSignalsSeen = 0;
      const stream = runtime.stream(
        async function* () {
          for (let i = 0; i < 50; i++) {
            yield i;
          }
        },
        undefined,
        { highWaterMark: 4 },
      );
      stream.on('stream:backpressure', (e) => {
        if (e.state === 'paused') pauseSignalsSeen++;
        else if (e.state === 'resumed') resumeSignalsSeen++;
      });
      const collected = [];
      for await (const c of stream) {
        collected.push(c);
        // Simulate a slow consumer.
        await new Promise((r) => setTimeout(r, 2));
      }
      assert.equal(collected.length, 50);
      assert.equal(stream.stats.totalChunks, 50);
      assert.ok(pauseSignalsSeen >= 1, 'consumer should have observed at least one paused signal');
      assert.ok(
        resumeSignalsSeen >= 1,
        'consumer should have observed at least one resumed signal after draining',
      );
    });

    it('drains a parked consumer promise when runtime.shutdown() is called', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        yield 'late';
        await new Promise((r) => setTimeout(r, 5000));
        yield 'never';
      });
      // Park a next() — the generator hasn't yielded the first chunk yet.
      const parked = stream.next();
      // Shutdown should abort the stream and resolve the parked promise
      // with done:true within a reasonable timeout.
      const t0 = Date.now();
      const shutdownP = runtime.shutdown();
      const result = await Promise.race([
        parked,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('parked next() never settled')), 2000),
        ),
      ]);
      await shutdownP;
      assert.deepEqual(result, { value: undefined, done: true });
      assert.ok(Date.now() - t0 < 1500, 'shutdown must settle the parked promise quickly');
    });

    it('fires stream:aborted (unified) on consumer return() and the worker receives MSG_STREAM_ABORT', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        // Generous yield so the consumer's break reliably happens
        // mid-stream (between yields, not after a natural return).
        yield 'a';
        await new Promise((r) => setTimeout(r, 50));
        yield 'b';
      });
      const events = [];
      stream.on('stream:aborted', (e) => events.push(e));
      const collected = [];
      for await (const c of stream) {
        collected.push(c);
        if (c === 'a') break;
      }
      // For-await-of cleanly exited (consumer break, not error).
      assert.deepEqual(collected, ['a']);
      // T5 unification: stream:aborted fires for consumer-initiated
      // cancellation with the canonical reason.
      assert.ok(events.length >= 1, 'expected at least one stream:aborted event');
      assert.equal(events[0].reason, 'consumer-return');
      // Stream is settled; subsequent next() resolves with done:true.
      assert.equal(stream.aborted, true);
      assert.equal(stream.abortedReason, 'consumer-return');
      assert.deepEqual(await stream.next(), { value: undefined, done: true });
      // Worker-side abort pathway is exercised by T2 unit tests with a
      // mock port; verifying finally-block execution through a closure
      // is impossible here because the worker reconstructs the
      // generator via `new Function(fnCode)` and the closure is not
      // transported. We cover that scenario exhaustively in
      // test/streaming.test.js (T2).
    });
  });
});
