import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor } from '../src/supervisor.js';
import { WorkerRuntime } from '../src/worker-runtime.js';
import { WorkerRuntimeError } from '../src/errors.js';
import { createWorkerRuntime } from '../src/index.js';

describe('Supervisor — unit-level coverage', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 2 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  describe('Constructor & Getters', () => {
    it('exposes initial counters as zero', () => {
      // Create a fresh supervisor without starting it
      const sup = new Supervisor({ workers: 1 });
      assert.equal(sup.recycledCount, 0);
      assert.equal(sup.preemptedCount, 0);
      assert.equal(sup.totalWorkers, 0);
      assert.equal(sup.idleWorkers.length, 0);
      assert.equal(sup.allWorkers.length, 0);
    });

    it('exposes all configured options via getters', () => {
      const sup = new Supervisor({
        workers: 2,
        maxTasksPerWorker: 100,
        maxMemoryMb: 256,
        forceKillOnTimeout: true,
        killGracePeriodMs: 750,
      });
      assert.equal(sup.maxTasksPerWorker, 100);
      assert.equal(sup.maxMemoryMb, 256);
      assert.equal(sup.forceKillOnTimeout, true);
      assert.equal(sup.killGracePeriodMs, 750);
    });

    it('allWorkers returns the same array length as totalWorkers after start', async () => {
      const sup = new Supervisor({ workers: 3 });
      await sup.start();
      assert.equal(sup.allWorkers.length, 3);
      assert.equal(sup.totalWorkers, 3);
      // idle filter is correct (all are idle on fresh start)
      assert.equal(sup.idleWorkers.length, 3);
      await sup.shutdown();
    });
  });

  describe('findWorkerForTask', () => {
    it('returns null when shutting down', async () => {
      const sup = new Supervisor({ workers: 1 });
      await sup.start();
      await sup.shutdown();
      // After shutdown, findWorkerForTask must short-circuit
      const result = sup.findWorkerForTask({ affinityKey: null });
      assert.equal(result, null);
    });

    it('returns null when no idle workers exist', () => {
      const sup = new Supervisor({ workers: 1 });
      // Don't start — no workers exist
      assert.equal(sup.findWorkerForTask({ affinityKey: null }), null);
    });
  });
});

describe('WorkerRuntime — dispatch validation paths', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 1 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  describe('dispatch()', () => {
    it('accepts a function definition (treated as anonymous task)', () => {
      const handle = runtime.dispatch(function add(a, b) {
        return a + b;
      });
      assert.ok(handle && typeof handle.promise?.then === 'function');
      // Cleanup: handle will fail because fn arity doesn't match worker signature,
      // but the dispatch call itself succeeded.
      handle.promise.catch(() => {});
    });

    it('rejects dispatch during shutdown', async () => {
      const r = await createWorkerRuntime({ workers: 1 });
      await r.shutdown();
      assert.throws(
        () => r.dispatch({ type: 'noop', fn: () => 1 }),
        (err) => {
          assert.ok(err instanceof WorkerRuntimeError);
          assert.equal(err.message, 'Cannot dispatch tasks: Runtime is shutting down');
          return true;
        }
      );
    });

    it('throws TypeError for invalid task definitions', () => {
      assert.throws(() => runtime.dispatch(42), TypeError);
      assert.throws(() => runtime.dispatch('not-an-object'), TypeError);
      assert.throws(() => runtime.dispatch(null), TypeError);
    });
  });

  describe('executeAll()', () => {
    it('throws TypeError when given non-array', async () => {
      await assert.rejects(
        runtime.executeAll('not-an-array'),
        (err) => err instanceof TypeError
      );
    });
  });

  describe('executeAllSettled()', () => {
    it('throws TypeError when given non-array', async () => {
      await assert.rejects(
        runtime.executeAllSettled({ not: 'array' }),
        (err) => err instanceof TypeError
      );
    });

    it('returns one entry per task with status fulfilled or rejected', async () => {
      const tasks = [
        { type: 'noop_ok', fn: () => 1 },
        { type: 'noop_err', fn: () => { throw new Error('boom'); }, retries: 0 },
      ];
      const results = await runtime.executeAllSettled(tasks);
      assert.equal(results.length, 2);
      const fulfilled = results.find((r) => r.status === 'fulfilled');
      const rejected = results.find((r) => r.status === 'rejected');
      assert.ok(fulfilled, 'should have at least one fulfilled');
      assert.ok(rejected, 'should have at least one rejected');
      assert.equal(fulfilled.value, 1);
      assert.equal(rejected.reason.message, 'boom');
    });
  });

  describe('dispatchAll()', () => {
    it('throws TypeError when given non-array', () => {
      assert.throws(() => runtime.dispatchAll('not-an-array'), TypeError);
    });

    it('returns one handle per task definition', () => {
      const handles = runtime.dispatchAll([
        { type: 'noop_1', fn: () => 1 },
        { type: 'noop_2', fn: () => 2 },
      ]);
      assert.equal(handles.length, 2);
      handles.forEach((h) => h.promise.catch(() => {}));
    });
  });

  describe('createWorker()', () => {
    it('rejects calls during shutdown', async () => {
      const r = await createWorkerRuntime({ workers: 1 });
      await r.shutdown();
      await assert.rejects(
        r.createWorker(),
        (err) => {
          assert.ok(err instanceof WorkerRuntimeError);
          assert.equal(err.message, 'Cannot create worker: Runtime is shutting down');
          return true;
        }
      );
    });
  });

  describe('Constructor validation', () => {
    it('rejects NaN killGracePeriodMs with TypeError', () => {
      assert.throws(
        () => new WorkerRuntime({ killGracePeriodMs: NaN }),
        TypeError
      );
    });

    it('rejects negative killGracePeriodMs with RangeError', () => {
      assert.throws(
        () => new WorkerRuntime({ killGracePeriodMs: -1 }),
        RangeError
      );
    });

    it('rejects non-number killGracePeriodMs with TypeError', () => {
      assert.throws(
        () => new WorkerRuntime({ killGracePeriodMs: 'oops' }),
        TypeError
      );
    });
  });
});
