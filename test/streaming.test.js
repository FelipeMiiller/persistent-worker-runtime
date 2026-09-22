/**
 * Streaming tests — ADR-0012 / .specs/features/streaming-results/spec.md.
 *
 * T2 covers the **worker-side** protocol: generator-function detection
 * and the MSG_STREAM_* IPC frames produced by `runStream()`. The
 * main-side Stream class (T3) and `runtime.stream()` API (T4) are tested
 * elsewhere once the consumer side is in place.
 *
 * Each test uses a `MockPort` that records every `postMessage` so the
 * protocol can be asserted byte-for-byte.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPauseController, isGeneratorFunction, runStream } from '../src/stream-runner.js';

function createMockPort() {
  const sent = [];
  return {
    sent,
    postMessage(message) {
      // structuredClone so the recorded copy can't be mutated by the caller
      sent.push(structuredClone(message));
    },
  };
}

describe('ADR-0012 — streaming worker protocol (T2)', () => {
  describe('isGeneratorFunction', () => {
    it('returns true for an async generator function', () => {
      assert.equal(
        isGeneratorFunction(async function* () {}),
        true,
      );
    });

    it('returns true for a sync generator function', () => {
      assert.equal(
        isGeneratorFunction(function* () {}),
        true,
      );
    });

    it('returns false for a regular async function', () => {
      assert.equal(
        isGeneratorFunction(async () => {}),
        false,
      );
    });

    it('returns false for a regular function', () => {
      assert.equal(
        isGeneratorFunction(() => {}),
        false,
      );
    });

    it('returns false for an arrow function', () => {
      assert.equal(
        isGeneratorFunction(() => {}),
        false,
      );
    });

    it('returns false for non-functions', () => {
      assert.equal(isGeneratorFunction(null), false);
      assert.equal(isGeneratorFunction(undefined), false);
      assert.equal(isGeneratorFunction(42), false);
      assert.equal(isGeneratorFunction({}), false);
    });
  });

  describe('runStream — AsyncGeneratorFunction', () => {
    it('emits a MSG_STREAM_CHUNK per yield with monotonic seq numbers', async () => {
      const port = createMockPort();
      const fn = async function* (payload) {
        yield payload.start;
        yield payload.start + 1;
        yield payload.start + 2;
      };
      await runStream({
        parentPort: port,
        taskId: 't_1',
        fn,
        payload: { start: 10 },
        localStorage: new Map(),
        context: {},
      });

      const chunks = port.sent.filter((m) => m.type === 'MSG_STREAM_CHUNK');
      assert.equal(chunks.length, 3);
      assert.deepEqual(
        chunks.map((c) => ({ taskId: c.taskId, seq: c.seq, chunk: c.chunk })),
        [
          { taskId: 't_1', seq: 0, chunk: 10 },
          { taskId: 't_1', seq: 1, chunk: 11 },
          { taskId: 't_1', seq: 2, chunk: 12 },
        ],
      );

      const end = port.sent[port.sent.length - 1];
      assert.equal(end.type, 'MSG_STREAM_END');
      assert.equal(end.taskId, 't_1');
      assert.equal(end.aborted, undefined, 'normal completion is not aborted');
    });

    it('emits an empty stream (zero chunks) followed by MSG_STREAM_END', async () => {
      const port = createMockPort();
      const fn = async function* () {
        // returns immediately — yields nothing
      };
      await runStream({
        parentPort: port,
        taskId: 't_empty',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
      });

      assert.equal(port.sent.length, 1);
      assert.equal(port.sent[0].type, 'MSG_STREAM_END');
      assert.equal(port.sent[0].returnValue, undefined);
    });

    it('propagates the generator return value in MSG_STREAM_END.returnValue', async () => {
      const port = createMockPort();
      const fn = async function* () {
        yield 'a';
        return { totalChunks: 1, sentinel: 42 };
      };
      await runStream({
        parentPort: port,
        taskId: 't_ret',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
      });

      const end = port.sent.find((m) => m.type === 'MSG_STREAM_END');
      assert.deepEqual(end.returnValue, { totalChunks: 1, sentinel: 42 });
    });

    it('emits MSG_STREAM_ERROR when the generator throws', async () => {
      const port = createMockPort();
      const fn = async function* () {
        yield 'first';
        throw new Error('boom from generator');
      };
      await runStream({
        parentPort: port,
        taskId: 't_err',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
      });

      const chunks = port.sent.filter((m) => m.type === 'MSG_STREAM_CHUNK');
      const errors = port.sent.filter((m) => m.type === 'MSG_STREAM_ERROR');
      assert.equal(chunks.length, 1, 'one chunk before the throw');
      assert.equal(chunks[0].chunk, 'first');
      assert.equal(errors.length, 1);
      assert.equal(errors[0].error.message, 'boom from generator');
      assert.equal(errors[0].error.name, 'Error');
      assert.ok(errors[0].error.stack, 'error.stack is captured');
    });

    it('passes payload, localStorage, and context into the generator', async () => {
      const port = createMockPort();
      const storage = new Map();
      storage.set('seed', 7);
      const ctx = { marker: 'CTX' };
      const fn = async function* (payload, state, context) {
        assert.equal(payload.value, 'pv');
        assert.equal(state.get('seed'), 7);
        assert.equal(context.marker, 'CTX');
        yield state.get('seed');
      };
      await runStream({
        parentPort: port,
        taskId: 't_args',
        fn,
        payload: { value: 'pv' },
        localStorage: storage,
        context: ctx,
      });

      const chunk = port.sent.find((m) => m.type === 'MSG_STREAM_CHUNK');
      assert.equal(chunk.chunk, 7);
    });
  });

  describe('runStream — sync GeneratorFunction', () => {
    it('emits chunks + MSG_STREAM_END for a regular function*', async () => {
      const port = createMockPort();
      const fn = function* () {
        yield 1;
        yield 2;
        yield 3;
      };
      await runStream({
        parentPort: port,
        taskId: 't_sync',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
      });

      const chunks = port.sent.filter((m) => m.type === 'MSG_STREAM_CHUNK');
      assert.deepEqual(
        chunks.map((c) => c.chunk),
        [1, 2, 3],
      );
      const end = port.sent[port.sent.length - 1];
      assert.equal(end.type, 'MSG_STREAM_END');
    });

    it('emits MSG_STREAM_ERROR when a sync generator throws', async () => {
      const port = createMockPort();
      const fn = function* () {
        yield; // satisfy Biome useYield; the throw below is the test target
        throw new Error('sync boom');
      };
      await runStream({
        parentPort: port,
        taskId: 't_sync_err',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
      });

      const errors = port.sent.filter((m) => m.type === 'MSG_STREAM_ERROR');
      assert.equal(errors.length, 1);
      assert.equal(errors[0].error.message, 'sync boom');
    });
  });

  describe('runStream — abort signal (MSG_STREAM_ABORT pathway)', () => {
    it('runs generator finally blocks when aborted mid-stream', async () => {
      const port = createMockPort();
      let finallyRan = false;
      // Use a per-yield await so the generator is reliably suspended at
      // a yield point when the abort signal fires (no race with natural
      // completion on fast machines).
      let releaseGate;
      const gate = new Promise((r) => {
        releaseGate = r;
      });
      const fn = async function* () {
        try {
          yield 'a';
          await gate; // block here until the test releases
          yield 'b';
          yield 'c';
        } finally {
          finallyRan = true;
        }
      };
      const ac = new AbortController();
      const promise = runStream({
        parentPort: port,
        taskId: 't_abort',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
        signal: ac.signal,
      });

      // Wait until the first chunk has been emitted; then we know the
      // generator is suspended at `await gate` and the abort will
      // genuinely interrupt it (rather than letting it run to natural
      // completion on a fast machine).
      for (let i = 0; i < 50 && !port.sent.some((m) => m.type === 'MSG_STREAM_CHUNK'); i++) {
        await new Promise((r) => setImmediate(r));
      }
      assert.ok(
        port.sent.some((m) => m.type === 'MSG_STREAM_CHUNK'),
        'first chunk should have been emitted before abort',
      );
      ac.abort('consumer-break');
      // Give the abort listener + gen.return() time to drive finally.
      await new Promise((r) => setImmediate(r));
      // Release the gate so the generator would otherwise continue.
      releaseGate();
      await promise;

      assert.equal(finallyRan, true, 'generator finally block must run on abort');
      const end = port.sent.find((m) => m.type === 'MSG_STREAM_END');
      assert.ok(end, 'MSG_STREAM_END must be sent even on abort');
      assert.equal(end.aborted, true);
      assert.equal(end.reason, 'consumer-break');
      // Should not have emitted an error frame after the abort path.
      const errors = port.sent.filter((m) => m.type === 'MSG_STREAM_ERROR');
      assert.equal(errors.length, 0, 'abort path must not emit MSG_STREAM_ERROR');
    });

    it('aborts immediately when signal is already aborted at call time', async () => {
      const port = createMockPort();
      let ranAnyYield = false;
      const fn = async function* () {
        ranAnyYield = true;
        yield 'never';
      };
      const ac = new AbortController();
      ac.abort();
      await runStream({
        parentPort: port,
        taskId: 't_preabort',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
        signal: ac.signal,
      });
      assert.equal(ranAnyYield, false);
      const end = port.sent.find((m) => m.type === 'MSG_STREAM_END');
      assert.ok(end);
      assert.equal(end.aborted, true);
    });

    it('runs cleanly when no signal is provided', async () => {
      const port = createMockPort();
      const fn = async function* () {
        yield 1;
      };
      await runStream({
        parentPort: port,
        taskId: 't_nosig',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
      });
      const end = port.sent.find((m) => m.type === 'MSG_STREAM_END');
      assert.ok(end);
      assert.equal(end.aborted, undefined);
    });
  });

  describe('createPauseController — T5 backpressure primitive', () => {
    it('starts unpaused and resolves waitWhilePaused immediately', async () => {
      const pc = createPauseController();
      assert.equal(pc.paused, false);
      // Should resolve on the next microtask, not block.
      const start = Date.now();
      await pc.waitWhilePaused();
      assert.ok(Date.now() - start < 20, 'unpaused wait must not block');
    });

    it('parks waitWhilePaused() while paused and resumes on resume()', async () => {
      const pc = createPauseController();
      pc.pause();
      assert.equal(pc.paused, true);
      let resolved = false;
      const p = pc.waitWhilePaused().then(() => {
        resolved = true;
      });
      // Yield a few microtasks; the promise must still be pending.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(resolved, false, 'parked waiter must not resolve while paused');
      pc.resume();
      await p;
      assert.equal(resolved, true);
      assert.equal(pc.paused, false);
    });

    it('wakes every waiter on resume() (no lost wakeup)', async () => {
      const pc = createPauseController();
      pc.pause();
      let a = false;
      let b = false;
      let c = false;
      const pa = pc.waitWhilePaused().then(() => {
        a = true;
      });
      const pb = pc.waitWhilePaused().then(() => {
        b = true;
      });
      const pc2 = pc.waitWhilePaused().then(() => {
        c = true;
      });
      pc.resume();
      await Promise.all([pa, pb, pc2]);
      assert.equal(a && b && c, true, 'every waiter must resolve on resume');
    });
  });

  describe('runStream — pause / resume (MSG_STREAM_PAUSE / RESUME pathway, T5)', () => {
    it('parks the generator between yields when pauseController is paused', async () => {
      const port = createMockPort();
      const fn = async function* () {
        yield 'a';
        yield 'b';
        yield 'c';
      };
      const pc = createPauseController();
      // Start paused BEFORE runStream — first iteration parks, then we
      // resume to let everything drain.
      pc.pause();
      const runP = runStream({
        parentPort: port,
        taskId: 't_pause',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
        pauseController: pc,
      });
      // Yield a few microtasks; nothing should be posted yet.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(
        port.sent.length,
        0,
        'paused generator must not post any MSG_STREAM_CHUNK frames yet',
      );
      pc.resume();
      await runP;
      const chunks = port.sent.filter((m) => m.type === 'MSG_STREAM_CHUNK');
      assert.equal(chunks.length, 3, 'all three chunks should arrive after resume');
      const end = port.sent[port.sent.length - 1];
      assert.equal(end.type, 'MSG_STREAM_END');
      assert.equal(end.aborted, undefined);
    });

    it('honors pause/resume toggled mid-stream', async () => {
      const port = createMockPort();
      const fn = async function* () {
        for (let i = 0; i < 5; i++) yield i;
      };
      const pc = createPauseController();
      const runP = runStream({
        parentPort: port,
        taskId: 't_mid',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
        pauseController: pc,
      });
      // Let the first chunk post, then pause, then resume.
      await new Promise((r) => setImmediate(r));
      const initial = port.sent.length;
      assert.ok(initial >= 1, 'first chunk should arrive before we pause');
      pc.pause();
      // Give the loop time to settle on pause; no further chunks.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const afterPause = port.sent.length;
      pc.resume();
      await runP;
      const chunks = port.sent.filter((m) => m.type === 'MSG_STREAM_CHUNK');
      assert.equal(chunks.length, 5, 'all five chunks should eventually arrive');
      assert.ok(
        afterPause >= initial && afterPause <= initial + 1,
        'pause should hold the stream between yields (at most 1 extra chunk posted in flight)',
      );
    });

    it('wakes a parked waiter when the signal aborts (no mid-stream hang)', async () => {
      const port = createMockPort();
      const fn = async function* () {
        yield 'x';
        // Generator would yield more, but we'll be paused+aborted by then.
        yield 'y';
      };
      const pc = createPauseController();
      const ac = new AbortController();
      pc.pause();
      const runP = runStream({
        parentPort: port,
        taskId: 't_abortpark',
        fn,
        payload: null,
        localStorage: new Map(),
        context: {},
        signal: ac.signal,
        pauseController: pc,
      });
      // Generator is parked at waitWhilePaused before posting 'x'.
      await new Promise((r) => setImmediate(r));
      assert.equal(port.sent.length, 0, 'should be parked before any post');
      ac.abort('test-abort');
      await runP;
      // The abort listener should resume the pauseController so the
      // loop re-enters, sees `aborted=true`, runs gen.return(), and
      // posts MSG_STREAM_END {aborted:true}.
      const end = port.sent[port.sent.length - 1];
      assert.equal(end.type, 'MSG_STREAM_END');
      assert.equal(end.aborted, true);
      assert.equal(end.reason, 'test-abort');
    });
  });
});
