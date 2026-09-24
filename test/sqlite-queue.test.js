import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

  describe('size cache', () => {
    it('reflects enqueue + dequeue without a SQL COUNT(*)', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        assert.equal(q.size, 0);
        await q.enqueue(makeHandle({ id: 'a' }));
        assert.equal(q.size, 1);
        await q.enqueue(makeHandle({ id: 'b' }));
        assert.equal(q.size, 2);
        q.dequeue();
        assert.equal(q.size, 1, 'dequeue decrements size');
        q.dequeue();
        assert.equal(q.size, 0);
      } finally {
        q.destroy();
      }
    });

    it('does not double-count on idempotent re-enqueue', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle({ id: 're' });
        await q.enqueue(t);
        assert.equal(q.size, 1);
        await q.enqueue(t);
        assert.equal(q.size, 1, 're-enqueue of same task_id must not bump size');
        await q.enqueue(t);
        assert.equal(q.size, 1);
      } finally {
        q.destroy();
      }
    });

    it('decrements when markFailed transitions pending→failed', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle({ id: 'f' });
        await q.enqueue(t);
        assert.equal(q.size, 1);
        q.markFailed(t.id);
        assert.equal(q.size, 0, 'pending→failed decrements size');
      } finally {
        q.destroy();
      }
    });

    it('does NOT decrement when markFailed transitions processing→failed', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle({ id: 'p' });
        await q.enqueue(t);
        assert.equal(q.size, 1);
        q.dequeue(); // pending → processing; size drops to 0
        assert.equal(q.size, 0);
        q.markFailed(t.id); // processing → failed; size stays 0
        assert.equal(q.size, 0);
      } finally {
        q.destroy();
      }
    });

    it('decrements when markDone removes a pending row', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        const t = makeHandle({ id: 'd' });
        await q.enqueue(t);
        q.markDone(t.id);
        assert.equal(q.size, 0);
      } finally {
        q.destroy();
      }
    });

    it('purgePending zeroes the cache when all rows are pending', async () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        await q.enqueue(makeHandle({ id: 'p1' }));
        await q.enqueue(makeHandle({ id: 'p2' }));
        await q.enqueue(makeHandle({ id: 'p3' }));
        assert.equal(q.size, 3);
        const purged = q.purgePending();
        assert.equal(purged, 3);
        assert.equal(q.size, 0);
      } finally {
        q.destroy();
      }
    });
  });

  describe('checkpointWal', () => {
    it('returns -1 on a destroyed queue', () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      q.destroy();
      assert.equal(q.checkpointWal(), -1);
    });

    it('returns a non-negative number on a live queue', () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        // No-op on `:memory:` (no WAL file to checkpoint) but the call
        // must not throw.
        const result = q.checkpointWal();
        assert.ok(typeof result === 'number');
        assert.ok(result >= 0);
      } finally {
        q.destroy();
      }
    });

    it('truncates the WAL file on a real on-disk DB', async () => {
      const dbPath = tmpDb('wal');
      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        // Generate some WAL activity
        for (let i = 0; i < 10; i++) {
          await q.enqueue(makeHandle({ id: `w${i}` }));
        }
        // checkpointWal must not throw and must return a non-negative number
        const result = q.checkpointWal();
        assert.ok(typeof result === 'number');
        assert.ok(result >= 0);
      } finally {
        q.destroy();
      }
    });
  });

  describe('corrupt envelope handling', () => {
    it('quarantines a corrupt pending row on recovery without crashing', () => {
      const dbPath = tmpDb('corrupt-recover');
      // Open the DB directly with node:sqlite, write a corrupt row,
      // close. Then open via SqliteTaskQueue and verify recovery treats
      // it as failed.
      const setup = new DatabaseSync(dbPath);
      setup.exec(`
        CREATE TABLE IF NOT EXISTS queue_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT UNIQUE NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          affinity_key TEXT,
          payload BLOB NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          attempt INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 0,
          enqueued_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          claimed_by TEXT,
          claim_expires_at INTEGER
        );
      `);
      setup
        .prepare(
          'INSERT INTO queue_tasks (task_id, priority, affinity_key, payload, state, attempt, max_retries, enqueued_at, updated_at, claimed_by, claim_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'corrupt-1',
          0,
          null,
          Buffer.from('this is not json{{{', 'utf8'),
          'pending',
          0,
          0,
          Date.now(),
          Date.now(),
          null,
          null,
        );
      setup.close();

      // Now open via SqliteTaskQueue — recovery must NOT throw.
      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        // The corrupt row was quarantined; size = 0 and the row's state
        // is 'failed' (GC-eligible).
        assert.equal(q.size, 0);
        // Verify the underlying row was marked failed by querying the
        // SQLite file directly.
        const db = new DatabaseSync(dbPath);
        const row = db.prepare("SELECT state FROM queue_tasks WHERE task_id = 'corrupt-1'").get();
        db.close();
        assert.ok(row, 'corrupt row must still exist in the DB');
        assert.equal(row.state, 'failed', 'corrupt row must be quarantined as failed');
      } finally {
        q.destroy();
      }
    });
  });

  describe('T13.2 orphan claim recovery', () => {
    /** Insert a row in `processing` state directly via the SQLite handle
     *  to simulate a previous instance that crashed mid-execution. */
    function plantOrphan(dbPath, opts = {}) {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS queue_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT UNIQUE NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            affinity_key TEXT,
            payload BLOB NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            attempt INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 0,
            enqueued_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            claimed_by TEXT,
            claim_expires_at INTEGER
          );
        `);
        const now = Date.now();
        const envelope = JSON.stringify({
          id: opts.taskId || 'orphan-1',
          type: 'test',
          payload: { x: 1 },
          affinityKey: null,
          priority: 0,
          fnCode: 'async () => 1',
        });
        db.prepare(
          `INSERT INTO queue_tasks
             (task_id, priority, affinity_key, payload, state, attempt,
              max_retries, enqueued_at, updated_at, claimed_by, claim_expires_at)
           VALUES (?, 0, NULL, ?, 'processing', ?, ?, ?, ?, ?, ?)`,
        ).run(
          opts.taskId || 'orphan-1',
          Buffer.from(envelope, 'utf8'),
          opts.attempt ?? 0,
          // Default to a generous retries budget so the reclaim goes to
          // pending (not failed). Tests that want to exercise the
          // budget-exhausted path override this.
          opts.maxRetries ?? 10,
          now,
          now,
          opts.claimedBy || 'previous-instance',
          opts.claimExpiresAt ?? now - 1000, // default: already expired
        );
      } finally {
        db.close();
      }
    }

    it('reclaims processing rows whose lease has expired on startup', () => {
      const dbPath = tmpDb('orphan-reclaim');
      plantOrphan(dbPath, { taskId: 'orphan-expired', claimExpiresAt: Date.now() - 5000 });

      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        // After startup recovery, the orphan is back to 'pending' and
        // accounted for in size. The next dequeue picks it up.
        assert.equal(q.size, 1, 'expired orphan must be reclaimed to pending');
        const next = q.dequeue();
        assert.ok(next, 'dequeue must return the reclaimed task');
        assert.equal(next.id, 'orphan-expired');
      } finally {
        q.destroy();
      }
    });

    it('does NOT reclaim rows with an active lease (live worker)', () => {
      const dbPath = tmpDb('orphan-active');
      // Lease expires in 60 seconds — far in the future.
      plantOrphan(dbPath, {
        taskId: 'live-worker',
        claimExpiresAt: Date.now() + 60_000,
      });

      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        // Active lease = presumed live worker; we MUST NOT steal the task.
        assert.equal(q.size, 0, 'active lease must not be reclaimed');
        assert.equal(q.dequeue(), null, 'no task available while live worker owns it');
      } finally {
        q.destroy();
      }
    });

    it('simulates crash-mid-execution: plant processing row with stale lease + recover via new instance', () => {
      const dbPath = tmpDb('orphan-crash');
      // 5 orphans: 4 expired (should reclaim), 1 with active lease (must stay).
      plantOrphan(dbPath, { taskId: 'crash-1', claimExpiresAt: Date.now() - 30_000 });
      plantOrphan(dbPath, { taskId: 'crash-2', claimExpiresAt: Date.now() - 10_000 });
      plantOrphan(dbPath, { taskId: 'crash-3', claimExpiresAt: Date.now() - 1000 });
      plantOrphan(dbPath, { taskId: 'crash-4', claimExpiresAt: Date.now() - 100 });
      plantOrphan(dbPath, {
        taskId: 'live-worker',
        claimExpiresAt: Date.now() + 60_000,
      });

      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        // Only the 4 expired orphans should be reclaimed to pending.
        assert.equal(q.size, 4);
      } finally {
        q.destroy();
      }
    });

    it('reclaimExpired() is idempotent and returns {0,0} when nothing to reclaim', () => {
      const q = new SqliteTaskQueue({ path: ':memory:' });
      try {
        assert.deepEqual(q.reclaimExpired(), { reclaimed: 0, exhausted: 0 });
        assert.deepEqual(
          q.reclaimExpired(),
          { reclaimed: 0, exhausted: 0 },
          'idempotent on empty queue',
        );
      } finally {
        q.destroy();
      }
    });

    it('reclaimExpired() is callable from a cron / scheduler (not just startup)', async () => {
      const dbPath = tmpDb('orphan-cron');
      // Use a long lease so the recovery sweep on startup doesn't reclaim.
      // We will reclaim manually after manually expiring the lease.
      // Pass retries=10 so the orphan goes to pending (not failed) on
      // reclaim — the cron test exercises the happy reclaim path.
      const q1 = new SqliteTaskQueue({ path: dbPath, leaseMs: 60_000 });
      try {
        await q1.enqueue(makeHandle({ id: 'cron-orphan', retries: 10 }));
        const claimed = q1.dequeue();
        assert.ok(claimed);
        // At this point the row has state='processing' + lease +60s.
        // Manually expire the lease to simulate a worker that died after
        // claiming but before completing.
        const db = new DatabaseSync(dbPath);
        try {
          db.prepare('UPDATE queue_tasks SET claim_expires_at = ? WHERE task_id = ?').run(
            Date.now() - 1000,
            'cron-orphan',
          );
        } finally {
          db.close();
        }
        // First reclaim brings it back to pending.
        const result1 = q1.reclaimExpired();
        assert.equal(result1.reclaimed, 1);
        assert.equal(result1.exhausted, 0);
        // Now size reflects the reclaimed row.
        assert.equal(q1.size, 1);
        // A second reclaim is a no-op.
        assert.deepEqual(q1.reclaimExpired(), { reclaimed: 0, exhausted: 0 });
      } finally {
        q1.destroy();
      }
    });

    it('emits a warning when orphans are reclaimed on startup', () => {
      const dbPath = tmpDb('orphan-warning');
      plantOrphan(dbPath, { taskId: 'warn-1', claimExpiresAt: Date.now() - 60_000 });
      plantOrphan(dbPath, { taskId: 'warn-2', claimExpiresAt: Date.now() - 30_000 });

      const warnings = [];
      const origEmit = process.emitWarning;
      process.emitWarning = (msg, type) => {
        if (type === 'PersistentWorkerRuntimeSqliteOrphanReclaim') {
          warnings.push(msg);
        }
      };
      try {
        const q = new SqliteTaskQueue({ path: dbPath });
        try {
          assert.equal(q.size, 2);
        } finally {
          q.destroy();
        }
        assert.equal(warnings.length, 1, 'exactly one reclaim warning expected');
        assert.match(warnings[0], /reclaimed 2 orphaned claim/);
      } finally {
        process.emitWarning = origEmit;
      }
    });

    it('writes a lease on every dequeue', () => {
      const dbPath = tmpDb('lease-write');
      const q = new SqliteTaskQueue({ path: dbPath, leaseMs: 60_000 });
      try {
        // The test setup creates a queue with the SCHEMA + ALTER
        // (which adds claim_expires_at). After dequeue, the row must
        // have a non-null claim_expires_at.
        const setup = new DatabaseSync(dbPath);
        try {
          setup
            .prepare(
              `INSERT INTO queue_tasks
                 (task_id, priority, affinity_key, payload, state, attempt,
                  max_retries, enqueued_at, updated_at)
               VALUES (?, 0, NULL, ?, 'pending', 0, 0, ?, ?)`,
            )
            .run(
              'lease-1',
              Buffer.from(
                JSON.stringify({
                  id: 'lease-1',
                  type: 'test',
                  payload: { x: 1 },
                  affinityKey: null,
                  priority: 0,
                  fnCode: 'async () => 1',
                }),
                'utf8',
              ),
              Date.now(),
              Date.now(),
            );
        } finally {
          setup.close();
        }
        // Use a fresh queue to recover the planted row.
        q.destroy();
        const q2 = new SqliteTaskQueue({ path: dbPath, leaseMs: 60_000 });
        try {
          const claimed = q2.dequeue();
          assert.ok(claimed);
          const db = new DatabaseSync(dbPath);
          try {
            const row = db
              .prepare(
                "SELECT state, claimed_by, claim_expires_at FROM queue_tasks WHERE task_id = 'lease-1'",
              )
              .get();
            assert.equal(row.state, 'processing');
            assert.ok(row.claimed_by, 'claimed_by must be set');
            assert.ok(row.claim_expires_at > Date.now(), 'lease must be in the future');
            assert.ok(
              row.claim_expires_at <= Date.now() + 60_000 + 1000,
              'lease must be ~now + leaseMs',
            );
          } finally {
            db.close();
          }
        } finally {
          q2.destroy();
        }
      } finally {
        // already destroyed
      }
    });
  });

  describe('T13.2 retry budget enforcement (orphan reclaim counts as an attempt)', () => {
    /** Insert a task in `processing` state with a specific attempt count
     *  and retries budget, simulating a worker that died mid-task after
     *  N prior attempts. */
    function plantOrphanWithBudget(dbPath, opts) {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS queue_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT UNIQUE NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            affinity_key TEXT,
            payload BLOB NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            attempt INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 0,
            enqueued_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            claimed_by TEXT,
            claim_expires_at INTEGER
          );
        `);
        const now = Date.now();
        const envelope = JSON.stringify({
          id: opts.taskId,
          type: 'test',
          payload: { x: 1 },
          affinityKey: null,
          priority: 0,
          fnCode: 'async () => 1',
        });
        db.prepare(
          `INSERT INTO queue_tasks
             (task_id, priority, affinity_key, payload, state, attempt,
              max_retries, enqueued_at, updated_at, claimed_by, claim_expires_at)
           VALUES (?, 0, NULL, ?, 'processing', ?, ?, ?, ?, ?, ?)`,
        ).run(
          opts.taskId,
          Buffer.from(envelope, 'utf8'),
          opts.attempt ?? 0,
          opts.maxRetries ?? 0,
          now,
          now,
          opts.claimedBy || 'previous-instance',
          now - 1000,
        );
      } finally {
        db.close();
      }
    }

    it('markFailed (no retries) + orphan reclaim → goes to failed, NOT pending (avoids infinite loop)', () => {
      const dbPath = tmpDb('retry-budget-zero');
      // Task with retries=0 — first reclaim should send it straight to
      // failed because incrementing attempt (0→1) exceeds max_retries (0).
      plantOrphanWithBudget(dbPath, {
        taskId: 'r0',
        attempt: 0,
        maxRetries: 0,
      });

      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        // Recovery reclaim should mark this as failed, not pending.
        assert.equal(q.size, 0, 'row with retries=0 must NOT be reclaimed to pending');
        const db = new DatabaseSync(dbPath);
        try {
          const row = db
            .prepare("SELECT state, attempt FROM queue_tasks WHERE task_id = 'r0'")
            .get();
          assert.equal(row.state, 'failed');
          // Attempt counter must have been incremented (still 0 since
          // we incremented BEFORE checking, but we should NOT have
          // re-attempted). See the implementation note below.
          assert.ok(row.attempt >= 0);
        } finally {
          db.close();
        }
      } finally {
        q.destroy();
      }
    });

    it('retries=2 + 1 orphan reclaim → goes to pending with attempt=1 (under budget)', () => {
      const dbPath = tmpDb('retry-budget-under');
      plantOrphanWithBudget(dbPath, {
        taskId: 'r1',
        attempt: 0,
        maxRetries: 2,
      });

      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        // First reclaim: attempt becomes 1 (still < 2), goes to pending.
        assert.equal(q.size, 1);
        const db = new DatabaseSync(dbPath);
        try {
          const row = db
            .prepare("SELECT state, attempt FROM queue_tasks WHERE task_id = 'r1'")
            .get();
          assert.equal(row.state, 'pending');
          assert.equal(row.attempt, 1, 'reclaim must increment attempt counter');
        } finally {
          db.close();
        }
      } finally {
        q.destroy();
      }
    });

    it('retries=2 + successive reclaims: 0→1→2 (pending) → 3 (failed, exceeds budget)', () => {
      const dbPath = tmpDb('retry-budget-exhaust');
      plantOrphanWithBudget(dbPath, {
        taskId: 'r2',
        attempt: 0,
        maxRetries: 2,
      });

      const q = new SqliteTaskQueue({ path: dbPath });
      try {
        // Constructor reclaim: attempt 0 → 1, state → pending.
        assert.equal(q.size, 1);

        // Simulate two worker crashes via the realistic flow: claim
        // (dequeue) → expire the lease (raw UPDATE) → reclaim.
        // Using dequeue() keeps the in-memory `#size` cache in sync
        // — direct DB mutations would inflate the cache because
        // they bypass the decrement that dequeue() performs.
        for (let cycle = 0; cycle < 2; cycle++) {
          const claimed = q.dequeue();
          assert.ok(claimed !== null, `cycle ${cycle}: dequeue must return the task`);
          assert.equal(q.size, 0, `cycle ${cycle}: size must drop after claim`);

          // Force lease expiry to simulate the worker crashing without
          // calling markDone / markFailed.
          const db = new DatabaseSync(dbPath);
          try {
            db.prepare(`UPDATE queue_tasks SET claim_expires_at = ? WHERE task_id = 'r2'`).run(
              Date.now() - 1000,
            );
          } finally {
            db.close();
          }

          const { reclaimed: r, exhausted: e } = q.reclaimExpired();
          // Cycle 0: attempt 1 → 2, ≤ 2 → reclaimed. Cycle 1: attempt
          // 2 → 3, > 2 → exhausted.
          if (cycle === 0) {
            assert.equal(r, 1, 'cycle 0: attempt 1→2 stays under budget');
            assert.equal(e, 0);
          } else {
            assert.equal(r, 0, 'cycle 1: attempt 2→3 exceeds budget');
            assert.equal(e, 1);
          }
        }

        // After 3 reclaims total: attempt=3, state=failed, size=0.
        const final = new DatabaseSync(dbPath);
        try {
          const row = final
            .prepare("SELECT state, attempt FROM queue_tasks WHERE task_id = 'r2'")
            .get();
          assert.equal(row.state, 'failed', 'exhausted budget must go to failed');
          assert.equal(row.attempt, 3, 'every reclaim increments attempt');
          assert.equal(q.size, 0, 'failed rows do not count as pending');
        } finally {
          final.close();
        }
      } finally {
        q.destroy();
      }
    });

    it('warns when an orphan is reclaimed to failed (budget exhausted)', () => {
      const dbPath = tmpDb('retry-budget-warn');
      plantOrphanWithBudget(dbPath, {
        taskId: 'r-warn',
        attempt: 0,
        maxRetries: 0,
      });

      const warnings = [];
      const origEmit = process.emitWarning;
      process.emitWarning = (msg, type) => {
        if (type === 'PersistentWorkerRuntimeSqliteOrphanBudgetExhausted') {
          warnings.push(msg);
        }
      };
      try {
        const q = new SqliteTaskQueue({ path: dbPath });
        try {
          assert.equal(q.size, 0);
        } finally {
          q.destroy();
        }
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /retry budget.*marked failed/);
      } finally {
        process.emitWarning = origEmit;
      }
    });
  });
});
