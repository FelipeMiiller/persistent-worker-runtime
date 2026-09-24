/**
 * Runtime liveness + readiness probes (DR §8.2 closure).
 *
 * The runtime exposes two methods so external observers (k8s probes,
 * LB target groups, cron, scripts) can wire whatever transport they
 * want — HTTP route, polling script, sidecar — without the runtime
 * itself mounting a server.
 *
 *  - `runtime.isAlive()`  → liveness:  process + pool are healthy
 *  - `runtime.isReady()`  → readiness: can accept new work right now
 *
 * Both return `{ ok: boolean, reason?: string }`. `reason` is set when
 * `ok` is false so operators can debug without spelunking `stats()`.
 *
 * NOTE: `createWorkerRuntime()` is async and auto-starts the runtime
 * internally. Direct `new WorkerRuntime()` is the only way to observe
 * the `not-started` state — exercised in one of the isReady() tests.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createWorkerRuntime, WorkerRuntime } from '../src/index.js';

describe('Runtime — liveness + readiness probes (DR §8.2)', () => {
  /** @type {import('../src/worker-runtime.js').WorkerRuntime | undefined} */
  let runtime;

  beforeEach(async () => {
    runtime = await createWorkerRuntime({ workers: 2 });
  });

  // Drain the runtime between tests so worker threads don't keep the
  // Event Loop alive past the test boundary. Tests that already shut
  // down see this as a no-op (shutdown is idempotent).
  afterEach(async () => {
    if (runtime) {
      await runtime.shutdown().catch(() => {});
      runtime = undefined;
    }
  });

  describe('isShuttingDown getter', () => {
    it('exposes false after createWorkerRuntime()', () => {
      assert.equal(runtime.isShuttingDown, false);
    });

    it('flips to true once shutdown() begins', async () => {
      assert.equal(runtime.isShuttingDown, false);
      await runtime.shutdown();
      assert.equal(runtime.isShuttingDown, true);
    });

    it('stays true across multiple shutdown() calls (idempotent)', async () => {
      await runtime.shutdown();
      await runtime.shutdown();
      assert.equal(runtime.isShuttingDown, true);
    });
  });

  describe('isAlive() — liveness', () => {
    it('returns { ok: true } when running with workers', () => {
      const result = runtime.isAlive();
      assert.deepEqual(result, { ok: true });
    });

    it('returns { ok: true } during drain (process is alive while draining)', async () => {
      // Kick off shutdown but do not await — process is alive mid-drain.
      const shutdownPromise = runtime.shutdown();
      const result = runtime.isAlive();
      assert.equal(result.ok, true);
      assert.equal(result.reason, undefined);
      await shutdownPromise;
    });

    it('returns { ok: false, reason: "shutting-down" } after shutdown completes', async () => {
      await runtime.shutdown();
      const result = runtime.isAlive();
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'shutting-down');
    });
  });

  describe('isReady() — readiness', () => {
    it('returns { ok: true } when running with capacity', () => {
      const result = runtime.isReady();
      assert.deepEqual(result, { ok: true });
    });

    it('returns { ok: false, reason: "not-started" } when constructed directly (no auto-start)', () => {
      // Direct construction bypasses the factory — the runtime is NOT
      // started. Operators that wire the runtime manually see this state
      // until they call `await runtime.start()`.
      const manual = new WorkerRuntime({ workers: 2 });
      const result = manual.isReady();
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'not-started');
      // Don't leak — clean up.
      return manual.shutdown().catch(() => {});
    });

    it('returns { ok: false, reason: "shutting-down" } during drain', async () => {
      const shutdownPromise = runtime.shutdown();
      const result = runtime.isReady();
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'shutting-down');
      await shutdownPromise;
    });

    it('returns { ok: false, reason: "queue-full" } when queue is saturated', async () => {
      await runtime.shutdown();
      // 1 worker + maxQueueSize: 2 → 1 busy + 2 pending = saturated.
      const tiny = await createWorkerRuntime({ workers: 1, maxQueueSize: 2 });

      const makeBlocker = () =>
        new Promise(() => {
          // Never resolves; tiny.shutdown() rejects in-flight tasks.
        });
      // dispatch() returns a TaskHandle; rejections surface on `.promise`.
      tiny.dispatch(makeBlocker).promise.catch(() => {}); // 1 busy on the worker
      tiny.dispatch(makeBlocker).promise.catch(() => {}); // 2 pending → queue full
      tiny.dispatch(makeBlocker).promise.catch(() => {}); // 3rd → parked waiter

      // Yield to the event loop so the dispatch + scheduler settle.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const result = tiny.isReady();
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'queue-full');

      // Shut down to release the parked tasks and let the process exit.
      await tiny.shutdown();
    });
  });

  describe('liveness ≠ readiness', () => {
    it('a runtime can be alive but not ready (drain path)', async () => {
      const shutdownPromise = runtime.shutdown();
      // Drain in flight — process is alive but should NOT receive new work.
      assert.equal(runtime.isAlive().ok, true);
      assert.equal(runtime.isReady().ok, false);
      await shutdownPromise;
    });
  });
});
