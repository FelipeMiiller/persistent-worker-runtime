import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createWorkerRuntime,
  Supervisor,
  TaskHandle,
  TaskTimeoutError,
  WorkerHandle,
  WorkerRuntime,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
      assert.throws(() => new TaskHandle({ killGracePeriodMs: '500' }), {
        name: 'TypeError',
        message: 'killGracePeriodMs must be a non-negative number',
      });
    });

    it('throws TypeError if killGracePeriodMs is NaN', () => {
      assert.throws(() => new TaskHandle({ killGracePeriodMs: NaN }), {
        name: 'TypeError',
        message: 'killGracePeriodMs must be a non-negative number',
      });
    });

    it('throws RangeError if killGracePeriodMs is negative', () => {
      assert.throws(() => new TaskHandle({ killGracePeriodMs: -1 }), {
        name: 'RangeError',
        message: 'killGracePeriodMs must be a non-negative number',
      });
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
      assert.throws(() => new WorkerRuntime({ killGracePeriodMs: '500' }), {
        name: 'TypeError',
        message: 'killGracePeriodMs must be a non-negative number',
      });
    });

    it('throws TypeError if killGracePeriodMs is NaN in WorkerRuntime', () => {
      assert.throws(() => new WorkerRuntime({ killGracePeriodMs: NaN }), {
        name: 'TypeError',
        message: 'killGracePeriodMs must be a non-negative number',
      });
    });

    it('throws RangeError if killGracePeriodMs is negative in WorkerRuntime', () => {
      assert.throws(() => new WorkerRuntime({ killGracePeriodMs: -50 }), {
        name: 'RangeError',
        message: 'killGracePeriodMs must be a non-negative number',
      });
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

describe('Hard Preemption - Supervisor Autonomous Pool Healing (T3)', () => {
  it('restores pool capacity and executes subsequent tasks when a worker thread is preempted', async () => {
    const runtime = await createWorkerRuntime({
      workers: 2,
      forceKillOnTimeout: true,
      killGracePeriodMs: 0,
    });

    try {
      let preemptedEvent = null;
      let replacedEvent = null;

      runtime.on('worker_preempted', (ev) => {
        preemptedEvent = ev;
      });

      runtime.on('worker_replaced', (ev) => {
        replacedEvent = ev;
      });

      // Dispatch one unyielding runaway task and one normal task in parallel
      const runawayTask = runtime.execute({
        timeoutMs: 40,
        fn: () => {
          while (true) {}
        },
      });

      const normalTask1 = runtime.execute({
        fn: () => 'normal_1',
      });

      const res1 = await normalTask1;
      assert.equal(res1, 'normal_1');

      await assert.rejects(runawayTask, (err) => {
        assert.equal(err.name, 'TaskTimeoutError');
        assert.equal(err.preempted, true);
        return true;
      });

      // Wait for preemption and replacement events to arrive
      const deadline = Date.now() + 3000;
      while ((!preemptedEvent || !replacedEvent) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.ok(preemptedEvent, 'worker_preempted event was emitted');
      assert.ok(replacedEvent, 'worker_replaced event was emitted');
      assert.equal(runtime.stats.totalWorkers, 2, 'Pool size restored to configured concurrency');

      // Dispatch a subsequent task on the healed pool to verify it executes cleanly
      const normalTask2 = await runtime.execute({
        fn: (p) => p * 2,
        payload: 21,
      });

      assert.equal(normalTask2, 42);
    } finally {
      await runtime.shutdown();
    }
  });

  it('emits task_preempted and worker_preempted events with complete telemetry', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      forceKillOnTimeout: true,
      killGracePeriodMs: 0,
    });

    try {
      let taskPreemptedData = null;
      let workerPreemptedData = null;

      runtime.on('task_preempted', (data) => {
        taskPreemptedData = data;
      });

      runtime.on('worker:preempted', (data) => {
        workerPreemptedData = data;
      });

      await assert.rejects(
        runtime.execute({
          timeoutMs: 30,
          fn: () => {
            while (true) {}
          },
        }),
        (err) => err.preempted === true,
      );

      // Wait for preemption events to arrive
      const deadline = Date.now() + 3000;
      while ((!taskPreemptedData || !workerPreemptedData) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.ok(taskPreemptedData, 'task_preempted event received');
      assert.equal(taskPreemptedData.preempted, true);
      assert.equal(taskPreemptedData.timeoutMs, 30);
      assert.ok(taskPreemptedData.workerId);
      assert.ok(taskPreemptedData.taskId);

      assert.ok(workerPreemptedData, 'worker:preempted event received');
      assert.equal(workerPreemptedData.workerId, taskPreemptedData.workerId);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe('Hard Preemption - Telemetry & Types (T4)', () => {
  it('exposes and increments preemptedTasksCount in runtime.stats', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      forceKillOnTimeout: true,
      killGracePeriodMs: 0,
    });

    try {
      assert.equal(runtime.stats.preemptedTasksCount, 0);

      await assert.rejects(
        runtime.execute({
          timeoutMs: 30,
          fn: () => {
            while (true) {}
          },
        }),
      );

      const deadline1 = Date.now() + 3000;
      while (runtime.stats.preemptedTasksCount < 1 && Date.now() < deadline1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.equal(runtime.stats.preemptedTasksCount, 1);
      assert.equal(runtime.stats.failedTasks, 1);

      // Preempt a second task
      await assert.rejects(
        runtime.execute({
          timeoutMs: 30,
          fn: () => {
            while (true) {}
          },
        }),
      );

      const deadline2 = Date.now() + 3000;
      while (runtime.stats.preemptedTasksCount < 2 && Date.now() < deadline2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.equal(runtime.stats.preemptedTasksCount, 2);
      assert.equal(runtime.stats.failedTasks, 2);
    } finally {
      await runtime.shutdown();
    }
  });

  it('declares all preemption types, options, and events in src/index.d.ts', () => {
    const dtsContent = readFileSync(join(__dirname, '../src/index.d.ts'), 'utf8');

    assert.ok(dtsContent.includes('forceKillOnTimeout?: boolean;'));
    assert.ok(dtsContent.includes('killGracePeriodMs?: number;'));
    assert.ok(dtsContent.includes('preemptedTasksCount: number;'));
    assert.ok(dtsContent.includes('export interface TaskPreemptedEvent'));
    assert.ok(dtsContent.includes('export interface WorkerPreemptedEvent'));
    assert.ok(dtsContent.includes("'preempting'"));
    assert.ok(dtsContent.includes('readonly isPreempted: boolean;'));
    assert.ok(dtsContent.includes('preempted: boolean;'));
    assert.ok(dtsContent.includes('workerId: string | null;'));
    assert.ok(dtsContent.includes('get preemptedCount(): number;'));
  });
});

describe('Hard Preemption - Concurrency & ReDoS Integration Tests (T5)', () => {
  it('terminates a catastrophic Regular Expression Backtracking (ReDoS) runaway computation', async () => {
    const runtime = await createWorkerRuntime({
      workers: 2,
      forceKillOnTimeout: true,
      killGracePeriodMs: 0,
    });

    try {
      let workerReplaced = false;
      runtime.on('worker_replaced', () => {
        workerReplaced = true;
      });

      // Catastrophic exponential backtracking regex: (a+)+$ on a string of 28 'a's followed by '!'
      const redosTask = runtime.execute({
        type: 'redos_attack_simulation',
        timeoutMs: 50,
        fn: () => {
          const redosPattern = /^([a-zA-Z0-9]+)+$/;
          const maliciousInput = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!';
          return redosPattern.test(maliciousInput);
        },
      });

      await assert.rejects(redosTask, (err) => {
        assert.equal(err.name, 'TaskTimeoutError');
        assert.equal(err.preempted, true);
        return true;
      });

      // Wait for replacement worker
      const deadline = Date.now() + 3000;
      while (!workerReplaced && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.ok(workerReplaced, 'Worker was replaced after ReDoS preemption');
      assert.equal(runtime.stats.totalWorkers, 2, 'Pool size restored to 2');

      // Subsequent task executes cleanly
      const cleanResult = await runtime.execute({
        fn: () => 'recovered_from_redos',
      });
      assert.equal(cleanResult, 'recovered_from_redos');
    } finally {
      await runtime.shutdown();
    }
  });

  it('handles concurrent load with interleaved runaway loops and legitimate tasks without starvation', async () => {
    const runtime = await createWorkerRuntime({
      workers: 3,
      forceKillOnTimeout: true,
      killGracePeriodMs: 0,
    });

    try {
      const totalTasks = 20;
      const runawayIndices = new Set([2, 6, 11, 15, 18]); // 5 runaways, 15 valid tasks
      const taskPromises = [];

      for (let i = 0; i < totalTasks; i++) {
        const isRunaway = runawayIndices.has(i);
        if (isRunaway) {
          taskPromises.push(
            runtime.execute({
              type: `runaway_${i}`,
              timeoutMs: 40,
              fn: () => {
                while (true) {}
              },
            }),
          );
        } else {
          taskPromises.push(
            runtime.execute({
              type: `valid_${i}`,
              payload: { val: i * 3 },
              fn: (p) => p.val + 1,
            }),
          );
        }
      }

      const settledResults = await Promise.allSettled(taskPromises);

      let fulfilledCount = 0;
      let preemptedCount = 0;

      for (let i = 0; i < settledResults.length; i++) {
        const res = settledResults[i];
        if (runawayIndices.has(i)) {
          assert.equal(res.status, 'rejected', `Runaway task ${i} must reject`);
          assert.equal(res.reason.name, 'TaskTimeoutError');
          assert.equal(res.reason.preempted, true);
          preemptedCount++;
        } else {
          assert.equal(res.status, 'fulfilled', `Valid task ${i} must fulfill`);
          assert.equal(res.value, i * 3 + 1);
          fulfilledCount++;
        }
      }

      assert.equal(preemptedCount, 5, 'All 5 runaway tasks were preempted');
      assert.equal(fulfilledCount, 15, 'All 15 legitimate tasks completed');

      // Wait for all replacements to settle
      const deadline = Date.now() + 3000;
      while (runtime.stats.totalWorkers !== 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.equal(runtime.stats.totalWorkers, 3, 'Worker pool restored to 3 workers');
      assert.equal(runtime.stats.preemptedTasksCount, 5);
      assert.equal(runtime.stats.completedTasks, 15);
      assert.equal(runtime.stats.failedTasks, 5);

      // Verify the healed pool continues processing new tasks
      const postRecoveryResult = await runtime.execute({
        fn: () => 'pool_healthy',
      });
      assert.equal(postRecoveryResult, 'pool_healthy');
    } finally {
      await runtime.shutdown();
    }
  });
});
