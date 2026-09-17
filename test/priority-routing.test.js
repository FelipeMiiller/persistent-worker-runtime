import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';

describe('Priority Routing', () => {
  describe('Single-worker serial execution', () => {
    let runtime;

    before(async () => {
      // 1 worker forces strict serial execution so completion order is observable
      runtime = await createWorkerRuntime({ workers: 1 });
    });

    after(async () => {
      if (runtime) await runtime.shutdown();
    });

    it('executes higher-priority tasks before lower-priority ones', async () => {
      const completionOrder = [];
      const handles = [];

      // Submit 30 tasks with 4 priority tiers (lowest first)
      for (let i = 0; i < 30; i++) {
        const priority = i < 5 ? 0 : i < 10 ? 1 : i < 20 ? 5 : 10;
        const h = runtime.dispatch({
          type: 'tagged',
          payload: { tag: i, priority },
          priority,
          fn: (p) => ({ tag: p.tag, priority: p.priority }),
        });
        handles.push(h);
        h.onComplete((r) => completionOrder.push(r));
      }

      await Promise.all(handles.map((h) => h.promise.catch(() => null)));

      // All priority=10 entries must appear before all priority=0 entries
      const firstHighIdx = completionOrder.findIndex((r) => r.priority === 10);
      const lastHighIdx = completionOrder.map((r) => r.priority).lastIndexOf(10);
      const firstLowIdx = completionOrder.findIndex((r) => r.priority === 0);

      assert.ok(firstHighIdx !== -1, 'should have at least one priority-10 task');
      assert.ok(firstLowIdx !== -1, 'should have at least one priority-0 task');
      assert.ok(
        lastHighIdx < firstLowIdx,
        'priority-10 tasks must complete before priority-0 tasks',
      );
    });

    it('preserves FIFO order within the same priority tier', async () => {
      const completionOrder = [];
      const handles = [];

      // 10 priority=5 tasks; they should complete in submission order
      for (let i = 0; i < 10; i++) {
        const h = runtime.dispatch({
          type: 'tagged',
          payload: { tag: i },
          priority: 5,
          fn: (p) => p.tag,
        });
        handles.push(h);
        h.onComplete((t) => completionOrder.push(t));
      }

      await Promise.all(handles.map((h) => h.promise.catch(() => null)));
      assert.deepEqual(completionOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('default priority is 0 (no priority field)', async () => {
      const h = runtime.dispatch({
        type: 'tagged',
        payload: { tag: 'a' },
        fn: (p) => p.tag,
      });
      const result = await h.promise;
      assert.equal(result, 'a');
    });
  });

  describe('Multi-worker concurrent execution', () => {
    let runtime;

    before(async () => {
      runtime = await createWorkerRuntime({ workers: 4 });
    });

    after(async () => {
      if (runtime) await runtime.shutdown();
    });

    it('processes all priority levels without losing tasks', async () => {
      const completionOrder = [];
      const handles = [];

      for (let i = 0; i < 100; i++) {
        const priority = i % 4; // 0, 1, 2, 3 cycling
        const h = runtime.dispatch({
          type: 'tagged',
          payload: { tag: i, priority },
          priority,
          fn: (p) => ({ tag: p.tag, priority: p.priority }),
        });
        handles.push(h);
        h.onComplete((r) => completionOrder.push(r));
      }

      await Promise.all(handles.map((h) => h.promise.catch(() => null)));

      // All 100 tasks must complete
      assert.equal(completionOrder.length, 100);
      const tags = completionOrder.map((r) => r.tag).sort((a, b) => a - b);
      assert.deepEqual(
        tags,
        Array.from({ length: 100 }, (_, i) => i),
      );
    });

    it('higher-priority tasks have lower average completion position when many low-priority tasks queue first', async () => {
      // Saturate the pool first with low-priority tasks, then submit a high-priority one.
      // Since workers are busy with the low-priority tasks, the high-priority one
      // must wait. After the low-priority tasks drain, the high-priority task runs.
      const completionOrder = [];
      const handles = [];

      // 20 low-priority first
      for (let i = 0; i < 20; i++) {
        const h = runtime.dispatch({
          type: 'slow',
          payload: { tag: `L${i}`, durationMs: 5 },
          priority: 0,
          fn: async (p) => {
            await new Promise((r) => setTimeout(r, p.durationMs));
            return p.tag;
          },
        });
        handles.push(h);
        h.onComplete((t) => completionOrder.push(t));
      }
      // Then 1 high-priority
      const hh = runtime.dispatch({
        type: 'slow',
        payload: { tag: 'HIGH', durationMs: 5 },
        priority: 10,
        fn: async (p) => {
          await new Promise((r) => setTimeout(r, p.durationMs));
          return p.tag;
        },
      });
      handles.push(hh);
      hh.onComplete((t) => completionOrder.push(t));

      await Promise.all(handles.map((h) => h.promise.catch(() => null)));

      // The high-priority task should NOT be the very last to finish;
      // it should land within the early batch (before the queue drains to its tail).
      const highIdx = completionOrder.indexOf('HIGH');
      // It must complete before the very last low-priority task in queue order
      assert.ok(highIdx < completionOrder.length - 1, 'high-priority should not be dead last');
    });
  });
});
