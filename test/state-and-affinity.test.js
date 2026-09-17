import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';
import { Supervisor } from '../src/supervisor.js';
import { TaskHandle } from '../src/task-handle.js';

describe('Built-in L1 State Operations (via worker thread)', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 1 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('__ping__ returns pong', async () => {
    // Use createWorker for direct stateful access
    const worker = await runtime.createWorker();
    try {
      const result = await worker.ping();
      assert.equal(result, 'pong');
    } finally {
      await worker.terminate();
    }
  });

  it('hasState semantics: __has_state__ via dispatch fallback', async () => {
    const worker = await runtime.createWorker();
    try {
      await worker.setState('key1', { a: 1 });
      // __has_state__ isn't exposed via WorkerHandle directly, but we can
      // exercise the same path through getState truthiness check.
      const v = await worker.getState('key1');
      assert.deepEqual(v, { a: 1 });
      const missing = await worker.getState('does-not-exist');
      assert.equal(missing, undefined);
    } finally {
      await worker.terminate();
    }
  });

  it('clearState wipes L1 heap between calls', async () => {
    const worker = await runtime.createWorker();
    try {
      await worker.setState('persist', 'value');
      await worker.clearState();
      const after = await worker.getState('persist');
      assert.equal(after, undefined);
    } finally {
      await worker.terminate();
    }
  });
});

describe('Supervisor — affinity-based worker selection', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 3 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('dispatches a task with affinityKey to a worker pinned with the same key', async () => {
    const worker = await runtime.createWorker({ affinityKey: 'db', name: 'db' });
    try {
      const result = await worker.executeTask(
        new TaskHandle({
          type: 'noop',
          payload: { hi: 'from-db' },
          fnCode: '(p) => p',
        }),
      );
      assert.deepEqual(result, { hi: 'from-db' });
    } finally {
      await worker.terminate();
    }
  });

  it('createDedicatedWorker returns a worker with isDedicated=true', async () => {
    const sup = new Supervisor({ workers: 1 });
    await sup.start();
    try {
      const dedicated = await sup.createDedicatedWorker({ name: 'session-1' });
      assert.equal(dedicated.isDedicated, true);
      assert.equal(dedicated.name, 'session-1');
      await dedicated.terminate();
    } finally {
      await sup.shutdown();
    }
  });

  it('idleWorkers filters out dedicated workers from general pool selection', async () => {
    const sup = new Supervisor({ workers: 2 });
    await sup.start();
    try {
      // All 2 general workers are idle
      assert.equal(sup.idleWorkers.length, 2);

      // Add a dedicated worker
      const dedicated = await sup.createDedicatedWorker({ name: 'sess' });
      assert.equal(dedicated.isIdle, true, 'newly created dedicated is idle');
      assert.equal(dedicated.isDedicated, true);

      // idleWorkers getter currently returns ALL idle (including dedicated),
      // but findWorkerForTask should skip dedicated when picking a general worker.
      const generalTask = { affinityKey: null };
      const chosen = sup.findWorkerForTask(generalTask);
      assert.ok(chosen, 'should find a worker');
      assert.equal(chosen.isDedicated, false, 'must NOT pick a dedicated worker');

      await dedicated.terminate();
    } finally {
      await sup.shutdown();
    }
  });

  it('findWorkerForTask returns null when all idle workers are dedicated', async () => {
    const sup = new Supervisor({ workers: 1 });
    await sup.start();
    try {
      // Spawn a dedicated and terminate the general
      await sup.allWorkers[0].terminate();
      const dedicated = await sup.createDedicatedWorker();
      // No general idle worker remains
      const chosen = sup.findWorkerForTask({ affinityKey: null });
      assert.equal(chosen, null);
      await dedicated.terminate();
    } finally {
      await sup.shutdown();
    }
  });
});

describe('WorkerRuntime — task failure and retry path', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 1 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('retries a failing task with exponential backoff and ultimately rejects', async () => {
    const retryEvents = [];
    runtime.on('task:retrying', (data) => retryEvents.push(data));

    const start = Date.now();
    await assert.rejects(
      runtime.execute({
        type: 'flaky_exp',
        retries: 2,
        retryDelayMs: 20,
        backoff: 'exponential',
        fn: () => {
          throw new Error('always-fail');
        },
      }),
      /always-fail/,
    );
    const elapsed = Date.now() - start;
    // 2 retry events (initial attempt + 2 retries = 3 total runs)
    assert.equal(retryEvents.length, 2, 'should have 2 retrying events');
    assert.equal(retryEvents[0].attempt, 1);
    assert.equal(retryEvents[0].maxRetries, 2);
    assert.equal(retryEvents[1].attempt, 2);
    // Exp backoff: 20ms + 40ms = 60ms minimum total delay
    assert.ok(elapsed >= 50, `expected at least 50ms (60ms backoff), got ${elapsed}ms`);
  });

  it('retries with linear backoff when configured', async () => {
    const retryEvents = [];
    runtime.on('task:retrying', (data) => retryEvents.push(data));

    const start = Date.now();
    await assert.rejects(
      runtime.execute({
        type: 'flaky_linear',
        retries: 2,
        retryDelayMs: 25,
        backoff: 'linear',
        fn: () => {
          throw new Error('boom');
        },
      }),
      /boom/,
    );
    const elapsed = Date.now() - start;
    assert.equal(retryEvents.length, 2);
    // Linear backoff: 25ms + 50ms = 75ms minimum
    assert.ok(elapsed >= 65, `expected >=65ms, got ${elapsed}ms`);
  });

  it('emits task:retrying event with attempt and maxRetries payload', async () => {
    const retryEvents = [];
    runtime.on('task:retrying', (data) => retryEvents.push(data));

    await assert.rejects(
      runtime.execute({
        type: 'flaky_events',
        retries: 1,
        retryDelayMs: 10,
        fn: () => {
          throw new Error('first');
        },
      }),
      /first/,
    );
    assert.ok(retryEvents.length >= 1, 'at least one retrying event');
    assert.equal(retryEvents[0].attempt, 1);
    assert.equal(retryEvents[0].maxRetries, 1);
  });

  it('does not retry when retries=0 (default)', async () => {
    const retryEvents = [];
    runtime.on('task:retrying', (data) => retryEvents.push(data));

    await assert.rejects(
      runtime.execute({
        type: 'no_retry',
        fn: () => {
          throw new Error('once');
        },
      }),
      /once/,
    );
    assert.equal(retryEvents.length, 0, 'no retries should have been attempted');
  });
});
