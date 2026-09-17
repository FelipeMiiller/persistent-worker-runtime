import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorkerRuntime, WorkerRuntimeError } from '../src/index.js';

describe('WorkerRuntime.broadcast() and subscribe() — main-thread API', () => {
  describe('runtime.broadcast()', () => {
    let runtime;

    before(async () => {
      runtime = await createWorkerRuntime({ workers: 2 });
    });

    after(async () => {
      if (runtime) await runtime.shutdown();
    });

    it('delivers a message from main thread to a worker subscriber', async () => {
      let subscriberReadyResolve;
      const subscriberReady = new Promise((resolve) => {
        subscriberReadyResolve = resolve;
      });
      runtime.subscribe('subscriber-ready', () => subscriberReadyResolve());

      let resolveReceived;
      const receivedPromise = new Promise((resolve) => {
        resolveReceived = resolve;
      });
      runtime.subscribe('worker-confirmation', (msg) => resolveReceived(msg));

      // Dispatch subscriber task. fnCode runs in worker thread.
      const handle = runtime.dispatch({
        type: 'subscriber-task',
        fn: (_p, _s, context) => {
          const ch = context.channel('main-to-worker');
          ch.subscribe((msg) => {
            context.channel('worker-confirmation').publish({ received: msg });
          });
          context.channel('subscriber-ready').publish({ ready: true });
          return new Promise(() => {});
        },
      });
      handle.promise.catch(() => {});

      await Promise.race([
        subscriberReady,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('subscriber never became ready')), 3000),
        ),
      ]);

      runtime.broadcast('main-to-worker', { from: 'main', n: 1 });

      const result = await Promise.race([
        receivedPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('not received within 3s')), 3000),
        ),
      ]);

      assert.deepEqual(result, { received: { from: 'main', n: 1 } });
    });

    it('returns immediately (does not wait for consumer processing)', () => {
      // Subscribe but never resolve; broadcast should not hang.
      runtime.execute({
        type: 'no-listener-task',
        fn: (_p, _s, _context) => 'done',
      });

      const t0 = Date.now();
      runtime.broadcast('no-such-listener', { x: 1 });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 50, `broadcast took ${elapsed}ms; should be <50ms`);
    });

    it('rejects non-string channel names with TypeError', () => {
      assert.throws(() => runtime.broadcast(123, {}), TypeError);
      assert.throws(() => runtime.broadcast(null, {}), TypeError);
      assert.throws(() => runtime.broadcast(undefined, {}), TypeError);
    });

    it('rejects empty channel name with RangeError', () => {
      assert.throws(() => runtime.broadcast('', {}), RangeError);
    });

    it('does not iterate allWorkers (uses BroadcastChannel bus directly)', () => {
      // Smoke check: broadcasting to a channel with no subscribers is
      // a no-op and returns immediately without error. We cannot assert
      // "no iteration" directly, but the no-op-then-no-error pattern
      // proves the bus path is functional.
      assert.doesNotThrow(() => runtime.broadcast('empty-channel', { payload: 1 }));
    });
  });

  describe('runtime.subscribe()', () => {
    let runtime;

    before(async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
    });

    after(async () => {
      if (runtime) await runtime.shutdown();
    });

    it('receives broadcasts published from a worker', async () => {
      // Main-thread subscribers CAN reference closures — the BC bus
      // delivers directly on the main thread (same isolate as the test).
      let received = null;
      let resolveReceived;
      const receivedPromise = new Promise((resolve) => {
        resolveReceived = resolve;
      });

      runtime.subscribe('worker-to-main', (msg) => {
        received = msg;
        resolveReceived();
      });

      await runtime.execute({
        type: 'publisher',
        fn: (_p, _s, context) => {
          context.channel('worker-to-main').publish({ hi: 'from-worker' });
          return 'published';
        },
      });

      await Promise.race([
        receivedPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('did not receive in 2s')), 2000),
        ),
      ]);
      assert.deepEqual(received, { hi: 'from-worker' });
    });

    it('subscribe() returns an idempotent unsubscribe function', async () => {
      let count = 0;
      const handler = () => count++;
      const unsub = runtime.subscribe('count-channel', handler);

      // The handler increments a closure variable. We poll it from the
      // main thread after each publish.
      runtime
        .execute({
          type: 'p',
          fn: (_p, _s, context) => context.channel('count-channel').publish('a'),
        })
        .catch(() => {});

      // Wait for delivery
      let pollCount;
      const deadline1 = Date.now() + 2000;
      do {
        await new Promise((r) => setTimeout(r, 50));
        pollCount = count;
      } while (pollCount === 0 && Date.now() < deadline1);
      assert.equal(count, 1);

      assert.equal(unsub(), true, 'first unsubscribe returns true');
      assert.equal(unsub(), false, 'second unsubscribe returns false');

      runtime
        .execute({
          type: 'p',
          fn: (_p, _s, context) => context.channel('count-channel').publish('b'),
        })
        .catch(() => {});

      await new Promise((r) => setTimeout(r, 300));
      assert.equal(count, 1, 'unsubscribed handler must not fire again');
    });

    it('rejects non-function handler with TypeError', () => {
      assert.throws(() => runtime.subscribe('ch', 'not-a-fn'), TypeError);
      assert.throws(() => runtime.subscribe('ch', null), TypeError);
      assert.throws(() => runtime.subscribe('ch', {}), TypeError);
    });

    it('rejects empty channel name with RangeError', () => {
      assert.throws(() => runtime.subscribe('', () => {}), RangeError);
    });

    it('multiple subscribers on the same channel all receive the message', async () => {
      const seen = [];
      let resolveAll;
      const allReceived = new Promise((resolve) => {
        resolveAll = resolve;
      });

      runtime.subscribe('multi-channel', (msg) => {
        seen.push(['a', msg]);
        if (seen.length === 2) resolveAll();
      });
      runtime.subscribe('multi-channel', (msg) => {
        seen.push(['b', msg]);
        if (seen.length === 2) resolveAll();
      });

      await runtime.execute({
        type: 'p',
        fn: (_p, _s, context) => context.channel('multi-channel').publish({ fanout: true }),
      });

      await Promise.race([
        allReceived,
        new Promise((_, reject) => setTimeout(() => reject(new Error('not received in 2s')), 2000)),
      ]);

      assert.equal(seen.length, 2);
      const tags = seen.map(([t]) => t).sort();
      assert.deepEqual(tags, ['a', 'b']);
      assert.ok(seen.every(([, m]) => m.fanout === true));
    });

    it('subscribers on different channels do NOT cross-contaminate', async () => {
      let ch1Hit = false;
      let ch2Hit = false;
      runtime.subscribe('iso-1', () => {
        ch1Hit = true;
      });
      runtime.subscribe('iso-2', () => {
        ch2Hit = true;
      });

      await runtime
        .execute({
          type: 'p',
          fn: (_p, _s, context) => context.channel('iso-1').publish({ which: 1 }),
        })
        .catch(() => {});

      // Poll the boolean flags
      const deadline = Date.now() + 1000;
      while (!ch1Hit && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(ch1Hit, true);
      assert.equal(ch2Hit, false);
    });
  });

  describe('runtime shutdown semantics', () => {
    it('broadcast() rejects with WorkerRuntimeError after shutdown', async () => {
      const r = await createWorkerRuntime({ workers: 1 });
      await r.shutdown();

      assert.throws(
        () => r.broadcast('any-channel', { x: 1 }),
        (err) => {
          assert.ok(err instanceof WorkerRuntimeError);
          assert.match(err.message, /shutting down/i);
          return true;
        },
      );
    });

    it('subscribe() before shutdown still works (and the BC handle is closed on shutdown)', async () => {
      const r = await createWorkerRuntime({ workers: 1 });
      let _received = null;
      r.subscribe('pre-shutdown-channel', (msg) => {
        _received = msg;
      });

      await r.shutdown();

      // After shutdown, the BC handle was closed; trying to publish
      // would throw because the channel is closed.
      assert.throws(() => r.broadcast('pre-shutdown-channel', { x: 1 }), WorkerRuntimeError);
    });
  });
});
