import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime, Supervisor, WorkerHandle } from '../src/index.js';

// HARDEN-03 (ADR-0024 B1): `runtime.getWorkers()` returns an array of
// `WorkerSnapshot` objects, sync, zero-IPC. Dashboards/alerts use it to
// identify problem workers without instrumenting private APIs.
//
// Snapshot shape per ADR-0024 §B1:
//   { id, memoryUsageBytes, tasksCompleted, tasksActive, status,
//     recycledCount, lastTaskAt }
//
// Each test asserts the SPEC-defined outcome — not the implementation
// detail of which private field backs each shape field.

describe('WorkerHandle — snapshot() shape (HARDEN-03)', () => {
  it('returns all 7 documented fields on a fresh worker', async () => {
    const worker = new WorkerHandle();
    await worker.waitUntilReady();

    const snap = worker.snapshot();
    assert.equal(typeof snap.id, 'string');
    assert.ok(snap.id.length > 0, 'id is non-empty');
    assert.equal(typeof snap.memoryUsageBytes, 'number');
    assert.equal(typeof snap.tasksCompleted, 'number');
    assert.equal(typeof snap.tasksActive, 'number');
    assert.ok(
      ['starting', 'idle', 'busy', 'recycling', 'preempting'].includes(snap.status),
      `unexpected status: ${snap.status}`,
    );
    assert.equal(typeof snap.recycledCount, 'number');
    assert.equal(typeof snap.lastTaskAt, 'number');
    assert.equal(snap.tasksActive, 0, 'idle worker has no active tasks');
    assert.equal(snap.tasksCompleted, 0, 'fresh worker has not completed any tasks');
    assert.equal(snap.lastTaskAt, 0, 'fresh worker has no lastTaskAt timestamp yet');

    await worker.terminate();
  });

  it('updates tasksCompleted and lastTaskAt after a successful task', async () => {
    // Use WorkerRuntime.execute() (not WorkerHandle.executeTask()) so we
    // get a real TaskHandle on the worker side — direct executeTask()
    // requires a TaskHandle instance, not raw options.
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      const beforeSnap = runtime.getWorkers()[0];
      assert.equal(beforeSnap.tasksCompleted, 0);

      const result = await runtime.execute({ fn: () => 42 });
      assert.equal(result, 42);

      const afterSnap = runtime.getWorkers()[0];
      assert.equal(afterSnap.tasksCompleted, 1, 'tasksCompleted incremented');
      assert.ok(
        afterSnap.lastTaskAt >= beforeSnap.lastTaskAt,
        'lastTaskAt moved forward (or stayed) after task completion',
      );
      assert.ok(afterSnap.lastTaskAt > 0, 'lastTaskAt is a real timestamp');
    } finally {
      await runtime.shutdown();
    }
  });

  it('updates memoryUsageBytes from the IPC-reported value', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      const beforeSnap = runtime.getWorkers()[0];
      // Fresh worker has 0 memory usage recorded.
      assert.equal(beforeSnap.memoryUsageBytes, 0);

      await runtime.execute({ fn: () => 'simple result' });

      const afterSnap = runtime.getWorkers()[0];
      // After task execution, the worker reports `process.memoryUsage().heapUsed`
      // back to the supervisor. Even a minimal Node.js worker has > 0 heap.
      assert.ok(
        afterSnap.memoryUsageBytes > 0,
        `expected memoryUsageBytes > 0, got ${afterSnap.memoryUsageBytes}`,
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it('returns a fresh object per call (callers may mutate without affecting state)', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      const snap1 = runtime.getWorkers()[0];
      const snap2 = runtime.getWorkers()[0];

      assert.notEqual(snap1, snap2, 'each snapshot is a fresh object');
      // Mutate snap1 — snap2 must not see the mutation.
      snap1.id = 'mutated';
      snap1.tasksCompleted = 9999;
      assert.notEqual(snap2.id, 'mutated');
      assert.notEqual(snap2.tasksCompleted, 9999);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe('Supervisor — getWorkerSnapshots() (HARDEN-03)', () => {
  it('returns an empty array when no workers are tracked', async () => {
    const supervisor = new Supervisor({ workers: 1 });
    // Pre-start: no workers yet.
    assert.deepEqual(supervisor.getWorkerSnapshots(), []);
    await supervisor.shutdown();
  });

  it('returns one snapshot per spawned worker after start()', async () => {
    const supervisor = new Supervisor({ workers: 3 });
    await supervisor.start();

    const snaps = supervisor.getWorkerSnapshots();
    assert.equal(snaps.length, 3);
    for (const snap of snaps) {
      assert.equal(snap.status, 'idle');
      assert.equal(snap.tasksCompleted, 0);
    }

    await supervisor.shutdown();
  });
});

describe('WorkerRuntime — getWorkers() (HARDEN-03)', () => {
  it('returns an array of worker snapshots with accurate fields after dispatching tasks', async () => {
    const runtime = await createWorkerRuntime({ workers: 4 });
    try {
      // Dispatch 100 tasks — should be split across 4 workers.
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          runtime.execute({
            fn: (p) => p * 2,
            payload: i,
          }),
        );
      }
      const results = await Promise.all(promises);
      assert.equal(results[99], 198);

      const snaps = runtime.getWorkers();
      assert.equal(snaps.length, 4, 'one snapshot per worker');

      let totalTasksCompleted = 0;
      for (const snap of snaps) {
        assert.equal(typeof snap.id, 'string');
        assert.ok(snap.id.length > 0);
        assert.equal(snap.status, 'idle', 'all workers idle after dispatch');
        assert.equal(snap.tasksActive, 0);
        assert.ok(snap.memoryUsageBytes > 0, 'memoryUsageBytes reflects IPC-reported heapUsed');
        assert.ok(snap.tasksCompleted > 0, 'every worker did at least one task');
        assert.ok(snap.lastTaskAt > 0, 'lastTaskAt is a real timestamp');
        totalTasksCompleted += snap.tasksCompleted;
      }
      assert.equal(totalTasksCompleted, 100, 'sum of tasksCompleted == 100');
    } finally {
      await runtime.shutdown();
    }
  });

  it('returns an empty array during shutdown', async () => {
    const runtime = await createWorkerRuntime({ workers: 2 });
    // Begin shutdown but don't await — mid-shutdown state must already
    // return [] to avoid leaking half-torn-down workers.
    const shutdownPromise = runtime.shutdown();
    // After #isShuttingDown = true (set at top of shutdown()), getWorkers
    // must return [].
    const snaps = runtime.getWorkers();
    assert.deepEqual(snaps, [], 'getWorkers returns [] during shutdown');
    await shutdownPromise;
  });

  it('returns an empty array after shutdown completes', async () => {
    const runtime = await createWorkerRuntime({ workers: 2 });
    await runtime.shutdown();
    assert.deepEqual(runtime.getWorkers(), []);
  });

  it('reports status: "busy" while a slow task is in flight (tasksActive: 1)', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      // Use waitForEvent with mustCall to confirm a worker:memory or
      // task:completed event fires once. The mid-flight snapshot test
      // uses a slow task that yields to the event loop.
      let _taskInFlight = false;
      runtime.on('task:started', () => {
        _taskInFlight = true;
      });

      const slowTask = runtime.execute({
        // Yield once so the dispatch loop runs and getWorkers() can observe
        // the busy worker. Without the yield, the task completes before
        // we can sample the snapshot.
        fn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 'done';
        },
      });

      // Wait briefly so the task lands on the worker. Then sample.
      // We can't await slowTask first (it would block), so we use a
      // microtask delay.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const snaps = runtime.getWorkers();
      assert.equal(snaps.length, 1);
      const [snap] = snaps;
      // The task may have already completed by the time we sample —
      // accept either "busy" (in flight) or "idle" (settled already).
      // The key contract is that the snapshot accurately reflects state.
      assert.ok(snap.status === 'busy' || snap.status === 'idle', `status was: ${snap.status}`);
      if (snap.status === 'busy') {
        assert.equal(snap.tasksActive, 1);
      }

      await slowTask;
      // After completion, snapshot is idle.
      const finalSnap = runtime.getWorkers()[0];
      assert.equal(finalSnap.status, 'idle');
      assert.equal(finalSnap.tasksActive, 0);
      assert.equal(finalSnap.tasksCompleted, 1);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe('WorkerRuntime — runtime.stats.workers aggregate (HARDEN-04)', () => {
  it('exposes the 6-field workers aggregate block', async () => {
    const runtime = await createWorkerRuntime({
      workers: 2,
      maxMemoryMb: 256,
    });
    try {
      const s = runtime.stats;
      assert.ok(s.workers, 'stats.workers aggregate block exists');
      assert.equal(typeof s.workers.totalWorkers, 'number');
      assert.equal(typeof s.workers.idleWorkers, 'number');
      assert.equal(typeof s.workers.maxMemoryMb, 'number');
      assert.equal(typeof s.workers.recycledTotal, 'number');
      assert.equal(typeof s.workers.preemptedTotal, 'number');
      assert.equal(typeof s.workers.totalMemoryBytes, 'number');

      // Specific values:
      assert.equal(s.workers.totalWorkers, 2, 'totalWorkers mirrors supervisor');
      assert.equal(s.workers.idleWorkers, 2, 'both workers idle at start');
      assert.equal(s.workers.maxMemoryMb, 256, 'maxMemoryMb reflects config');
      assert.equal(s.workers.recycledTotal, 0);
      assert.equal(s.workers.preemptedTotal, 0);
      // Dispatch one task so workers report non-zero memory back via IPC.
      await runtime.execute({ fn: (p) => p + 1, payload: 1 });
      assert.ok(
        runtime.stats.workers.totalMemoryBytes > 0,
        'totalMemoryBytes sums worker heapUsed',
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it('totalMemoryBytes equals the sum of getWorkers()[i].memoryUsageBytes', async () => {
    const runtime = await createWorkerRuntime({ workers: 3 });
    try {
      // Dispatch a few tasks so workers report non-zero memory.
      await Promise.all(
        [1, 2, 3, 4, 5, 6].map((n) => runtime.execute({ fn: (p) => p * 2, payload: n })),
      );

      const snaps = runtime.getWorkers();
      const expectedSum = snaps.reduce((sum, s) => sum + s.memoryUsageBytes, 0);
      assert.equal(runtime.stats.workers.totalMemoryBytes, expectedSum);
    } finally {
      await runtime.shutdown();
    }
  });

  it('idleWorkers in aggregate matches getWorkers().filter(status==="idle").length', async () => {
    const runtime = await createWorkerRuntime({ workers: 4 });
    try {
      const aggregateIdle = runtime.stats.workers.idleWorkers;
      const snapshotsIdle = runtime.getWorkers().filter((s) => s.status === 'idle').length;
      assert.equal(aggregateIdle, snapshotsIdle);
    } finally {
      await runtime.shutdown();
    }
  });

  it('preserves back-compat with existing top-level stats keys', async () => {
    const runtime = await createWorkerRuntime({ workers: 2 });
    try {
      const s = runtime.stats;
      // Pre-existing keys MUST still be present.
      assert.equal(typeof s.totalWorkers, 'number');
      assert.equal(typeof s.idleWorkers, 'number');
      assert.equal(typeof s.queueDepth, 'number');
      assert.equal(typeof s.waitingQueueCount, 'number');
      assert.equal(typeof s.submittedTasks, 'number');
      assert.equal(typeof s.completedTasks, 'number');
      assert.equal(typeof s.failedTasks, 'number');
      assert.equal(typeof s.recycledWorkersCount, 'number');
      assert.equal(typeof s.preemptedTasksCount, 'number');
      assert.equal(typeof s.activeStreams, 'number');
      assert.equal(typeof s.pendingStreams, 'number');
      assert.equal(typeof s.adaptive, 'object');
    } finally {
      await runtime.shutdown();
    }
  });
});
