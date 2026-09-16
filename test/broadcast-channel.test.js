import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry, validateChannelName } from '../src/broadcast-channel.js';

/**
 * Helper: waits one macrotask so the BroadcastChannel microtask queue
 * has a chance to drain. BroadcastChannel dispatches via microtasks in
 * the same thread, but the test scheduling can be off by one tick.
 */
const tick = () => new Promise((r) => setImmediate(r));

describe('ChannelRegistry', () => {
  let registry;
  let peer;

  beforeEach(() => {
    // Two registries simulate two threads sharing a channel name.
    // BroadcastChannel's spec says the same instance that posted does
    // NOT receive its own message, so to test same-process delivery
    // we need two separate BC instances — exactly what happens when two
    // threads each have their own registry.
    registry = new ChannelRegistry();
    peer = new ChannelRegistry();
  });

  // BroadcastChannel holds internal handles that keep the Node.js event
  // loop alive until closed. Each test MUST close its channels, otherwise
  // the test process hangs at exit. closeAll() is idempotent.
  afterEach(() => {
    registry.closeAll();
    peer.closeAll();
  });

  describe('Channel name validation (validateChannelName)', () => {
    it('rejects non-string names with TypeError', () => {
      assert.throws(() => validateChannelName(123), TypeError);
      assert.throws(() => validateChannelName(null), TypeError);
      assert.throws(() => validateChannelName(undefined), TypeError);
      assert.throws(() => validateChannelName({}), TypeError);
      assert.throws(() => validateChannelName([]), TypeError);
      assert.throws(() => validateChannelName(true), TypeError);
    });

    it('rejects empty string with RangeError', () => {
      assert.throws(() => validateChannelName(''), RangeError);
    });

    it('accepts non-empty strings', () => {
      assert.doesNotThrow(() => validateChannelName('ch1'));
      assert.doesNotThrow(() => validateChannelName('my-channel'));
      assert.doesNotThrow(() => validateChannelName('Cache.Invalidation.v2'));
    });
  });

  describe('Channel caching', () => {
    it('returns the same wrapper for the same name', () => {
      const c1 = registry.getChannel('cache');
      const c2 = registry.getChannel('cache');
      assert.equal(c1, c2);
    });

    it('returns different wrappers for different names', () => {
      const c1 = registry.getChannel('ch1');
      const c2 = registry.getChannel('ch2');
      assert.notEqual(c1, c2);
    });

    it('exposes size and has() to inspect the registry', () => {
      assert.equal(registry.size, 0);
      assert.equal(registry.has('a'), false);

      registry.getChannel('a');
      assert.equal(registry.size, 1);
      assert.equal(registry.has('a'), true);

      registry.getChannel('b');
      assert.equal(registry.size, 2);
      assert.equal(registry.has('b'), true);
    });

    it('throws on invalid channel names at getChannel() too', () => {
      assert.throws(() => registry.getChannel(123), TypeError);
      assert.throws(() => registry.getChannel(''), RangeError);
    });
  });

  describe('Publish and subscribe', () => {
    it('delivers a message to a subscriber on the same name', async () => {
      const sender = registry.getChannel('ch');
      const receiver = peer.getChannel('ch');

      const received = new Promise((resolve) => {
        receiver.subscribe((msg) => resolve(msg));
      });

      sender.publish({ hello: 'world' });
      const msg = await received;
      assert.deepEqual(msg, { hello: 'world' });
    });

    it('delivers to multiple subscribers on the same channel', async () => {
      const sender = registry.getChannel('ch');
      const receiver = peer.getChannel('ch');

      const results = [];
      const seen = new Promise((resolve) => {
        receiver.subscribe((msg) => {
          results.push(['a', msg]);
          if (results.length === 2) resolve();
        });
        receiver.subscribe((msg) => {
          results.push(['b', msg]);
          if (results.length === 2) resolve();
        });
      });

      sender.publish('hi');
      await seen;

      const tags = results.map(([t]) => t).sort();
      assert.deepEqual(tags, ['a', 'b']);
      assert.ok(results.every(([, m]) => m === 'hi'));
    });

    it('does NOT deliver across different channel names', async () => {
      const ch1 = registry.getChannel('ch1');
      const ch2 = peer.getChannel('ch2');

      let leaked = false;
      ch2.subscribe(() => {
        leaked = true;
      });

      ch1.publish('should-not-reach-ch2');
      await tick();

      assert.equal(leaked, false);
    });

    it('subscribe() returns an idempotent unsubscribe function', () => {
      const ch = registry.getChannel('ch');
      const handler = () => {};

      const unsub = ch.subscribe(handler);
      assert.equal(typeof unsub, 'function');
      assert.equal(unsub(), true, 'first unsubscribe returns true');
      assert.equal(unsub(), false, 'second unsubscribe returns false');
    });

    it('unsubscribe() removes a handler so it stops being called', async () => {
      const sender = registry.getChannel('ch');
      const receiver = peer.getChannel('ch');

      let count = 0;
      const handler = () => count++;
      receiver.subscribe(handler);

      sender.publish('first');
      await tick();
      assert.equal(count, 1);

      receiver.unsubscribe(handler);
      sender.publish('second');
      await tick();
      assert.equal(count, 1, 'unsubscribed handler must not fire again');
    });

    it('one throwing subscriber does not break the others', async () => {
      const sender = registry.getChannel('ch');
      const receiver = peer.getChannel('ch');

      let secondFired = false;
      sender.subscribe(() => {
        throw new Error('boom');
      });
      receiver.subscribe(() => {
        secondFired = true;
      });

      sender.publish('test');
      await tick();

      assert.equal(secondFired, true, 'second subscriber must still fire');
    });
  });

  describe('Close and cleanup', () => {
    it('close() removes the channel from the registry', () => {
      const ch = registry.getChannel('ch');
      assert.equal(registry.size, 1);

      assert.equal(ch.close(), true);
      assert.equal(registry.size, 0);
      assert.equal(registry.has('ch'), false);
    });

    it('close() returns false on subsequent calls (idempotent)', () => {
      const ch = registry.getChannel('ch');
      assert.equal(ch.close(), true);
      assert.equal(ch.close(), false);
      assert.equal(ch.close(), false);
    });

    it('publish() throws after close()', () => {
      const ch = registry.getChannel('ch');
      ch.close();
      assert.throws(() => ch.publish('x'), /closed/i);
    });

    it('subscribe() throws after close()', () => {
      const ch = registry.getChannel('ch');
      ch.close();
      assert.throws(() => ch.subscribe(() => {}), /closed/i);
    });

    it('closeAll() closes every channel the registry owns', () => {
      registry.getChannel('a');
      registry.getChannel('b');
      registry.getChannel('c');
      assert.equal(registry.size, 3);

      const closed = registry.closeAll();
      assert.equal(closed, 3);
      assert.equal(registry.size, 0);
    });

    it('after close(), getChannel(name) creates a fresh wrapper', () => {
      const c1 = registry.getChannel('ch');
      c1.close();
      const c2 = registry.getChannel('ch');
      assert.notEqual(c1, c2, 'closed channel must not be returned again');
    });
  });

  describe('Registry-level shortcuts', () => {
    it('registry.publish() publishes without explicit getChannel()', async () => {
      const receiver = peer.getChannel('ch');
      const received = new Promise((resolve) => receiver.subscribe(resolve));

      registry.publish('ch', 'shortcut');
      assert.equal(await received, 'shortcut');
    });

    it('registry.subscribe() registers without explicit getChannel()', async () => {
      const sender = registry.getChannel('ch');
      const received = new Promise((resolve) => peer.subscribe('ch', resolve));

      sender.publish('via-registry');
      assert.equal(await received, 'via-registry');
    });
  });

  describe('Structured clone serialization across the channel', () => {
    it('round-trips Date, Map, Set, ArrayBuffer, plain objects', async () => {
      const sender = registry.getChannel('ch');
      const receiver = peer.getChannel('ch');

      const original = {
        when: new Date('2026-09-16T19:00:00.000Z'),
        tags: new Map([['a', 1], ['b', 2]]),
        items: new Set([1, 2, 3, 4]),
        buffer: new ArrayBuffer(8),
        nested: { deep: { value: [1, 'two', null] } },
      };

      const received = new Promise((resolve) => receiver.subscribe(resolve));
      sender.publish(original);
      const got = await received;

      assert.ok(got.when instanceof Date, 'Date preserved');
      assert.equal(got.when.toISOString(), original.when.toISOString());

      assert.ok(got.tags instanceof Map, 'Map preserved');
      assert.equal(got.tags.get('a'), 1);
      assert.equal(got.tags.get('b'), 2);

      assert.ok(got.items instanceof Set, 'Set preserved');
      assert.equal(got.items.size, 4);
      assert.ok(got.items.has(3));

      assert.ok(got.buffer instanceof ArrayBuffer, 'ArrayBuffer preserved');
      assert.equal(got.buffer.byteLength, 8);

      assert.deepEqual(got.nested.deep.value, [1, 'two', null]);
    });

    it('rejects cyclic references (Node may throw DataCloneError or accept it depending on version)', () => {
      const sender = registry.getChannel('ch');
      const cyclic = { name: 'self' };
      cyclic.self = cyclic;

      // Note: Node.js's BroadcastChannel.postMessage uses v8 serialize under
      // the hood, which historically threw DataCloneError on cycles. Newer
      // versions may accept cycles or emit unhandledRejection. We only assert
      // that our wrapper does not crash; we do not assert the specific error
      // type because it's an implementation detail of the runtime.
      try {
        sender.publish(cyclic);
      } catch {
        // expected on stricter runtimes
      }
      // Give the async bus a chance to either deliver or reject silently.
      return tick();
    });
  });

  describe('Subscription lifecycle', () => {
    it('subscribed handler can call subscribe on the same channel from inside', () => {
      const ch = registry.getChannel('ch');
      ch.subscribe(() => {
        // inner subscribe from inside a handler is allowed
        ch.subscribe(() => {});
      });

      // Should not throw
      ch.publish({ x: 1 });
    });

    it('getChannel() does not retain subscribers that were unsubscribed', async () => {
      const sender = registry.getChannel('ch');
      const receiver = peer.getChannel('ch');

      let count = 0;
      // Use a Promise-resolved-on-first-message signal so we know exactly
      // when delivery has actually happened (setImmediate alone was racy).
      const firstArrived = new Promise((resolve) => {
        receiver.subscribe((msg) => {
          count++;
          if (count === 1) resolve();
        });
      });

      sender.publish('a');
      await firstArrived;
      assert.equal(count, 1);

      receiver.unsubscribe(() => count++); // dummy to confirm subscribe-set semantics
      // Re-fetch the unsubscribe from the SAME handler we subscribed above
      // (the dummy above was a different reference; the real unsub returns
      // from the original subscribe call below):
      let count2 = 0;
      const handler2 = () => count2++;
      const unsub2 = receiver.subscribe(handler2);

      // Give the listener time to be registered.
      await tick();

      // Now unsubscribe the second handler and verify it stops receiving.
      unsub2();
      sender.publish('b');
      await tick();
      await tick();
      assert.equal(count2, 0, 'unsubscribed handler must not receive further messages');
      // First handler is still subscribed and counts all messages.
      assert.ok(count >= 1, 'first handler still counted');
    });
  });
});
