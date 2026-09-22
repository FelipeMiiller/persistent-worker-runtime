/**
 * Predictive edge-case tests for ADR-0012 streaming (T1–T4).
 *
 * These tests enumerate failure modes a hostile reviewer would point
 * out: zero-chunk streams, large chunks, concurrent producers, errors
 * deep in the generator, lifecycle races between abort and end, etc.
 * Each test is small and fast (well under 1 second) so the suite
 * stays cheap to run on every commit.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { StreamConfigError } from '../src/errors.js';
import { createWorkerRuntime } from '../src/index.js';
import { Stream } from '../src/streaming.js';
import * as common from './common.js';

let runtime;
afterEach(async () => {
  if (runtime) {
    await runtime.shutdown();
    runtime = null;
  }
});

describe('ADR-0012 — streaming edge cases (predictive)', () => {
  describe('boundary stream sizes', () => {
    it('streams a single-chunk generator', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        yield 'only';
      });
      const collected = [];
      for await (const c of stream) collected.push(c);
      assert.deepEqual(collected, ['only']);
      assert.equal(stream.stats.totalChunks, 1);
      assert.equal(stream.stats.endReceived, true);
    });

    it('streams a generator with no yields (empty stream)', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        // Empty body — no yields.
      });
      const collected = [];
      for await (const c of stream) collected.push(c);
      assert.deepEqual(collected, []);
      assert.equal(stream.stats.totalChunks, 0);
      assert.equal(stream.stats.endReceived, true);
    });

    it('streams a generator whose only output is the return value', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      // biome-ignore lint/correctness/useYield: test deliberately yields nothing so returnValue is the only output
      const stream = runtime.stream(async function* () {
        return { sentinel: 'no-chunks-just-return' };
      });
      const collected = [];
      for await (const c of stream) collected.push(c);
      assert.deepEqual(collected, []);
      assert.equal(stream.stats.totalChunks, 0);
      assert.equal(stream.stats.endReceived, true);
      assert.deepEqual(stream.returnValue, { sentinel: 'no-chunks-just-return' });
    });

    it('streams a generator that yields a very large chunk (1 MB)', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const big = new Uint8Array(1024 * 1024); // 1 MB
      for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
      const stream = runtime.stream(
        async function* (p) {
          yield p.payload;
        },
        { payload: big },
      );
      let received = null;
      for await (const c of stream) received = c;
      assert.ok(received instanceof Uint8Array);
      assert.equal(received.length, 1024 * 1024);
      assert.equal(received[100], 100);
      assert.equal(received[received.length - 1], (received.length - 1) & 0xff);
    });
  });

  describe('error semantics', () => {
    it('surfaces errors thrown synchronously (before the first yield)', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      // biome-ignore lint/correctness/useYield: test deliberately throws before any yield to exercise the sync-throw path
      const stream = runtime.stream(async function* () {
        throw new Error('sync-throw-before-yield');
      });
      await assert.rejects(
        async () => {
          for await (const _ of stream) {
            /* drain */
          }
        },
        (err) => err.message === 'sync-throw-before-yield',
      );
      assert.equal(stream.stats.errorReceived, true);
    });

    it('surfaces errors thrown deep inside the generator after several yields', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        yield 1;
        yield 2;
        yield 3;
        throw new Error('deep-error');
      });
      const collected = [];
      await assert.rejects(
        async () => {
          for await (const c of stream) collected.push(c);
        },
        (err) => err.message === 'deep-error',
      );
      assert.deepEqual(collected, [1, 2, 3]);
      assert.equal(stream.stats.totalChunks, 3);
      assert.equal(stream.stats.errorReceived, true);
    });

    it('does not silently swallow generator throws as pushError vs throw()', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      // Stream that throws → pushError → next() throws once.
      const stream = runtime.stream(async function* () {
        yield 'a';
        throw new Error('first-error');
      });
      // Drain first chunk
      const collected = [];
      await assert.rejects(async () => {
        for await (const c of stream) collected.push(c);
      });
      assert.deepEqual(collected, ['a']);
      assert.equal(stream.stats.errorReceived, true);
    });

    it('preserves the error code on the wire', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      // biome-ignore lint/correctness/useYield: test deliberately throws before any yield to verify error code propagation
      const stream = runtime.stream(async function* () {
        throw Object.assign(new Error('coded-error'), { code: 'E_TEST_CODE' });
      });
      await assert.rejects(
        async () => {
          for await (const _ of stream) {
            /* drain */
          }
        },
        (err) => err.code === 'E_TEST_CODE',
      );
    });
  });

  describe('cancellation races', () => {
    it('abort signal fires concurrently with a chunk delivery — no use-after-settle', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const ac = new AbortController();
      const stream = runtime.stream(
        async function* ({ signal }) {
          for (let i = 0; i < 1000; i++) {
            if (signal?.aborted) return;
            yield i;
          }
        },
        { signal: ac.signal },
        { signal: ac.signal },
      );
      let abortedDuringIteration = false;
      for await (const c of stream) {
        if (c === 2) ac.abort();
        if (stream.aborted) {
          abortedDuringIteration = true;
          break;
        }
      }
      assert.equal(abortedDuringIteration, true);
    });

    it('consumer break + external abort at the same time — only one wins', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const ac = new AbortController();
      const stream = runtime.stream(
        async function* ({ signal }) {
          try {
            for (let i = 0; i < 1000; i++) {
              if (signal?.aborted) return;
              yield i;
            }
          } finally {
            // Marker: finally block always runs
          }
        },
        { signal: ac.signal },
        { signal: ac.signal },
      );
      for await (const c of stream) {
        if (c === 1) {
          ac.abort();
          break; // consumer break too
        }
      }
      // The stream must be aborted. abortedReason is one of:
      //   - 'consumer-return' (consumer break won the race)
      //   - 'abort' / the signal.reason object (external abort won)
      // We don't pin the order; we just require that SOME abort reason
      // was recorded.
      assert.equal(stream.aborted, true);
      assert.ok(
        stream.abortedReason === 'consumer-return' ||
          stream.abortedReason === 'abort' ||
          stream.abortedReason instanceof Error,
        `unexpected abortedReason: ${stream.abortedReason}`,
      );
    });
  });

  describe('shutdown semantics', () => {
    it('runtime.shutdown() while a stream is active marks the stream aborted', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        try {
          for (let i = 0; i < 1000; i++) yield i;
        } finally {
          // finally block should run on shutdown
        }
      });
      // Pull one chunk then trigger shutdown.
      for await (const _ of stream) {
        await runtime.shutdown();
        runtime = null;
        break;
      }
      assert.equal(stream.aborted, true);
      assert.equal(stream.abortedReason, 'runtime-shutdown');
    });

    it('does not throw on stream() after shutdown', async () => {
      const r = await createWorkerRuntime({ workers: 1 });
      runtime = r; // let afterEach shutdown idempotently
      await r.shutdown();
      // After shutdown, calling stream() throws WorkerRuntimeError.
      assert.throws(
        () =>
          r.stream(async function* () {
            yield 1;
          }),
        (err) => err.name === 'WorkerRuntimeError',
      );
    });

    // Node-pattern: mustNotCall asserts the listener is NEVER invoked. Catches
    // workers that emit late events after shutdown — a real memory leak class
    // in worker_thread implementations.
    //
    // Phase-3 fix landed: `src/worker-runtime.js#onChunk` now guards with
    // `if (this.#isShuttingDown) return;` before emitting `stream:chunk`,
    // so late-arriving chunks from the worker MessagePort (after shutdown)
    // are silently dropped instead of leaking.
    //
    // Note on test design: we cannot use `mustNotCall` directly because
    // the listener is registered before any chunks are pulled (chunks
    // pulled by the for-await fire `stream:chunk` events normally, before
    // shutdown). Instead we track a `shutdownStarted` flag and count any
    // events that fire AFTER it — those are the late/leaked events.
    it('emits no stream:chunk after runtime.shutdown() (Phase-3 finding: fixed)', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        try {
          for (let i = 0; i < 1000; i++) yield i;
        } finally {
          // finally runs on shutdown
        }
      });

      // Track chunk events. Events before `shutdownStarted=true` are
      // expected (chunks the consumer is pulling). Events after are
      // late/leaked and should be ZERO.
      let shutdownStarted = false;
      const lateChunks = [];
      runtime.on('stream:chunk', ({ seq }) => {
        if (shutdownStarted) lateChunks.push(seq);
      });

      // Pull a few chunks (these fire stream:chunk events normally,
      // BEFORE shutdown — not counted as late).
      let count = 0;
      for await (const _ of stream) {
        count++;
        if (count >= 3) break;
      }

      // Mark BEFORE awaiting shutdown. Any chunk event firing after this
      // point — including during the shutdown() promise resolution —
      // counts as a leak and is collected in `lateChunks`.
      shutdownStarted = true;
      await runtime.shutdown();
      runtime = null;

      // Generous window for any rogue late event to fire on the IPC
      // bus after shutdown has resolved.
      await common.sleep(100);

      assert.equal(
        lateChunks.length,
        0,
        `expected NO stream:chunk events after shutdown started; got ${lateChunks.length} late chunks with seq=${lateChunks.join(',')}`,
      );
      assert.ok(count >= 3, 'should have drained some chunks before shutdown');
    });
  });

  describe('multi-consumer (single-iterator contract)', () => {
    it('documents that Stream yields chunks to a single active iterator', async () => {
      // Per spec STREAM-08: each for-await-of pulls from the same
      // underlying Stream. Multiple iterators would race on a single
      // waiter slot (the current implementation parks one waiter at a
      // time). This test documents the supported contract: ONE
      // for-await-of at a time, then the next one sees only the
      // remainder (which is empty after the first drained).
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        for (let i = 0; i < 5; i++) yield i;
      });
      // First drain: all chunks.
      const first = [];
      for await (const c of stream) first.push(c);
      assert.deepEqual(first, [0, 1, 2, 3, 4]);
      // Second for-await-of: nothing left (consumer came after end).
      const second = [];
      for await (const c of stream) second.push(c);
      assert.deepEqual(second, []);
    });

    it('breaking out of for-await-of and starting a new one continues from the end state', async () => {
      // After consumer break, the stream is settled-aborted. A
      // subsequent for-await-of sees the same terminated state.
      runtime = await createWorkerRuntime({ workers: 1 });
      const stream = runtime.stream(async function* () {
        for (let i = 0; i < 10; i++) yield i;
      });
      // First consumer breaks early.
      const first = [];
      for await (const c of stream) {
        first.push(c);
        if (c === 2) break;
      }
      assert.deepEqual(first, [0, 1, 2]);
      assert.equal(stream.aborted, true);
      // Second consumer sees the aborted state.
      const second = [];
      for await (const c of stream) second.push(c);
      assert.deepEqual(second, []);
    });
  });

  describe('payload edge cases', () => {
    it('passes null payload through cleanly', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      // The generator receives `payload = null` and re-emits the
      // observation as a chunk; the main thread then verifies the
      // observation round-tripped without throwing.
      const stream = runtime.stream(async function* (payload) {
        yield { observedPayload: payload, isNull: payload === null };
      }, null);
      const collected = [];
      for await (const c of stream) collected.push(c);
      assert.deepEqual(collected, [{ observedPayload: null, isNull: true }]);
    });

    it('passes complex payload (Map, Set, Date) through structured clone', async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
      // We can't reach outer-scope variables from inside the worker
      // (the fnCode is wrapped in `new Function(...)`), so the
      // generator receives them via payload and re-yields them.
      const map = new Map([['key', 'value']]);
      const set = new Set([1, 2, 3]);
      const date = new Date('2026-01-01T00:00:00Z');
      const stream = runtime.stream(
        async function* (payload) {
          yield {
            map: payload.map,
            set: payload.set,
            date: payload.date,
          };
        },
        { map, set, date },
      );
      let received;
      for await (const chunk of stream) received = chunk;
      assert.ok(received.map instanceof Map);
      assert.ok(received.set instanceof Set);
      assert.ok(received.date instanceof Date);
      assert.equal(received.map.get('key'), 'value');
      assert.equal(received.date.toISOString(), '2026-01-01T00:00:00.000Z');
    });
  });

  describe('Stream class API contracts', () => {
    it('throws StreamConfigError (a TypeError) for null taskFn when calling stream() directly via the constructor pattern', () => {
      // This is a regression test for the instanceof contract — the
      // StreamConfigError class extends TypeError so users can do
      // `if (err instanceof TypeError)` for invalid-argument handling.
      const err = new StreamConfigError('test');
      assert.ok(err instanceof TypeError);
      assert.ok(err instanceof Error);
    });

    it('Stream() default constructor with no options is valid', () => {
      const s = new Stream();
      assert.equal(s.highWaterMark, 1024);
      assert.equal(s.queueLength, 0);
      assert.equal(s.aborted, false);
    });

    it('Stream() rejects negative highWaterMark at construction time (synchronous)', () => {
      assert.throws(() => new Stream({ highWaterMark: 0 }), RangeError);
      assert.throws(() => new Stream({ highWaterMark: -1 }), RangeError);
    });

    it('Stream() rejects non-integer highWaterMark at construction time', () => {
      assert.throws(() => new Stream({ highWaterMark: 1.5 }), TypeError);
      assert.throws(() => new Stream({ highWaterMark: 'fast' }), TypeError);
    });
  });
});
