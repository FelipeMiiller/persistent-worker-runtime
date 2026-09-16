import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkerRuntime,
  Supervisor,
  WorkerHandle,
  TaskHandle,
  TaskTimeoutError,
} from '../src/index.js';

describe('Hard Preemption - Config, Error & Validation (T1)', () => {
  describe('TaskTimeoutError preemption enhancement', () => {
    it('defaults preempted to false and workerId to null', () => {
      const err = new TaskTimeoutError('Task timed out', {
        taskId: 'task_1',
        timeoutMs: 1000,
      });

      assert.equal(err.name, 'TaskTimeoutError');
      assert.equal(err.code, 'ERR_TASK_TIMEOUT');
      assert.equal(err.taskId, 'task_1');
      assert.equal(err.timeoutMs, 1000);
      assert.equal(err.workerId, null);
      assert.equal(err.preempted, false);
    });

    it('records preempted: true and workerId when supplied', () => {
      const err = new TaskTimeoutError('Task preempted', {
        taskId: 'task_2',
        timeoutMs: 50,
        workerId: 'worker_99',
        preempted: true,
      });

      assert.equal(err.name, 'TaskTimeoutError');
      assert.equal(err.code, 'ERR_TASK_TIMEOUT');
      assert.equal(err.taskId, 'task_2');
      assert.equal(err.timeoutMs, 50);
      assert.equal(err.workerId, 'worker_99');
      assert.equal(err.preempted, true);
    });
  });

  describe('TaskHandle preemption configuration & validation', () => {
    it('defaults forceKillOnTimeout to false and killGracePeriodMs to 500', () => {
      const task = new TaskHandle();
      assert.equal(task.forceKillOnTimeout, false);
      assert.equal(task.killGracePeriodMs, 500);
    });

    it('accepts custom forceKillOnTimeout and killGracePeriodMs', () => {
      const task = new TaskHandle({
        forceKillOnTimeout: true,
        killGracePeriodMs: 250,
      });
      assert.equal(task.forceKillOnTimeout, true);
      assert.equal(task.killGracePeriodMs, 250);
    });

    it('accepts killGracePeriodMs: 0', () => {
      const task = new TaskHandle({
        killGracePeriodMs: 0,
      });
      assert.equal(task.killGracePeriodMs, 0);
    });

    it('throws TypeError if killGracePeriodMs is a string', () => {
      assert.throws(
        () => new TaskHandle({ killGracePeriodMs: '500' }),
        {
          name: 'TypeError',
          message: 'killGracePeriodMs must be a non-negative number',
        }
      );
    });

    it('throws TypeError if killGracePeriodMs is NaN', () => {
      assert.throws(
        () => new TaskHandle({ killGracePeriodMs: NaN }),
        {
          name: 'TypeError',
          message: 'killGracePeriodMs must be a non-negative number',
        }
      );
    });

    it('throws RangeError if killGracePeriodMs is negative', () => {
      assert.throws(
        () => new TaskHandle({ killGracePeriodMs: -1 }),
        {
          name: 'RangeError',
          message: 'killGracePeriodMs must be a non-negative number',
        }
      );
    });

    it('cooperative timeout rejects with preempted: false when forceKillOnTimeout is false', async () => {
      const task = new TaskHandle({
        timeoutMs: 20,
        forceKillOnTimeout: false,
      });

      task.markStarted();

      await assert.rejects(task.promise, (err) => {
        assert.equal(err.name, 'TaskTimeoutError');
        assert.equal(err.preempted, false);
        return true;
      });
    });
  });

  describe('WorkerRuntime preemption configuration & validation', () => {
    it('defaults forceKillOnTimeout to false and killGracePeriodMs to 500', () => {
      const runtime = new WorkerRuntime();
      assert.equal(runtime.forceKillOnTimeout, false);
      assert.equal(runtime.killGracePeriodMs, 500);
    });

    it('Supervisor receives default preemption options', () => {
      const supervisor = new Supervisor();
      assert.equal(supervisor.forceKillOnTimeout, false);
      assert.equal(supervisor.killGracePeriodMs, 500);
    });

    it('accepts custom preemption options and passes to Supervisor', () => {
      const runtime = new WorkerRuntime({
        forceKillOnTimeout: true,
        killGracePeriodMs: 1000,
      });
      assert.equal(runtime.forceKillOnTimeout, true);
      assert.equal(runtime.killGracePeriodMs, 1000);
    });

    it('throws TypeError if killGracePeriodMs is a string in WorkerRuntime', () => {
      assert.throws(
        () => new WorkerRuntime({ killGracePeriodMs: '500' }),
        {
          name: 'TypeError',
          message: 'killGracePeriodMs must be a non-negative number',
        }
      );
    });

    it('throws TypeError if killGracePeriodMs is NaN in WorkerRuntime', () => {
      assert.throws(
        () => new WorkerRuntime({ killGracePeriodMs: NaN }),
        {
          name: 'TypeError',
          message: 'killGracePeriodMs must be a non-negative number',
        }
      );
    });

    it('throws RangeError if killGracePeriodMs is negative in WorkerRuntime', () => {
      assert.throws(
        () => new WorkerRuntime({ killGracePeriodMs: -50 }),
        {
          name: 'RangeError',
          message: 'killGracePeriodMs must be a non-negative number',
        }
      );
    });

    it('dispatched task inherits runtime preemption options by default', () => {
      const runtime = new WorkerRuntime({
        forceKillOnTimeout: true,
        killGracePeriodMs: 750,
      });

      const task = runtime.dispatch({ fn: () => 42 });
      assert.equal(task.forceKillOnTimeout, true);
      assert.equal(task.killGracePeriodMs, 750);
    });

    it('dispatched task preserves explicit per-task preemption overrides', () => {
      const runtime = new WorkerRuntime({
        forceKillOnTimeout: false,
        killGracePeriodMs: 500,
      });

      const task = runtime.dispatch({
        fn: () => 42,
        forceKillOnTimeout: true,
        killGracePeriodMs: 200,
      });
      assert.equal(task.forceKillOnTimeout, true);
      assert.equal(task.killGracePeriodMs, 200);
    });
  });
});

describe('Hard Preemption - Watchdog & WorkerHandle Preemption (T2)', () => {
  it('terminates an unyielding infinite loop when forceKillOnTimeout is true and killGracePeriodMs is 0', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    let preemptedEvent = null;
    worker.on('task_preempted', (event) => {
      preemptedEvent = event;
    });

    let exitEvent = null;
    worker.on('exit', (event) => {
      exitEvent = event;
    });

    const task = new TaskHandle({
      timeoutMs: 40,
      forceKillOnTimeout: true,
      killGracePeriodMs: 0,
      fn: () => {
        // Runaway infinite loop that never yields
        while (true) {}
      },
    });

    const executionPromise = worker.executeTask(task);

    await assert.rejects(executionPromise, (err) => {
      assert.equal(err.name, 'TaskTimeoutError');
      assert.equal(err.code, 'ERR_TASK_TIMEOUT');
      assert.equal(err.preempted, true);
      assert.equal(err.workerId, worker.id);
      assert.equal(err.taskId, task.id);
      assert.equal(err.timeoutMs, 40);
      return true;
    });

    // Wait a tick for OS exit event to fire
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(worker.isPreempted, true);
    assert.equal(worker.status, 'terminated');
    assert.ok(preemptedEvent, 'task_preempted event was emitted');
    assert.equal(preemptedEvent.workerId, worker.id);
    assert.equal(preemptedEvent.taskId, task.id);
    assert.equal(preemptedEvent.preempted, true);

    assert.ok(exitEvent, 'exit event was emitted');
    assert.equal(exitEvent.prevStatus, 'preempting');
    assert.equal(exitEvent.isPreempted, true);
  });

  it('terminates runaway thread after timeoutMs + killGracePeriodMs', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    const startTime = Date.now();
    const task = new TaskHandle({
      timeoutMs: 40,
      killGracePeriodMs: 60,
      forceKillOnTimeout: true,
      fn: () => {
        while (true) {}
      },
    });

    await assert.rejects(worker.executeTask(task), (err) => {
      assert.equal(err.name, 'TaskTimeoutError');
      assert.equal(err.preempted, true);
      return true;
    });

    const elapsed = Date.now() - startTime;
    assert.ok(elapsed >= 90, `Expected elapsed >= 90ms (40ms + 60ms - margin), got ${elapsed}ms`);

    // Wait a tick for OS exit event to fire
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(worker.isPreempted, true);
    assert.equal(worker.status, 'terminated');
  });

  it('clears watchdog when cooperative task finishes before timeoutMs', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    const task = new TaskHandle({
      timeoutMs: 100,
      forceKillOnTimeout: true,
      killGracePeriodMs: 0,
      fn: () => 'quick_success',
    });

    const result = await worker.executeTask(task);
    assert.equal(result, 'quick_success');
    assert.equal(worker.isPreempted, false);
    assert.equal(worker.status, 'idle');

    // Wait past timeout to ensure watchdog timer was cleared and doesn't fire later
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(worker.isPreempted, false);
    assert.equal(worker.status, 'idle');

    await worker.terminate();
  });

  it('does not terminate worker if cooperative task yields during grace period', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    const controller = new AbortController();
    const task = new TaskHandle({
      signal: controller.signal,
      timeoutMs: 40,
      killGracePeriodMs: 150,
      forceKillOnTimeout: true,
      fn: async () => {
        // Sleep for 60ms (exceeds timeoutMs: 40, but finishes well within 40 + 150 = 190ms)
        await new Promise((resolve) => setTimeout(resolve, 60));
        return 'finished_in_grace';
      },
    });

    // Task promise will reject with TaskAbortedError when timeout dispatches abort at 40ms
    await assert.rejects(worker.executeTask(task), (err) => {
      assert.equal(err.name, 'TaskAbortedError');
      return true;
    });

    // Wait for the worker thread to finish its async work
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Worker survived!
    assert.equal(worker.isPreempted, false);
    assert.equal(worker.status, 'idle');

    await worker.terminate();
  });
});
