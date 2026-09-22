import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';

// HARDEN-08 (ADR-0024 C3) — tasks-exhausted recycle opt.
//
// Acceptance criteria under test:
//   1. With `recycleOnTasksExhausted: false`, a worker that crosses
//      `maxTasksPerWorker` emits `worker:tasks:exhausted` and is NOT
//      recycled. The user keeps control over when to drain/replace.
//   2. With the default `recycleOnTasksExhausted: true`, the worker IS
//      recycled on the threshold-crossing task (pre-HARDEN-08
//      behavior, back-compat).
//
// Idempotency: the supervisor emits `worker_tasks:exhausted` at most
// once per worker (deduped via `#tasksExhaustedNotified`) so subsequent
// `task_completed` events on the same exhausted worker don't spam the
// listener.

describe('WorkerRuntime — recycleOnTasksExhausted opt (HARDEN-08)', () => {
  it('emits worker:tasks:exhausted and skips recycling when opt is false', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxTasksPerWorker: 10,
      recycleOnTasksExhausted: false,
    });

    try {
      const exhaustedEvents = [];
      const recycledEvents = [];
      runtime.on('worker:tasks:exhausted', (data) => exhaustedEvents.push(data));
      runtime.on('worker:recycled', (data) => recycledEvents.push(data));

      // Dispatch 20 sequential tasks. With maxTasksPerWorker=10 and
      // recycleOnTasksExhausted=false, the worker crosses the threshold
      // on task 10 (tasksCompleted=10 >= maxTasksPerWorker=10) and is
      // NOT recycled. Tasks 11-20 keep running on the same worker
      // (the supervisor no longer schedules it for recycling).
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(runtime.execute({ fn: () => 42 }));
      }
      await Promise.all(promises);

      // The warning must have fired at least once — exactly once,
      // because the supervisor dedupes per worker. Verify both the
      // count AND the payload shape.
      assert.ok(
        exhaustedEvents.length >= 1,
        `expected at least 1 worker:tasks:exhausted event, got ${exhaustedEvents.length}`,
      );
      // With 1 worker + dedup, should be exactly 1.
      assert.equal(
        exhaustedEvents.length,
        1,
        `expected exactly 1 exhausted event (idempotent per worker), got ${exhaustedEvents.length}`,
      );

      // Payload shape per ADR-0024 C3:
      //   { workerId, tasksCompleted, maxTasksPerWorker }
      const ev = exhaustedEvents[0];
      assert.equal(typeof ev.workerId, 'string');
      assert.ok(ev.workerId.length > 0);
      assert.equal(ev.tasksCompleted, 10, 'fired at the exact threshold-crossing task');
      assert.equal(ev.maxTasksPerWorker, 10);

      // Critically: NO recycling. The worker keeps serving tasks 11-20.
      assert.equal(
        recycledEvents.length,
        0,
        `worker must NOT be recycled when recycleOnTasksExhausted is false; got ${recycledEvents.length} recycled events`,
      );

      // Pool capacity is preserved (still 1 worker after all 20 tasks).
      assert.equal(runtime.stats.totalWorkers, 1);
    } finally {
      await runtime.shutdown();
    }
  });

  it('recycles worker on maxTasksPerWorker when opt is true (default — back-compat)', async () => {
    const runtime = await createWorkerRuntime({
      workers: 1,
      maxTasksPerWorker: 10,
      // recycleOnTasksExhausted omitted → default `true`.
    });

    try {
      assert.equal(runtime.recycleOnTasksExhausted, true, 'runtime default must be true');

      const exhaustedEvents = [];
      const recycledEvents = [];
      runtime.on('worker:tasks:exhausted', (data) => exhaustedEvents.push(data));
      runtime.on('worker:recycled', (data) => recycledEvents.push(data));

      // Dispatch 20 tasks. With default opt, the worker crosses the
      // threshold at task 10 and IS recycled. The replacement takes
      // tasks 11-20. Multiple workers see the threshold as they each
      // process up to 10 tasks.
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(runtime.execute({ fn: () => 42 }));
      }
      await Promise.all(promises);

      // With 20 tasks on 1 worker and maxTasksPerWorker=10, at least
      // 2 recycles must have fired (the original worker + at least one
      // replacement, depending on timing). Allow generous headroom.
      const deadline = Date.now() + 3000;
      while (recycledEvents.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        recycledEvents.length >= 2,
        `expected at least 2 recycled events with default opt, got ${recycledEvents.length}`,
      );

      // No exhausted warning fires when recycling is enabled — the
      // recycle path takes precedence.
      assert.equal(
        exhaustedEvents.length,
        0,
        `exhausted warning must NOT fire when recycling is enabled; got ${exhaustedEvents.length}`,
      );
    } finally {
      await runtime.shutdown();
    }
  });
});
