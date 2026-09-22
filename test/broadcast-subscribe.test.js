import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorkerRuntime, WorkerRuntimeError } from '../src/index.js';
import * as common from './common.js';

describe('T7 — Main-Thread subscribe() / unsubscribe() / hasSubscribers() + shutdown hardening', () => {
  describe('runtime.unsubscribe(name, handler)', () => {
    let runtime;

    before(async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
    });

    after(async () => {
      if (runtime) await runtime.shutdown();
    });

    it('returns true and detaches the handler when a subscribed handler is removed', async () => {
      let count = 0;
      const handler = () => count++;

      runtime.subscribe('count-target', handler);

      // Sanity check: hasSubscribers is true
      assert.equal(runtime.hasSubscribers('count-target'), true);

      // Remove the handler
      assert.equal(runtime.unsubscribe('count-target', handler), true);

      // Now no subscribers
      assert.equal(runtime.hasSubscribers('count-target'), false);

      // Publish from a worker — the removed handler must NOT be called
      await runtime.execute({
        type: 'p',
        fn: (_p, _s, context) => context.channel('count-target').publish('x'),
      });

      // Give the bus a beat to deliver (it shouldn't)
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(count, 0, 'removed handler must not be invoked');
    });

    it('returns false when the handler was never subscribed', () => {
      const neverSubscribed = () => {};
      assert.equal(runtime.unsubscribe('never-channel', neverSubscribed), false);
    });

    it('returns false when the channel does not exist', () => {
      const handler = () => {};
      // Channel "ghost" was never created
      assert.equal(runtime.unsubscribe('ghost', handler), false);
    });

    it('is idempotent: calling unsubscribe twice on the same handler returns true then false', async () => {
      const handler = () => {};
      runtime.subscribe('idem-channel', handler);

      assert.equal(runtime.unsubscribe('idem-channel', handler), true);
      assert.equal(runtime.unsubscribe('idem-channel', handler), false);
    });

    it('throws TypeError if the handler argument is not a function', () => {
      assert.throws(() => runtime.unsubscribe('any', 'not-a-fn'), TypeError);
      assert.throws(() => runtime.unsubscribe('any', null), TypeError);
      assert.throws(() => runtime.unsubscribe('any', undefined), TypeError);
      assert.throws(() => runtime.unsubscribe('any', {}), TypeError);
      assert.throws(() => runtime.unsubscribe('any', 123), TypeError);
    });

    it('throws RangeError on empty channel name', () => {
      assert.throws(() => runtime.unsubscribe('', () => {}), RangeError);
    });

    it('removes only the targeted handler — hasSubscribers reflects the remaining subscriber', () => {
      const aHandler = () => {};
      const bHandler = () => {};
      runtime.subscribe('multi-unsub', aHandler);
      runtime.subscribe('multi-unsub', bHandler);

      // Both subscribed → hasSubscribers true
      assert.equal(runtime.hasSubscribers('multi-unsub'), true);

      // Remove only aHandler — bHandler remains, so still hasSubscribers
      assert.equal(runtime.unsubscribe('multi-unsub', aHandler), true);
      assert.equal(runtime.hasSubscribers('multi-unsub'), true);

      // Remove bHandler — no more subscribers
      assert.equal(runtime.unsubscribe('multi-unsub', bHandler), true);
      assert.equal(runtime.hasSubscribers('multi-unsub'), false);

      // Trying to unsubscribe aHandler again returns false (already gone)
      assert.equal(runtime.unsubscribe('multi-unsub', aHandler), false);
    });
  });

  describe('runtime.hasSubscribers(name)', () => {
    let runtime;

    before(async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
    });

    after(async () => {
      if (runtime) await runtime.shutdown();
    });

    it('returns false for an unknown channel', () => {
      assert.equal(runtime.hasSubscribers('brand-new-channel'), false);
    });

    it('returns true after subscribe() and false after unsubscribe()', () => {
      const handler = () => {};
      runtime.subscribe('flag-channel', handler);
      assert.equal(runtime.hasSubscribers('flag-channel'), true);

      runtime.unsubscribe('flag-channel', handler);
      assert.equal(runtime.hasSubscribers('flag-channel'), false);
    });

    it('returns true while at least one subscriber remains, even after others are removed', () => {
      const a = () => {};
      const b = () => {};
      runtime.subscribe('multi-flag', a);
      runtime.subscribe('multi-flag', b);

      runtime.unsubscribe('multi-flag', a);
      assert.equal(runtime.hasSubscribers('multi-flag'), true);

      runtime.unsubscribe('multi-flag', b);
      assert.equal(runtime.hasSubscribers('multi-flag'), false);
    });
  });

  describe('P6 acceptance #4 — main subscribe works with no worker tasks in flight', () => {
    let runtime;

    before(async () => {
      runtime = await createWorkerRuntime({ workers: 1 });
    });

    after(async () => {
      if (runtime) await runtime.shutdown();
    });

    it('runtime.subscribe() and unsubscribe API work independently of worker activity', () => {
      // P6 #4: the subscribe API does not require any worker tasks to
      // be in flight. We verify this by exercising the full subscribe +
      // hasSubscribers + unsubscribe lifecycle without dispatching a task.
      const unsub1 = runtime.subscribe('track-channel', () => {});
      const unsub2 = runtime.subscribe('track-channel', () => {});

      assert.equal(typeof unsub1, 'function');
      assert.equal(typeof unsub2, 'function');
      assert.equal(runtime.hasSubscribers('track-channel'), true);

      // Removing one subscriber still leaves the other
      assert.equal(unsub1(), true);
      assert.equal(runtime.hasSubscribers('track-channel'), true);

      assert.equal(unsub2(), true);
      assert.equal(runtime.hasSubscribers('track-channel'), false);
    });
  });

  describe('P7 acceptance #3 — broadcast after shutdown rejects with WorkerRuntimeError', () => {
    it('broadcast() throws WorkerRuntimeError after shutdown', async () => {
      const r = await createWorkerRuntime({ workers: 1 });
      await r.shutdown();

      assert.throws(
        () => r.broadcast('any-channel', { x: 1 }),
        (err) => {
          assert.ok(err instanceof WorkerRuntimeError, 'expected WorkerRuntimeError');
          assert.match(err.message, /shutting down/i);
          return true;
        },
      );
    });

    it('subscribe() called before shutdown is observable but the underlying BC is closed on shutdown', async () => {
      const r = await createWorkerRuntime({ workers: 1 });

      // Node-pattern: waitForSubscription wraps the subscribe handler with
      // mustCall(1) so the test asserts exactly one delivery. Replaces
      // 'let received = null; while (... === null && ...) await sleep(50)'.
      const receivedPromise = common.waitForSubscription(r, 'pre-shutdown', 1, 2000);

      // Pre-shutdown: a worker can publish to this channel
      await r.execute({
        type: 'p',
        fn: (_p, _s, context) => context.channel('pre-shutdown').publish({ ok: true }),
      });

      const received = await receivedPromise;
      assert.deepEqual(received, { ok: true });

      await r.shutdown();

      // After shutdown, hasSubscribers is false (the channel was closed)
      assert.equal(r.hasSubscribers('pre-shutdown'), false);

      // After shutdown, broadcast rejects
      assert.throws(() => r.broadcast('pre-shutdown', { x: 1 }), WorkerRuntimeError);
    });
  });

  describe('P7 acceptance #2 — shutdown closes channels and exits cleanly', () => {
    it('runtime.shutdown() closes all channels and returns quickly', async () => {
      const r = await createWorkerRuntime({ workers: 1 });

      // Open a channel by subscribing on main
      r.subscribe('exit-channel', () => {});

      // Open a worker-side channel by dispatching a task
      await r.execute({
        type: 'open-ch',
        fn: (_p, _s, context) => {
          context.channel('worker-channel');
          return 'opened';
        },
      });

      // Pre-shutdown the channel exists
      assert.equal(r.hasSubscribers('exit-channel'), true);

      const shutdownStart = Date.now();
      await r.shutdown();
      const shutdownMs = Date.now() - shutdownStart;

      // shutdown should complete quickly (sub-2s). The full process exit
      // is verified by the global test suite's `npm test` not hanging;
      // this assertion proves our shutdown returned promptly without
      // trying to leave active BC handles around.
      assert.ok(shutdownMs < 2000, `shutdown took ${shutdownMs}ms; expected < 2000ms`);

      // After shutdown, the registry has been emptied by closeAll()
      assert.equal(r.hasSubscribers('exit-channel'), false);
    });
  });
});
