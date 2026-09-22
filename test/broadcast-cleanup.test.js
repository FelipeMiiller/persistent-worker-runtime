import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelRegistry } from '../src/broadcast-channel.js';
import { createWorkerRuntime } from '../src/index.js';

describe('Channel cleanup on shutdown', () => {
  describe('ChannelRegistry.closeAll() releases BC handles', () => {
    it('does not block the Node.js event loop after all channels are closed', async () => {
      const reg = new ChannelRegistry();
      reg.getChannel('a');
      reg.getChannel('b');
      reg.getChannel('c');
      assert.equal(reg.size, 3);

      const closed = reg.closeAll();
      assert.equal(closed, 3);
      assert.equal(reg.size, 0);

      const t0 = Date.now();
      await new Promise((r) => setImmediate(r));
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 100, `event loop took ${elapsed}ms; should be <100ms`);
    });
  });

  describe('Main-thread shutdown via runtime.shutdown()', () => {
    it('rejects further broadcasts after shutdown', async () => {
      const runtime = await createWorkerRuntime({ workers: 1 });
      runtime.subscribe('test-ch', () => {});
      await runtime.shutdown();

      assert.throws(() => runtime.broadcast('test-ch', { x: 1 }), /shutting down/i);
    });

    it('repeated shutdown is idempotent', async () => {
      const runtime = await createWorkerRuntime({ workers: 1 });
      await runtime.shutdown();
      // Second call must not throw
      await runtime.shutdown();
    });

    it('shutdown completes within 5 seconds (no leaked main-thread BC handles)', async () => {
      const runtime = await createWorkerRuntime({ workers: 1 });
      runtime.subscribe('ch-1', () => {});
      runtime.subscribe('ch-2', () => {});
      runtime.subscribe('ch-3', () => {});

      const t0 = Date.now();
      await runtime.shutdown();
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 5000, `shutdown took ${elapsed}ms; should be <5s`);
    });
  });
});
