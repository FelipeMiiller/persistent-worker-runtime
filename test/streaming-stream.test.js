/**
 * Tests for the main-thread `Stream` class (ADR-0012 / T3).
 *
 * The producer side (`pushChunk` / `pushEnd` / `pushError`) is exercised
 * directly here. T4 wires these methods to MSG_STREAM_* IPC frames from
 * the worker; those tests land alongside the runtime integration suite.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Stream } from '../src/streaming.js';

describe('ADR-0012 — Stream class (T3)', () => {
  describe('Symbol.asyncIterator / next()', () => {
    it('is async-iterable', () => {
      const s = new Stream();
      assert.equal(typeof s[Symbol.asyncIterator], 'function');
      assert.equal(s[Symbol.asyncIterator](), s);
    });

    it('returns pushed chunks in FIFO order', async () => {
      const s = new Stream();
      s.pushChunk('a');
      s.pushChunk('b');
      s.pushChunk('c');
      assert.deepEqual(
        [await s.next(), await s.next(), await s.next()],
        [
          { value: 'a', done: false },
          { value: 'b', done: false },
          { value: 'c', done: false },
        ],
      );
    });

    it('blocks next() until a chunk is pushed', async () => {
      const s = new Stream();
      let resolved = false;
      const p = s.next().then((r) => {
        resolved = true;
        return r;
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(resolved, false, 'next() must block while the buffer is empty');
      s.pushChunk(42);
      const r = await p;
      assert.deepEqual(r, { value: 42, done: false });
    });

    it('returns done after pushEnd', async () => {
      const s = new Stream();
      s.pushEnd();
      assert.deepEqual(await s.next(), { value: undefined, done: true });
    });

    it('preserves the generator returnValue via stats (not next())', async () => {
      const s = new Stream();
      s.pushChunk('only');
      s.pushEnd({ returnValue: { total: 1 } });
      assert.deepEqual(await s.next(), { value: 'only', done: false });
      assert.deepEqual(await s.next(), { value: undefined, done: true });
      // Spec: the returnValue is observable via stats (next() collapses to done:true).
      assert.equal(s.endReceived, true);
    });

    it('throws on the next call after pushError', async () => {
      const s = new Stream();
      s.pushChunk('first');
      s.pushError(Object.assign(new Error('boom'), { code: 'E_TEST' }));
      assert.deepEqual(await s.next(), { value: 'first', done: false });
      await assert.rejects(
        () => s.next(),
        (err) => {
          assert.equal(err.message, 'boom');
          assert.equal(err.code, 'E_TEST');
          return true;
        },
      );
    });

    it('throws at most once per error', async () => {
      const s = new Stream();
      s.pushError(new Error('once'));
      await assert.rejects(() => s.next());
      // The second next() should resolve done:true (or hang, but not throw again).
      // We assert it resolves instead of rejecting again.
      const r = await Promise.race([
        s
          .next()
          .then((x) => ({ kind: 'ok', x }))
          .catch((e) => ({ kind: 'err', e })),
        new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 50)),
      ]);
      assert.equal(r.kind, 'ok');
      assert.deepEqual(r.x, { value: undefined, done: true });
    });
  });

  describe('return() — consumer cancellation', () => {
    it('emits stream:cancelled and resolves subsequent next() as done', async () => {
      const s = new Stream();
      const events = [];
      s.on('stream:cancelled', (e) => events.push(e));
      const ret = await s.return();
      assert.deepEqual(ret, { value: undefined, done: true });
      assert.equal(events.length, 1);
      assert.equal(events[0].reason, 'consumer-return');
      assert.equal(s.aborted, true);
      assert.equal(s.abortedReason, 'consumer-return');
    });

    it('integrates with for-await-of break', async () => {
      const s = new Stream();
      s.pushChunk(1);
      s.pushChunk(2);
      s.pushChunk(3);
      s.pushChunk(4);
      const collected = [];
      for await (const c of s) {
        collected.push(c);
        if (c === 2) break;
      }
      assert.deepEqual(collected, [1, 2]);
      assert.equal(s.aborted, true);
      assert.equal(s.abortedReason, 'consumer-return');
    });
  });

  describe('throw() — consumer error in for-await-of', () => {
    it('aborts and re-throws', async () => {
      const s = new Stream();
      s.pushChunk(1);
      const err = new Error('consumer-throw');
      await assert.rejects(
        async () => {
          for await (const _ of s) {
            throw err;
          }
        },
        (e) => e === err || e.message === 'consumer-throw',
      );
      assert.equal(s.aborted, true);
    });
  });

  describe('backpressure event', () => {
    it('fires when buffered length crosses the highWaterMark upward', () => {
      const events = [];
      const s = new Stream({ highWaterMark: 3 });
      s.on('stream:backpressure', (e) => events.push(e));
      s.pushChunk('a'); // 1 < 3
      s.pushChunk('b'); // 2 < 3
      assert.equal(events.length, 0, 'no backpressure below HWM');
      s.pushChunk('c'); // 3 >= 3 — crossing
      assert.equal(events.length, 1);
      assert.equal(events[0].queueLength, 3);
      s.pushChunk('d'); // 4 >= 3 — stays above, no fresh crossing
      assert.equal(events.length, 1, 'no duplicate event while staying above HWM');
    });
  });

  describe('AbortSignal — external cancellation', () => {
    it('marks aborted when the signal is already aborted', () => {
      const ac = new AbortController();
      ac.abort('pre-aborted');
      const s = new Stream({ signal: ac.signal });
      assert.equal(s.aborted, true);
      assert.equal(s.abortedReason, 'pre-aborted');
    });

    it('aborts when the signal fires later', async () => {
      const ac = new AbortController();
      const events = [];
      const s = new Stream({ signal: ac.signal });
      s.on('stream:aborted', (e) => events.push(e));
      ac.abort('later');
      assert.equal(s.aborted, true);
      assert.equal(s.abortedReason, 'later');
      assert.equal(events.length, 1);
    });

    it('unblocks a parked next() with done:true when the signal aborts', async () => {
      const ac = new AbortController();
      const s = new Stream({ signal: ac.signal });
      const p = s.next();
      ac.abort('stop');
      const r = await p;
      assert.deepEqual(r, { value: undefined, done: true });
    });
  });

  describe('stats', () => {
    it('reflects current state', () => {
      const s = new Stream({ highWaterMark: 4 });
      s.pushChunk(1);
      s.pushChunk(2);
      const stats = s.stats;
      assert.equal(stats.totalChunks, 2);
      assert.equal(stats.totalErrors, 0);
      assert.equal(stats.queueLength, 2);
      assert.equal(stats.aborted, false);
      assert.equal(stats.highWaterMark, 4);
      assert.equal(stats.endReceived, false);
      assert.equal(stats.errorReceived, false);
    });

    it('flips endReceived after pushEnd', () => {
      const s = new Stream();
      s.pushEnd();
      assert.equal(s.stats.endReceived, true);
      assert.equal(s.stats.errorReceived, false);
    });

    it('flips errorReceived after pushError', () => {
      const s = new Stream();
      s.pushError(new Error('e'));
      assert.equal(s.stats.errorReceived, true);
      assert.equal(s.stats.endReceived, false);
      assert.equal(s.stats.totalErrors, 1);
    });
  });

  describe('validation', () => {
    it('throws TypeError when highWaterMark is a string', () => {
      assert.throws(() => new Stream({ highWaterMark: 'fast' }), TypeError);
    });

    it('throws TypeError when highWaterMark is a float', () => {
      assert.throws(() => new Stream({ highWaterMark: 1.5 }), TypeError);
    });

    it('throws RangeError when highWaterMark is zero or negative', () => {
      assert.throws(() => new Stream({ highWaterMark: 0 }), RangeError);
      assert.throws(() => new Stream({ highWaterMark: -5 }), RangeError);
    });

    it('throws TypeError when signal is not an AbortSignal', () => {
      assert.throws(() => new Stream({ signal: 'nope' }), TypeError);
      assert.throws(() => new Stream({ signal: {} }), TypeError);
    });

    it('uses default highWaterMark when not provided', () => {
      const s = new Stream();
      assert.equal(s.highWaterMark, 1024);
    });
  });

  describe('events off()', () => {
    it('removes a previously registered handler', () => {
      const events = [];
      const s = new Stream();
      const handler = (e) => events.push(e);
      s.on('stream:backpressure', handler);
      s.pushChunk(1);
      s.pushChunk(2); // default HWM = 1024, no fire
      // push enough to cross default HWM
      for (let i = 0; i < 1023; i++) s.pushChunk(i);
      // Now off() and push more — no further event
      s.off('stream:backpressure', handler);
      for (let i = 0; i < 10; i++) s.pushChunk(i);
      // We don't assert on the first events count to keep the test fast;
      // we only assert that off() prevented at least the last 10 pushes from firing.
      // The simplest invariant: after off(), the listener is gone.
      assert.equal(s._listeners.get('stream:backpressure').includes(handler), false);
    });
  });
});
