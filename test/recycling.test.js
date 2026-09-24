import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createWorkerRuntime,
  Supervisor,
  TaskHandle,
  WorkerHandle,
  WorkerRuntime,
} from '../src/index.js';

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
      // T6 (ADR-0023): Supervisor no longer carries a magic default for
      // `workers` — WorkerRuntime always passes a finite integer via
      // `resolveWorkerCount`. Direct Supervisor construction must
      // therefore pass `workers` explicitly; passing `{ workers: 1 }`
      // here exercises the option-getter defaults without spawning a
      // pool (this test never calls `supervisor.start()`).
      const supervisor = new Supervisor({ workers: 1 });
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
      // T6 (ADR-0023): `workers` is now mandatory on direct Supervisor
      // construction; pass it explicitly even when the test only
      // exercises the option getters.
      const supervisor = new Supervisor({
        workers: 1,
        maxTasksPerWorker: 50,
        maxMemoryMb: 128,
      });
      assert.equal(supervisor.maxTasksPerWorker, 50);
      assert.equal(supervisor.maxMemoryMb, 128);
    });
  });

  describe('Validation of maxTasksPerWorker', () => {
    it('throws TypeError if maxTasksPerWorker is a string', () => {
      assert.throws(() => new WorkerRuntime({ maxTasksPerWorker: '100' }), {
        name: 'TypeError',
        message: 'maxTasksPerWorker must be a positive number or Infinity',
      });
    });

    it('throws TypeError if maxTasksPerWorker is a boolean', () => {
      assert.throws(() => new WorkerRuntime({ maxTasksPerWorker: true }), {
        name: 'TypeError',
        message: 'maxTasksPerWorker must be a positive number or Infinity',
      });
    });

    it('throws TypeError if maxTasksPerWorker is null', () => {
      assert.throws(() => new WorkerRuntime({ maxTasksPerWorker: null }), {
        name: 'TypeError',
        message: 'maxTasksPerWorker must be a positive number or Infinity',
      });
    });

    it('throws TypeError if maxTasksPerWorker is an object', () => {
      assert.throws(() => new WorkerRuntime({ maxTasksPerWorker: {} }), {
        name: 'TypeError',
        message: 'maxTasksPerWorker must be a positive number or Infinity',
      });
    });

    it('throws TypeError if maxTasksPerWorker is NaN', () => {
      assert.throws(() => new WorkerRuntime({ maxTasksPerWorker: NaN }), {
        name: 'TypeError',
        message: 'maxTasksPerWorker must be a positive number or Infinity',
      });
    });

    it('throws RangeError if maxTasksPerWorker is 0', () => {
      assert.throws(() => new WorkerRuntime({ maxTasksPerWorker: 0 }), {
        name: 'RangeError',
        message: 'maxTasksPerWorker must be greater than 0',
      });
    });

    it('throws RangeError if maxTasksPerWorker is negative', () => {
      assert.throws(() => new WorkerRuntime({ maxTasksPerWorker: -5 }), {
        name: 'RangeError',
        message: 'maxTasksPerWorker must be greater than 0',
      });
    });
  });

  describe('Validation of maxMemoryMb', () => {
    it('throws TypeError if maxMemoryMb is a string', () => {
      assert.throws(() => new WorkerRuntime({ maxMemoryMb: '256' }), {
        name: 'TypeError',
        message: 'maxMemoryMb must be a positive number or Infinity',
      });
    });

    it('throws TypeError if maxMemoryMb is a boolean', () => {
      assert.throws(() => new WorkerRuntime({ maxMemoryMb: false }), {
        name: 'TypeError',
        message: 'maxMemoryMb must be a positive number or Infinity',
      });
    });

    it('throws TypeError if maxMemoryMb is null', () => {
      assert.throws(() => new WorkerRuntime({ maxMemoryMb: null }), {
        name: 'TypeError',
        message: 'maxMemoryMb must be a positive number or Infinity',
      });
    });

    it('throws TypeError if maxMemoryMb is an object', () => {
      assert.throws(() => new WorkerRuntime({ maxMemoryMb: [] }), {
        name: 'TypeError',
        message: 'maxMemoryMb must be a positive number or Infinity',
      });
    });

    it('throws TypeError if maxMemoryMb is NaN', () => {
      assert.throws(() => new WorkerRuntime({ maxMemoryMb: NaN }), {
        name: 'TypeError',
        message: 'maxMemoryMb must be a positive number or Infinity',
      });
    });

    it('throws RangeError if maxMemoryMb is 0', () => {
      assert.throws(() => new WorkerRuntime({ maxMemoryMb: 0 }), {
        name: 'RangeError',
        message: 'maxMemoryMb must be greater than 0',
      });
    });

    it('throws RangeError if maxMemoryMb is negative', () => {
      assert.throws(() => new WorkerRuntime({ maxMemoryMb: -50 }), {
        name: 'RangeError',
        message: 'maxMemoryMb must be greater than 0',
      });
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

      await assert.rejects(() => worker.executeTask(task), {
        name: 'WorkerRuntimeError',
        message: `Worker ${worker.id} is busy with status: recycling`,
      });
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

describe('Worker Recycling - Supervisor Orchestration & Replacement (T4)', () => {
  it('recycles worker when maxTasksPerWorker is reached and preserves pool capacity', async () => {
    const runtime = await createWorkerRuntime({
      workers: 2,
      maxTasksPerWorker: 2,
    });

    try {
      const recyclingEvents = [];
      const recycledEvents = [];

      runtime.on('worker_recycling', (e) => recyclingEvents.push(e));
      runtime.on('worker_recycled', (e) => recycledEvents.push(e));

      // Dispatch 4 sequential tasks
      const r1 = await runtime.execute({ fn: () => 1 });
      const r2 = await runtime.execute({ fn: () => 2 });
      const r3 = await runtime.execute({ fn: () => 3 });
      const r4 = await runtime.execute({ fn: () => 4 });

      assert.deepEqual([r1, r2, r3, r4], [1, 2, 3, 4]);

      // Give worker thread replacement a moment to complete settlement
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.ok(recyclingEvents.length >= 1, 'At least one worker must trigger recycling');
      assert.equal(recyclingEvents[0].reason, 'tasks_exceeded');
      assert.ok(recyclingEvents[0].workerId);
      assert.ok(recyclingEvents[0].tasksCompleted >= 2);
      assert.ok(recyclingEvents[0].memoryUsage > 0);

      assert.ok(recycledEvents.length >= 1, 'At least one worker must be recycled');
      assert.ok(recycledEvents[0].oldWorkerId);
      assert.ok(recycledEvents[0].newWorkerId);
      assert.notEqual(recycledEvents[0].oldWorkerId, recycledEvents[0].newWorkerId);

      // Verify pool size remains 2
      assert.equal(runtime.stats.totalWorkers, 2);
    } finally {
      await runtime.shutdown();
    }
  });

  it('recycles worker when maxMemoryMb threshold is exceeded', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxMemoryMb: 20,
    });

    try {
      const recyclingEvents = [];
      const recycledEvents = [];

      runtime.on('worker_recycling', (e) => recyclingEvents.push(e));
      runtime.on('worker_recycled', (e) => recycledEvents.push(e));

      // Execute a task allocating >20MB on V8 heap and storing in state
      const result = await runtime.execute({
        fn: (_, state) => {
          const arr = [];
          for (let i = 0; i < 400000; i++) {
            arr.push({ id: i, text: 'leak-simulation-payload' });
          }
          state.set('memory_leak', arr);
          return { allocated: arr.length };
        },
      });

      assert.equal(result.allocated, 400000);

      // Wait for recycling to settle
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(recyclingEvents.length, 1);
      assert.equal(recyclingEvents[0].reason, 'memory_exceeded');
      assert.ok(recyclingEvents[0].memoryUsage > 20 * 1024 * 1024);

      assert.equal(recycledEvents.length, 1);
      assert.equal(runtime.stats.totalWorkers, 1);

      // Verify replacement worker can execute a subsequent task and has clean L1 state
      const nextResult = await runtime.execute({
        fn: (_, state) => {
          return { hasOldState: state.has('memory_leak') };
        },
      });

      assert.equal(
        nextResult.hasOldState,
        false,
        'Replacement worker must have fresh clean clean L1 heap',
      );
    } finally {
      await runtime.shutdown();
    }
  });

  // RECYCLE-08 — negative-case assertion: when memory stays below the threshold,
  // NO worker_recycling event should fire. Spec-precision gap previously covered
  // only by the implicit absence of recycling in tests that didn't trip the
  // threshold. See `.specs/features/worker-recycling/validation.md` for context.
  it('does NOT recycle when memory stays below maxMemoryMb threshold (RECYCLE-08)', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxMemoryMb: 1024, // 1 GB threshold — impossible to trip with 1 byte
    });

    try {
      const recyclingEvents = [];
      const recycledEvents = [];

      runtime.on('worker_recycling', (e) => recyclingEvents.push(e));
      runtime.on('worker_recycled', (e) => recycledEvents.push(e));

      // Execute a task that allocates only a few bytes — well below 1 GB.
      const result = await runtime.execute({
        fn: () => ({ allocated: 1 }),
      });

      assert.equal(result.allocated, 1);

      // Wait long enough that any spurious recycling would have fired.
      // (Recycle check cadence is ~100 ms; wait 5× that to be safe.)
      await new Promise((resolve) => setTimeout(resolve, 500));

      assert.equal(
        recyclingEvents.length,
        0,
        'worker_recycling MUST NOT fire when memory is below maxMemoryMb threshold',
      );
      assert.equal(
        recycledEvents.length,
        0,
        'worker_recycled MUST NOT fire when memory is below maxMemoryMb threshold',
      );
      assert.equal(
        runtime.stats.totalWorkers,
        1,
        'Pool size MUST stay at the configured value (no spawn needed)',
      );
      assert.equal(
        runtime.stats.recycledWorkersCount,
        0,
        'recycledWorkersCount counter MUST stay at 0',
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it('guarantees zero dropped tasks during high-concurrency recycling stress', async () => {
    const runtime = await createWorkerRuntime({
      workers: 3,
      maxTasksPerWorker: 3, // frequent recycling
    });

    try {
      const taskCount = 30;
      const tasks = Array.from({ length: taskCount }, (_, i) => ({
        type: `task_${i}`,
        payload: { i },
        fn: (p) => p.i * 10,
      }));

      // Execute all 30 tasks concurrently
      const results = await runtime.executeAll(tasks);

      assert.equal(results.length, taskCount);
      for (let i = 0; i < taskCount; i++) {
        assert.equal(results[i], i * 10, `Task ${i} result must match`);
      }

      // Wait for any remaining recycling events to settle
      const deadline = Date.now() + 3000;
      while (runtime.stats.totalWorkers !== 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(
        runtime.stats.recycledWorkersCount > 0,
        'Recycling must have occurred during stress run',
      );
      assert.equal(runtime.stats.totalWorkers, 3, 'Pool size must remain constant at 3');
      assert.equal(runtime.stats.completedTasks, taskCount);
      assert.equal(runtime.stats.failedTasks, 0);
    } finally {
      await runtime.shutdown();
    }
  });

  it('shuts down cleanly while worker recycling is in progress', async () => {
    const runtime = await createWorkerRuntime({
      workers: 2,
      maxTasksPerWorker: 1,
    });

    // Fire task that triggers recycling
    await runtime.execute({ fn: () => 'trigger' });

    // Immediate shutdown during/right after recycling trigger
    await assert.doesNotReject(async () => {
      await runtime.shutdown();
    });

    assert.equal(runtime.stats.totalWorkers, 0);
  });
});

describe('Worker Recycling - Telemetry in Stats and TypeScript Types (T5)', () => {
  it('exposes and increments recycledWorkersCount in runtime.stats', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxTasksPerWorker: 1,
    });

    try {
      assert.equal(runtime.stats.recycledWorkersCount, 0);

      await runtime.execute({ fn: () => 'task 1' });
      const deadline1 = Date.now() + 3000;
      while (runtime.stats.recycledWorkersCount < 1 && Date.now() < deadline1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(runtime.stats.recycledWorkersCount, 1);

      await runtime.execute({ fn: () => 'task 2' });
      const deadline2 = Date.now() + 3000;
      while (runtime.stats.recycledWorkersCount < 2 && Date.now() < deadline2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(runtime.stats.recycledWorkersCount, 2);
    } finally {
      await runtime.shutdown();
    }
  });

  it('includes all recycling definitions in src/index.d.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const dtsContent = readFileSync(join(__dirname, '../src/index.d.ts'), 'utf8');

    assert.ok(dtsContent.includes('maxTasksPerWorker?: number;'));
    assert.ok(dtsContent.includes('maxMemoryMb?: number;'));
    assert.ok(dtsContent.includes('recycledWorkersCount: number;'));
    assert.ok(dtsContent.includes('WorkerRecyclingEvent'));
    assert.ok(dtsContent.includes('WorkerRecycledEvent'));
    assert.ok(dtsContent.includes("'recycling'"));
    assert.ok(dtsContent.includes('isRecycling: boolean;'));
    assert.ok(dtsContent.includes('markRecycling(): void;'));
  });
});
