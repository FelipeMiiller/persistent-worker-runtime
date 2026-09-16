import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerRuntime, Supervisor, WorkerHandle, TaskHandle } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_SCRIPT = join(__dirname, '../src/worker-thread-entry.js');

describe('Worker Recycling - Configuration & Validation (T1)', () => {
  describe('Default configuration', () => {
    it('defaults maxTasksPerWorker and maxMemoryMb to Infinity', () => {
      const runtime = new WorkerRuntime();
      assert.equal(runtime.maxTasksPerWorker, Infinity);
      assert.equal(runtime.maxMemoryMb, Infinity);
    });

    it('defaults Supervisor maxTasksPerWorker and maxMemoryMb to Infinity when instantiated directly', () => {
      const supervisor = new Supervisor();
      assert.equal(supervisor.maxTasksPerWorker, Infinity);
      assert.equal(supervisor.maxMemoryMb, Infinity);
    });
  });

  describe('Valid custom configuration', () => {
    it('accepts valid positive numbers for maxTasksPerWorker and maxMemoryMb', () => {
      const runtime = new WorkerRuntime({
        maxTasksPerWorker: 100,
        maxMemoryMb: 256,
      });
      assert.equal(runtime.maxTasksPerWorker, 100);
      assert.equal(runtime.maxMemoryMb, 256);
    });

    it('accepts explicit Infinity for both options', () => {
      const runtime = new WorkerRuntime({
        maxTasksPerWorker: Infinity,
        maxMemoryMb: Infinity,
      });
      assert.equal(runtime.maxTasksPerWorker, Infinity);
      assert.equal(runtime.maxMemoryMb, Infinity);
    });

    it('accepts valid float for maxMemoryMb', () => {
      const runtime = new WorkerRuntime({
        maxMemoryMb: 512.5,
      });
      assert.equal(runtime.maxMemoryMb, 512.5);
    });

    it('Supervisor receives maxTasksPerWorker and maxMemoryMb correctly', () => {
      const supervisor = new Supervisor({
        maxTasksPerWorker: 50,
        maxMemoryMb: 128,
      });
      assert.equal(supervisor.maxTasksPerWorker, 50);
      assert.equal(supervisor.maxMemoryMb, 128);
    });
  });

  describe('Validation of maxTasksPerWorker', () => {
    it('throws TypeError if maxTasksPerWorker is a string', () => {
      assert.throws(
        () => new WorkerRuntime({ maxTasksPerWorker: '100' }),
        {
          name: 'TypeError',
          message: 'maxTasksPerWorker must be a positive number or Infinity',
        }
      );
    });

    it('throws TypeError if maxTasksPerWorker is a boolean', () => {
      assert.throws(
        () => new WorkerRuntime({ maxTasksPerWorker: true }),
        {
          name: 'TypeError',
          message: 'maxTasksPerWorker must be a positive number or Infinity',
        }
      );
    });

    it('throws TypeError if maxTasksPerWorker is null', () => {
      assert.throws(
        () => new WorkerRuntime({ maxTasksPerWorker: null }),
        {
          name: 'TypeError',
          message: 'maxTasksPerWorker must be a positive number or Infinity',
        }
      );
    });

    it('throws TypeError if maxTasksPerWorker is an object', () => {
      assert.throws(
        () => new WorkerRuntime({ maxTasksPerWorker: {} }),
        {
          name: 'TypeError',
          message: 'maxTasksPerWorker must be a positive number or Infinity',
        }
      );
    });

    it('throws TypeError if maxTasksPerWorker is NaN', () => {
      assert.throws(
        () => new WorkerRuntime({ maxTasksPerWorker: NaN }),
        {
          name: 'TypeError',
          message: 'maxTasksPerWorker must be a positive number or Infinity',
        }
      );
    });

    it('throws RangeError if maxTasksPerWorker is 0', () => {
      assert.throws(
        () => new WorkerRuntime({ maxTasksPerWorker: 0 }),
        {
          name: 'RangeError',
          message: 'maxTasksPerWorker must be greater than 0',
        }
      );
    });

    it('throws RangeError if maxTasksPerWorker is negative', () => {
      assert.throws(
        () => new WorkerRuntime({ maxTasksPerWorker: -5 }),
        {
          name: 'RangeError',
          message: 'maxTasksPerWorker must be greater than 0',
        }
      );
    });
  });

  describe('Validation of maxMemoryMb', () => {
    it('throws TypeError if maxMemoryMb is a string', () => {
      assert.throws(
        () => new WorkerRuntime({ maxMemoryMb: '256' }),
        {
          name: 'TypeError',
          message: 'maxMemoryMb must be a positive number or Infinity',
        }
      );
    });

    it('throws TypeError if maxMemoryMb is a boolean', () => {
      assert.throws(
        () => new WorkerRuntime({ maxMemoryMb: false }),
        {
          name: 'TypeError',
          message: 'maxMemoryMb must be a positive number or Infinity',
        }
      );
    });

    it('throws TypeError if maxMemoryMb is null', () => {
      assert.throws(
        () => new WorkerRuntime({ maxMemoryMb: null }),
        {
          name: 'TypeError',
          message: 'maxMemoryMb must be a positive number or Infinity',
        }
      );
    });

    it('throws TypeError if maxMemoryMb is an object', () => {
      assert.throws(
        () => new WorkerRuntime({ maxMemoryMb: [] }),
        {
          name: 'TypeError',
          message: 'maxMemoryMb must be a positive number or Infinity',
        }
      );
    });

    it('throws TypeError if maxMemoryMb is NaN', () => {
      assert.throws(
        () => new WorkerRuntime({ maxMemoryMb: NaN }),
        {
          name: 'TypeError',
          message: 'maxMemoryMb must be a positive number or Infinity',
        }
      );
    });

    it('throws RangeError if maxMemoryMb is 0', () => {
      assert.throws(
        () => new WorkerRuntime({ maxMemoryMb: 0 }),
        {
          name: 'RangeError',
          message: 'maxMemoryMb must be greater than 0',
        }
      );
    });

    it('throws RangeError if maxMemoryMb is negative', () => {
      assert.throws(
        () => new WorkerRuntime({ maxMemoryMb: -50 }),
        {
          name: 'RangeError',
          message: 'maxMemoryMb must be greater than 0',
        }
      );
    });
  });
});

describe('Worker Recycling - Memory Reporting in worker-thread-entry (T2)', () => {
  it('reports memoryUsageBytes on successful task completion', async () => {
    const worker = new Worker(WORKER_SCRIPT);

    try {
      await new Promise((resolve) => {
        worker.once('message', (msg) => {
          if (msg.type === 'ready') resolve();
        });
      });

      const responsePromise = new Promise((resolve) => {
        worker.once('message', (msg) => {
          resolve(msg);
        });
      });

      worker.postMessage({
        taskId: 't2-success-task',
        type: 'compute',
        payload: { value: 42 },
        fnCode: 'p => p.value * 2',
      });

      const response = await responsePromise;

      assert.equal(response.taskId, 't2-success-task');
      assert.equal(response.success, true);
      assert.equal(response.result, 84);
      assert.equal(typeof response.memoryUsageBytes, 'number');
      assert.ok(response.memoryUsageBytes > 0, 'memoryUsageBytes must be greater than 0');
    } finally {
      await worker.terminate();
    }
  });

  it('reports memoryUsageBytes on task execution failure', async () => {
    const worker = new Worker(WORKER_SCRIPT);

    try {
      await new Promise((resolve) => {
        worker.once('message', (msg) => {
          if (msg.type === 'ready') resolve();
        });
      });

      const responsePromise = new Promise((resolve) => {
        worker.once('message', (msg) => {
          resolve(msg);
        });
      });

      worker.postMessage({
        taskId: 't2-fail-task',
        type: 'failing_compute',
        payload: {},
        fnCode: '() => { throw new Error("intentional task failure"); }',
      });

      const response = await responsePromise;

      assert.equal(response.taskId, 't2-fail-task');
      assert.equal(response.success, false);
      assert.ok(response.error);
      assert.equal(response.error.message, 'intentional task failure');
      assert.equal(typeof response.memoryUsageBytes, 'number');
      assert.ok(response.memoryUsageBytes > 0, 'memoryUsageBytes must be greater than 0');
    } finally {
      await worker.terminate();
    }
  });
});

describe('Worker Recycling - Recycling State in WorkerHandle (T3)', () => {
  it('transitions to recycling state and updates isIdle/isRecycling flags', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    try {
      assert.equal(worker.status, 'idle');
      assert.equal(worker.isIdle, true);
      assert.equal(worker.isRecycling, false);

      worker.markRecycling();

      assert.equal(worker.status, 'recycling');
      assert.equal(worker.isIdle, false);
      assert.equal(worker.isRecycling, true);
    } finally {
      await worker.terminate();
    }
  });

  it('rejects task execution when worker is in recycling state', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    try {
      worker.markRecycling();

      const task = new TaskHandle({
        type: 'test_reject',
        payload: {},
        fn: () => 'should not run',
      });

      await assert.rejects(
        () => worker.executeTask(task),
        {
          name: 'WorkerRuntimeError',
          message: `Worker ${worker.id} is busy with status: recycling`,
        }
      );
    } finally {
      await worker.terminate();
    }
  });

  it('records last sampled memory usage upon task completion', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    try {
      assert.equal(worker.lastMemoryUsageBytes, 0);

      const task = new TaskHandle({
        type: 'mem_task',
        payload: { text: 'hello world' },
        fn: (p) => p.text.toUpperCase(),
      });

      const result = await worker.executeTask(task);
      assert.equal(result, 'HELLO WORLD');

      assert.equal(typeof worker.lastMemoryUsageBytes, 'number');
      assert.ok(worker.lastMemoryUsageBytes > 0, 'lastMemoryUsageBytes must be greater than 0');
      assert.equal(worker.lastMemoryUsage, worker.lastMemoryUsageBytes);
    } finally {
      await worker.terminate();
    }
  });

  it('preserves recycling state when active task finishes', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    try {
      const task = new TaskHandle({
        type: 'delayed_task',
        payload: { ms: 50 },
        fn: async (p) => {
          await new Promise((resolve) => setTimeout(resolve, p.ms));
          return 'ok';
        },
      });

      const executionPromise = worker.executeTask(task);
      assert.equal(worker.status, 'busy');

      // Mark recycling while task is in flight
      worker.markRecycling();
      assert.equal(worker.status, 'recycling');
      assert.equal(worker.isRecycling, true);
      assert.equal(worker.isIdle, false);

      const result = await executionPromise;
      assert.equal(result, 'ok');

      // Status must remain recycling after task settlement, NOT reset to idle
      assert.equal(worker.status, 'recycling');
      assert.equal(worker.isRecycling, true);
      assert.equal(worker.isIdle, false);
      assert.ok(worker.lastMemoryUsageBytes > 0);
    } finally {
      await worker.terminate();
    }
  });

  it('does not overwrite terminating or terminated status when markRecycling is called', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    await worker.terminate();
    assert.equal(worker.status, 'terminated');

    worker.markRecycling();
    assert.equal(worker.status, 'terminated');
    assert.equal(worker.isRecycling, false);
  });
});
