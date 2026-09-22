import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';

describe('Concurrency & Pool Saturation Stress Tests', () => {
  let runtime;

  before(async () => {
    // 4 workers pool simulating production capacity
    runtime = await createWorkerRuntime({
      workers: 4,
      maxQueueSize: 500,
      queueTimeoutMs: 10000,
    });
  });

  after(async () => {
    if (runtime) {
      await runtime.shutdown();
    }
  });

  it('handles multiple overlapping executeAll batches concurrently without deadlocks', async () => {
    // Simulate Request 1 submitting 4 tasks
    const request1 = runtime.executeAll([
      {
        type: 'r1_t1',
        payload: { id: 1 },
        fn: async (p) => {
          await new Promise((r) => setTimeout(r, 20));
          return p.id * 10;
        },
      },
      {
        type: 'r1_t2',
        payload: { id: 2 },
        fn: async (p) => {
          await new Promise((r) => setTimeout(r, 20));
          return p.id * 10;
        },
      },
      {
        type: 'r1_t3',
        payload: { id: 3 },
        fn: async (p) => {
          await new Promise((r) => setTimeout(r, 20));
          return p.id * 10;
        },
      },
      {
        type: 'r1_t4',
        payload: { id: 4 },
        fn: async (p) => {
          await new Promise((r) => setTimeout(r, 20));
          return p.id * 10;
        },
      },
    ]);

    // Simultaneously, Request 2 submits 4 tasks
    const request2 = runtime.executeAll([
      {
        type: 'r2_t1',
        payload: { id: 10 },
        fn: async (p) => {
          await new Promise((r) => setTimeout(r, 20));
          return p.id * 2;
        },
      },
      {
        type: 'r2_t2',
        payload: { id: 20 },
        fn: async (p) => {
          await new Promise((r) => setTimeout(r, 20));
          return p.id * 2;
        },
      },
      {
        type: 'r2_t3',
        payload: { id: 30 },
        fn: async (p) => {
          await new Promise((r) => setTimeout(r, 20));
          return p.id * 2;
        },
      },
      {
        type: 'r2_t4',
        payload: { id: 40 },
        fn: async (p) => {
          await new Promise((r) => setTimeout(r, 20));
          return p.id * 2;
        },
      },
    ]);

    // Simultaneously, Request 3 submits 2 tasks
    const request3 = runtime.executeAll([
      { type: 'r3_t1', payload: { id: 100 }, fn: (p) => p.id + 1 },
      { type: 'r3_t2', payload: { id: 200 }, fn: (p) => p.id + 2 },
    ]);

    // All 3 requests execute concurrently through the 4-worker pool
    const [res1, res2, res3] = await Promise.all([request1, request2, request3]);

    assert.deepEqual(res1, [10, 20, 30, 40]);
    assert.deepEqual(res2, [20, 40, 60, 80]);
    assert.deepEqual(res3, [101, 202]);
  });

  it('processes 80 concurrent tasks across 8 simultaneous requests with FIFO draining', async () => {
    const totalRequests = 8;
    const tasksPerRequest = 10;
    const requests = [];

    for (let r = 0; r < totalRequests; r++) {
      const batch = Array.from({ length: tasksPerRequest }, (_, t) => ({
        type: `req_${r}_task_${t}`,
        payload: { req: r, task: t },
        fn: (p) => `${p.req}:${p.task}`,
      }));

      requests.push(runtime.executeAll(batch));
    }

    const allResults = await Promise.all(requests);

    assert.equal(allResults.length, totalRequests);
    for (let r = 0; r < totalRequests; r++) {
      assert.equal(allResults[r].length, tasksPerRequest);
      for (let t = 0; t < tasksPerRequest; t++) {
        assert.equal(allResults[r][t], `${r}:${t}`);
      }
    }
  });

  it('seamlessly interleaves execute() and dispatch() calls during heavy saturation', async () => {
    const dispatchConfirmations = [];
    const executePromises = [];

    // Dispatch 20 background tasks
    for (let i = 0; i < 20; i++) {
      const handle = runtime.dispatch({
        type: 'bg_outbox',
        payload: { idx: i },
        fn: (p) => ({ processed: true, idx: p.idx }),
      });

      const confirmPromise = new Promise((resolve) => {
        handle.onComplete((res) => resolve(res));
      });
      dispatchConfirmations.push(confirmPromise);
    }

    // Simultaneously execute 20 interactive tasks
    for (let i = 0; i < 20; i++) {
      executePromises.push(
        runtime.execute({
          type: 'interactive',
          payload: { idx: i },
          fn: (p) => p.idx * 100,
        }),
      );
    }

    // Both interactive and background tasks complete cleanly
    const [dispatched, executed] = await Promise.all([
      Promise.all(dispatchConfirmations),
      Promise.all(executePromises),
    ]);

    assert.equal(dispatched.length, 20);
    assert.equal(executed.length, 20);
    assert.equal(dispatched[0].processed, true);
    assert.equal(executed[19], 1900);
  });
});
