import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, describe, it } from 'node:test';
import { TaskQueueTimeoutError } from '../src/errors.js';
import { SqliteTaskQueue } from '../src/queue/sqlite-backend.js';
import { TaskHandle } from '../src/task-handle.js';

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pwr-sqlite-queue-'));
});

afterEach(() => {
  // Best-effort: tear down any leftover DB files. Tests that own a queue
  // are responsible for calling `destroy()` themselves; this is a safety
  // net for tests that aborted mid-flight.
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'pwr-sqlite-queue-'));
  } catch {
    // ignore
  }
});

function tmpDb(name) {
  return join(tmpDir, `${name}-${Math.random().toString(36).slice(2, 8)}.db`);
}

function makeHandle(opts = {}) {
  return new TaskHandle({
    type: opts.type || 'test',
    payload: opts.payload ?? null,
    affinityKey: opts.affinityKey ?? null,
    priority: opts.priority ?? 0,
    queueTimeoutMs: opts.queueTimeoutMs ?? 0,
    fnCode: opts.fnCode || 'async () => 1',
    retries: opts.retries ?? 0,
    metadata: opts.metadata ?? {},
    ...opts,
  });
}

describe('SqliteTaskQueue', () => {
  describe('Constructor & Defaults', () => {
    it('requires options.path', () => {
      assert.throws(() => new SqliteTaskQueue(), /requires options\.path/);
      assert.throws(() => new SqliteTaskQueue({}), /requires options\.path/);
      assert.throws(() => new SqliteTaskQueue({ path: '' }), /requires options\.path/);
    });

    it('accepts :memory: for tests', () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        assert.equal(q.size, 0);
        assert.equal(q.waitingCount, 0);
      } finally {
        q.destroy();
      }
    });

    it('uses safe defaults when only path is provided', () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        // Default maxQueueSize=2000, queueTimeoutMs=30000 (internal)
        // Not directly exposed but exercised by enqueue tests below.
        assert.equal(q.size, 0);
      } finally {
        q.destroy();
      }
    });

    it('accepts a filesystem path and creates the file', () => {
      const dbPath = tmpDb('ctor');
      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        // The file must exist after construction.
        const stat = statSync(dbPath);
        assert.ok(stat.size >= 0, 'DB file exists');
      } finally {
        q.destroy();
      }
    });
  });

  describe('Enqueue', () => {
    it('inserts immediately when queue has capacity', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle({ priority: 1 });
        await q.enqueue(t);
        assert.equal(q.size, 1);
        assert.equal(q.waitingCount, 0);
      } finally {
        q.destroy();
      }
    });

    it('returns immediately without writing for a settled task', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle();
        // Pre-settle the handle. Suppress the resulting unhandled rejection
        // because no consumer is supposed to await a pre-rejected task.
        t.promise.catch(() => {});
        t.reject(new Error('pre-settled'));
        await q.enqueue(t);
        assert.equal(q.size, 0, 'settled tasks must not be persisted');
      } finally {
        q.destroy();
      }
    });

    it('parks extra tasks in waiters when queue is full and times out', async () => {
      const q = new SqliteTaskQueue({
        path: ':memory:',
        maxQueueSize: 2,
        queueTimeoutMs: 25,
      });
      try {
        await q.enqueue(makeHandle());
        await q.enqueue(makeHandle());
        assert.equal(q.size, 2);
        assert.equal(q.waitingCount, 0);

        const third = makeHandle({ queueTimeoutMs: 25 });
        // Suppress the handle's internal promise rejection (the queue also
        // rejects the task on timeout — `assert.rejects` only observes the
        // queue's enqueue promise).
        third.promise.catch(() => {});
        const start = Date.now();
        await assert.rejects(q.enqueue(third), (err) => {
          assert.ok(err instanceof TaskQueueTimeoutError);
          assert.equal(err.taskId, third.id);
          assert.equal(err.waitedMs, 25);
          assert.equal(typeof err.queueDepth, 'number');
          return true;
        });
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 20, `expected ≥20ms wait, got ${elapsed}ms`);
        assert.equal(q.waitingCount, 0, 'timed-out waiter must be removed');
      } finally {
        q.destroy();
      }
    });

    it('drains waiters when capacity opens up', async () => {
      const q = new SqliteTaskQueue({
        path: ':memory:',
        maxQueueSize: 1,
        queueTimeoutMs: 200,
      });
      try {
        const a = makeHandle();
        await q.enqueue(a);
        const b = makeHandle();

        const bEnqueue = q.enqueue(b);
        // b is parked as a waiter
        assert.equal(q.waitingCount, 1);
        assert.equal(q.size, 1);

        // Free the slot by dequeueing a
        q.dequeue();
        await bEnqueue;

        assert.equal(q.size, 1, 'b should now be persisted');
        assert.equal(q.waitingCount, 0);
      } finally {
        q.destroy();
      }
    });

    it('persists tasks across destroy + restart (durability)', async () => {
      const dbPath = tmpDb('durability');

      const q1 = new SqliteTaskQueue({ path: dbPath });
      const a = makeHandle({ priority: 5, payload: { hello: 'world' } });
      await q1.enqueue(a);
      assert.equal(q1.size, 1);
      q1.destroy();

      // Restart: new queue, same path. Pending row survives.
      const q2 = new SqliteTaskQueue({ path: dbPath });
      try {
        assert.equal(q2.size, 1, 'pending row must survive restart');
        const peeked = q2.peek();
        assert.ok(peeked, 'peek must return a materialized TaskHandle');
        assert.equal(peeked.priority, 5);
        assert.deepEqual(peeked.payload, { hello: 'world' });
        assert.equal(peeked.id, a.id);
      } finally {
        q2.destroy();
      }
    });

    it('updates existing rows on duplicate enqueue (idempotent by task_id)', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle({ priority: 1, payload: { v: 1 } });
        await q.enqueue(t);

        // Mutate the same instance and re-enqueue: priority bump + new payload
        t.priority = 9;
        t.payload = { v: 2 };
        await q.enqueue(t);

        assert.equal(q.size, 1, 'INSERT OR REPLACE keeps row count stable');

        const peeked = q.peek();
        assert.equal(peeked.priority, 9);
        assert.deepEqual(peeked.payload, { v: 2 });
      } finally {
        q.destroy();
      }
    });
  });

  describe('Dequeue', () => {
    it('returns null on empty queue', () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        assert.equal(q.dequeue(), null);
        assert.equal(q.dequeue({ affinityKey: 'k' }), null);
      } finally {
        q.destroy();
      }
    });

    it('returns the highest-priority task first', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const low = makeHandle({ priority: 0 });
        const high = makeHandle({ priority: 10 });
        const mid = makeHandle({ priority: 5 });
        await q.enqueue(low);
        await q.enqueue(high);
        await q.enqueue(mid);

        assert.equal(q.dequeue().id, high.id);
        assert.equal(q.dequeue().id, mid.id);
        assert.equal(q.dequeue().id, low.id);
        assert.equal(q.dequeue(), null);
      } finally {
        q.destroy();
      }
    });

    it('respects worker affinity over priority', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const highUnpinned = makeHandle({ priority: 100 });
        const lowPinned = makeHandle({
          priority: 1,
          affinityKey: 'gpu-1',
        });
        await q.enqueue(highUnpinned);
        await q.enqueue(lowPinned);

        // Worker with matching affinityKey gets the pinned task
        // even though priority is lower.
        const gpuWorker = { affinityKey: 'gpu-1', isDedicated: true };
        assert.equal(q.dequeue(gpuWorker).id, lowPinned.id);

        // Unpinned worker gets the unpinned task.
        assert.equal(q.dequeue({ isDedicated: false }).id, highUnpinned.id);
      } finally {
        q.destroy();
      }
    });

    it('materializes a TaskHandle from envelope on dequeue (post-crash path)', async () => {
      const dbPath = tmpDb('materialize');

      const q1 = new SqliteTaskQueue({ path: dbPath });
      const original = makeHandle({
        priority: 7,
        payload: { x: 42 },
        metadata: { traceId: 'abc' },
      });
      await q1.enqueue(original);
      q1.destroy();

      // Drop the in-memory reference. The task no longer has a live caller.
      // Restart and dequeue — the new process has NO `#tasks` map entry for
      // this task, so it must materialize from SQLite.
      const q2 = new SqliteTaskQueue({ path: dbPath });
      try {
        const dequeued = q2.dequeue();
        assert.ok(dequeued, 'dequeue must materialize from envelope');
        assert.notStrictEqual(dequeued, original, 'new instance, not the old one');
        assert.equal(dequeued.priority, 7);
        assert.deepEqual(dequeued.payload, { x: 42 });
        assert.equal(dequeued.metadata.traceId, 'abc');
      } finally {
        q2.destroy();
      }
    });

    it('marks claimed rows as processing in SQLite', async () => {
      const dbPath = tmpDb('claim-state');

      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        await q.enqueue(makeHandle({ id: 't1' }));
        const claimed = q.dequeue();
        assert.ok(claimed);

        // After dequeue, the row state is 'processing' — peek returns null
        // (size counts pending only) and the next dequeue is null.
        assert.equal(q.size, 0);
        assert.equal(q.peek(), null);
        assert.equal(q.dequeue(), null);
      } finally {
        q.destroy();
      }
    });
  });

  describe('size / peek', () => {
    it('size reflects pending rows only', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const a = makeHandle();
        await q.enqueue(a);
        assert.equal(q.size, 1);

        q.dequeue(); // → processing
        assert.equal(q.size, 0, 'processing rows must not count toward size');

        q.markFailed(a.id);
        // Failed rows still don't count toward pending size
        assert.equal(q.size, 0);
      } finally {
        q.destroy();
      }
    });

    it('peek returns null on empty queue', () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        assert.equal(q.peek(), null);
      } finally {
        q.destroy();
      }
    });
  });

  describe('markDone / markFailed / vacuum', () => {
    it('markDone deletes the row', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle();
        await q.enqueue(t);
        q.markDone(t.id);
        assert.equal(q.size, 0);
      } finally {
        q.destroy();
      }
    });

    it('markFailed keeps the row but transitions state', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle();
        await q.enqueue(t);
        q.markFailed(t.id, new Error('boom'));
        assert.equal(q.size, 0, 'failed rows do not count as pending');
      } finally {
        q.destroy();
      }
    });

    it('vacuumCompleted removes old terminal rows', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle();
        await q.enqueue(t);
        q.dequeue(); // claim → processing
        q.markFailed(t.id);

        // Use a tiny negative window so any timestamp is "old enough".
        // (markFailed just set updated_at = Date.now(); with cutoff =
        // Date.now() - (-1) = Date.now() + 1, the row qualifies.)
        assert.equal(q.vacuumCompleted(-1), 1, 'rows with updated_at <= cutoff are removed');
        assert.equal(q.vacuumCompleted(-1), 0, 'second call is a no-op');
      } finally {
        q.destroy();
      }
    });
  });

  describe('destroy', () => {
    it('rejects pending waiters', async () => {
      const q = new SqliteTaskQueue({
        path: ':memory:',
        maxQueueSize: 1,
        queueTimeoutMs: 5000,
      });
      try {
        const a = makeHandle();
        await q.enqueue(a);
        const b = makeHandle();
        // The queue will reject b when destroy runs.
        b.promise.catch(() => {});
        const bPromise = q.enqueue(b);
        assert.equal(q.waitingCount, 1);

        const reason = new Error('queue closed');
        q.destroy(reason);

        await assert.rejects(bPromise, (err) => {
          assert.strictEqual(err, reason);
          return true;
        });
      } finally {
        // destroy already called; close is idempotent because of #closed guard
      }
    });

    it('leaves pending rows intact so a fresh instance recovers them (rolling deploy)', async () => {
      const dbPath = tmpDb('destroy-survives');

      const q1 = new SqliteTaskQueue({ path: dbPath });
      const a = makeHandle({ priority: 5, payload: { keep: true } });
      await q1.enqueue(a);
      q1.destroy();

      const q2 = new SqliteTaskQueue({ path: dbPath });
      try {
        // The pending row survived destroy — a new instance picks it up.
        assert.equal(q2.size, 1);
        const recovered = q2.peek();
        assert.ok(recovered);
        assert.equal(recovered.id, a.id);
        assert.deepEqual(recovered.payload, { keep: true });
      } finally {
        q2.destroy();
      }
    });

    it('purgePending() explicitly drops pending work', async () => {
      const dbPath = tmpDb('purge');

      const q1 = new SqliteTaskQueue({ path: dbPath });
      await q1.enqueue(makeHandle({ id: 't1' }));
      await q1.enqueue(makeHandle({ id: 't2' }));
      assert.equal(q1.size, 2);
      const purged = q1.purgePending();
      assert.equal(purged, 2);
      q1.destroy();

      const q2 = new SqliteTaskQueue({ path: dbPath });
      try {
        assert.equal(q2.size, 0, 'purged rows must not be recovered');
      } finally {
        q2.destroy();
      }
    });

    it('is idempotent on repeated calls', () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      q.destroy();
      // Second call must not throw
      q.destroy();
    });
  });
});
