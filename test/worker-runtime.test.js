import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerRuntime, WorkerRuntime } from '../src/index.js';

describe('Persistent Worker Runtime Test Suite', () => {
  let runtime;

  before(async () => {
    // Start runtime with 2 workers for controlled testing
    runtime = await createWorkerRuntime({
      workers: 2,
      maxQueueSize: 50,
      queueTimeoutMs: 5000,
    });
  });

  after(async () => {
    if (runtime) {
      await runtime.shutdown();
    }
  });

  it('executes a basic task and returns the result (Request-Response mode)', async () => {
    const result = await runtime.execute({
      type: 'test_compute',
      payload: { value: 42 },
      fn: (payload) => {
        return { calculated: payload.value * 2 };
      },
    });

    assert.equal(result.calculated, 84);
  });

  it('executes multiple tasks in parallel with bounded concurrency (executeAll / Promise.all style)', async () => {
    const tasks = [
      { type: 'op1', payload: { n: 10 }, fn: (p) => p.n + 1 },
      { type: 'op2', payload: { n: 20 }, fn: (p) => p.n + 2 },
      { type: 'op3', payload: { n: 30 }, fn: (p) => p.n + 3 },
      { type: 'op4', payload: { n: 40 }, fn: (p) => p.n + 4 },
    ];

    const results = await runtime.executeAll(tasks);

    assert.deepEqual(results, [11, 22, 33, 44]);
  });

  it('dispatches a background task with asynchronous onComplete confirmation (Transactional Outbox mode)', async () => {
    let completedPayload = null;

    const task = runtime.dispatch({
      type: 'send_outbox_email',
      payload: { outboxId: 999, email: 'user@example.com' },
      fn: (p) => {
        return { sent: true, outboxId: p.outboxId, timestamp: Date.now() };
      },
    });

    assert.ok(task.id, 'Task must have a unique ID');

    const confirmed = await new Promise((resolve, reject) => {
      task.onComplete((res) => {
        completedPayload = res;
        resolve(res);
      });
      task.onError(reject);
    });

    assert.equal(confirmed.sent, true);
    assert.equal(confirmed.outboxId, 999);
    assert.equal(completedPayload.outboxId, 999);
  });

  it('dispatches multiple background tasks with dispatchAll', async () => {
    const tasks = runtime.dispatchAll([
      { type: 'bg1', payload: { id: 1 }, fn: (p) => p.id * 10 },
      { type: 'bg2', payload: { id: 2 }, fn: (p) => p.id * 10 },
    ]);

    assert.equal(tasks.length, 2);

    const [r1, r2] = await Promise.all([tasks[0].promise, tasks[1].promise]);
    assert.equal(r1, 10);
    assert.equal(r2, 20);
  });

  it('maintains persistent L1 worker-local state across multiple executions', async () => {
    const dedicatedWorker = await runtime.createWorker({ name: 'cache-worker' });

    // 1. Set state in worker L1 memory
    await dedicatedWorker.setState('user:101', { name: 'Alice', plan: 'enterprise' });

    // 2. Retrieve state in a subsequent call
    const cached = await dedicatedWorker.getState('user:101');
    assert.deepEqual(cached, { name: 'Alice', plan: 'enterprise' });

    // 3. Execute custom function that reads/mutates the same L1 state
    const result = await dedicatedWorker.executeTask(
      new (await import('../src/task-handle.js')).TaskHandle({
        type: 'mutate_cache',
        payload: { bonus: 50 },
        fn: (p, state) => {
          const user = state.get('user:101');
          user.credits = (user.credits || 100) + p.bonus;
          state.set('user:101', user);
          return user;
        },
      })
    );

    assert.equal(result.credits, 150);

    // 4. Verify state persisted
    const updated = await dedicatedWorker.getState('user:101');
    assert.equal(updated.credits, 150);

    await dedicatedWorker.terminate();
  });

  it('handles task cancellation cleanly with AbortController', async () => {
    const controller = new AbortController();

    const taskPromise = runtime.execute({
      type: 'abort_task',
      payload: { ms: 500 },
      signal: controller.signal,
      fn: async (p) => {
        const start = Date.now();
        while (Date.now() - start < p.ms) {
          // busy spin
        }
        return 'done';
      },
    });

    // Abort task immediately
    controller.abort();

    await assert.rejects(taskPromise, (err) => {
      return err.code === 'ERR_TASK_ABORTED';
    });
  });

  it('enforces execution timeout when task exceeds timeoutMs', async () => {
    const timeoutTask = runtime.execute({
      type: 'slow_task',
      payload: {},
      timeoutMs: 50, // 50ms SLA
      fn: async () => {
        // Sleep for 200ms
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'too_late';
      },
    });

    await assert.rejects(timeoutTask, (err) => {
      return err.code === 'ERR_TASK_TIMEOUT';
    });
  });

  it('reports accurate runtime statistics', () => {
    const stats = runtime.stats;
    assert.ok(stats.totalWorkers >= 2);
    assert.ok(stats.submittedTasks >= 5);
    assert.ok(stats.completedTasks >= 5);
  });
});
