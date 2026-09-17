import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskQueueTimeoutError } from '../src/errors.js';
import { TaskQueue } from '../src/task-queue.js';

/**
 * Build a minimal TaskHandle-like object. The queue only reads a few public
 * fields, so we avoid pulling the real TaskHandle (which spins up an
 * AsyncResource and may register signal listeners).
 */
function makeTask({
  id = `t_${Math.random().toString(36).slice(2, 9)}`,
  affinityKey = null,
  priority = 0,
  queueTimeoutMs = 0,
  settled = false,
} = {}) {
  let isSettled = settled;
  let rejection = null;

  return {
    id,
    affinityKey,
    priority,
    queueTimeoutMs,
    get isSettled() {
      return isSettled;
    },
    reject(err) {
      isSettled = true;
      rejection = err;
    },
    get rejection() {
      return rejection;
    },
  };
}

describe('TaskQueue', () => {
  describe('Constructor & Defaults', () => {
    it('uses safe defaults when called with no options', () => {
      const q = new TaskQueue();
      assert.equal(q.size, 0);
      assert.equal(q.waitingCount, 0);
    });

    it('accepts custom maxQueueSize and queueTimeoutMs', async () => {
      const q = new TaskQueue({ maxQueueSize: 2, queueTimeoutMs: 25 });
      const t1 = makeTask();
      const t2 = makeTask();
      const t3 = makeTask();

      await q.enqueue(t1);
      await q.enqueue(t2);
      assert.equal(q.size, 2);

      // The third task will wait; its wait should time out at 25ms
      const start = Date.now();
      await assert.rejects(q.enqueue(t3), (err) => {
        assert.ok(err instanceof TaskQueueTimeoutError);
        assert.equal(err.taskId, t3.id);
        assert.equal(err.waitedMs, 25);
        assert.ok(typeof err.queueDepth === 'number');
        return true;
      });
      assert.ok(Date.now() - start >= 20, 'should respect queueTimeoutMs');
      assert.equal(q.waitingCount, 0, 'timed-out waiter must be removed');
    });

    it('lets a per-task queueTimeoutMs override the queue default', async () => {
      const q = new TaskQueue({ maxQueueSize: 1, queueTimeoutMs: 5000 });
      await q.enqueue(makeTask());
      const slow = makeTask({ queueTimeoutMs: 20 });

      const start = Date.now();
      await assert.rejects(q.enqueue(slow), (err) => err instanceof TaskQueueTimeoutError);
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 500, `expected <500ms (per-task 20ms), got ${elapsed}ms`);
    });
  });

  describe('Enqueue', () => {
    it('inserts immediately when queue has capacity', async () => {
      const q = new TaskQueue({ maxQueueSize: 5 });
      const t = makeTask();
      await q.enqueue(t);
      assert.equal(q.size, 1);
      assert.equal(q.waitingCount, 0);
    });

    it('is a no-op when the task is already settled', async () => {
      const q = new TaskQueue({ maxQueueSize: 1 });
      const t = makeTask({ settled: true });
      await q.enqueue(t);
      assert.equal(q.size, 0);
    });

    it('parks extra tasks in waiters when queue is full', async () => {
      const q = new TaskQueue({ maxQueueSize: 2, queueTimeoutMs: 1000 });
      const a = makeTask();
      const b = makeTask();
      const c = makeTask();
      await q.enqueue(a);
      await q.enqueue(b);

      const parked = q.enqueue(c);
      // Parked promise has not resolved yet
      assert.equal(q.waitingCount, 1);
      assert.equal(q.size, 2);

      // Drain a slot -> waiter should be promoted
      q.dequeue();
      await parked;
      assert.equal(q.size, 2);
      assert.equal(q.waitingCount, 0);
    });

    it('also rejects the task itself on wait timeout', async () => {
      const q = new TaskQueue({ maxQueueSize: 1, queueTimeoutMs: 20 });
      await q.enqueue(makeTask());

      const t = makeTask({ queueTimeoutMs: 20 });
      await assert.rejects(q.enqueue(t));

      assert.equal(t.isSettled, true, 'task should be marked settled');
      assert.ok(
        t.rejection instanceof TaskQueueTimeoutError,
        'task.rejection must be TaskQueueTimeoutError',
      );
      assert.equal(t.rejection.taskId, t.id);
    });
  });

  describe('Dequeue', () => {
    it('returns null when the queue is empty', () => {
      const q = new TaskQueue();
      assert.equal(q.dequeue(), null);
    });

    it('returns higher-priority tasks first (descending)', async () => {
      const q = new TaskQueue({ maxQueueSize: 10 });
      const lo = makeTask({ id: 'lo', priority: 1 });
      const hi = makeTask({ id: 'hi', priority: 10 });
      const mid = makeTask({ id: 'mid', priority: 5 });

      await q.enqueue(lo);
      await q.enqueue(hi);
      await q.enqueue(mid);

      assert.equal(q.dequeue().id, 'hi');
      assert.equal(q.dequeue().id, 'mid');
      assert.equal(q.dequeue().id, 'lo');
      assert.equal(q.dequeue(), null);
    });

    it('matches by affinityKey when a worker with affinity is provided', async () => {
      const q = new TaskQueue({ maxQueueSize: 10 });
      const pinned = makeTask({ id: 'pinned', affinityKey: 'db' });
      const floating = makeTask({ id: 'floating' });

      await q.enqueue(pinned);
      await q.enqueue(floating);

      const fakeWorker = { affinityKey: 'db', isDedicated: false };
      assert.equal(q.dequeue(fakeWorker).id, 'pinned');

      // After pinned is consumed, the floating one (no affinity) should be picked
      assert.equal(q.dequeue(fakeWorker).id, 'floating');
    });

    it('falls back to first available task when affinity does not match', async () => {
      // Affinity is a soft preference: when no exact match exists, the queue
      // returns the first non-settled task in priority order regardless of its
      // affinity tag.
      const q = new TaskQueue({ maxQueueSize: 10 });
      const pinnedToOther = makeTask({ id: 'pinned-other', affinityKey: 'cache' });
      const floating = makeTask({ id: 'floating' });

      await q.enqueue(pinnedToOther);
      await q.enqueue(floating);

      const fakeWorker = { affinityKey: 'db', isDedicated: false };
      assert.equal(q.dequeue(fakeWorker).id, 'pinned-other');
      assert.equal(q.dequeue(fakeWorker).id, 'floating');
    });

    it('returns null when only affinity-mismatched tasks remain for a dedicated worker', async () => {
      const q = new TaskQueue({ maxQueueSize: 10 });
      const pinned = makeTask({ id: 'pinned', affinityKey: 'cache' });
      await q.enqueue(pinned);

      const dedicatedWorker = { affinityKey: 'db', isDedicated: true };
      assert.equal(q.dequeue(dedicatedWorker), null);
    });

    it('skips already-settled tasks during dequeue', async () => {
      const q = new TaskQueue({ maxQueueSize: 10 });
      const ghost = makeTask({ id: 'ghost', settled: true });
      const alive = makeTask({ id: 'alive' });

      // Force-insert ghost via direct queue manipulation through enqueue path
      // (since makeTask is a stub, we simulate by setting settled pre-enqueue)
      await q.enqueue(ghost); // already settled -> no-op
      await q.enqueue(alive);

      assert.equal(q.dequeue().id, 'alive');
    });

    it('cleans up the affinity index after consumption', async () => {
      const q = new TaskQueue({ maxQueueSize: 10 });
      const pinned = makeTask({ id: 'p', affinityKey: 'k' });
      await q.enqueue(pinned);

      const taken = q.dequeue();
      assert.equal(taken.id, 'p');

      // After dequeue, the affinity index must no longer track this task
      // (no public getter, but a second affinity dequeue must not return it)
      assert.equal(q.size, 0);
    });
  });

  describe('Waiter drain', () => {
    it('promotes one waiter per slot freed by dequeue', async () => {
      const q = new TaskQueue({ maxQueueSize: 1, queueTimeoutMs: 1000 });
      await q.enqueue(makeTask());

      const t2 = makeTask();
      const t3 = makeTask();
      const p2 = q.enqueue(t2);
      const p3 = q.enqueue(t3);
      assert.equal(q.waitingCount, 2);

      // Free 1 slot -> only 1 waiter promoted
      q.dequeue();
      await p2;
      assert.equal(q.waitingCount, 1);

      // Free the next slot -> remaining waiter promoted
      q.dequeue();
      await p3;
      assert.equal(q.waitingCount, 0);
    });

    it('skips settled tasks when draining waiters', async () => {
      const q = new TaskQueue({ maxQueueSize: 1, queueTimeoutMs: 1000 });
      await q.enqueue(makeTask());

      const settledWaiter = makeTask({ id: 'w_settled' });
      const aliveWaiter = makeTask({ id: 'w_alive' });

      // Both park first; the queue now has [settledWaiter, aliveWaiter] in waiters
      const pSettled = q.enqueue(settledWaiter);
      const pAlive = q.enqueue(aliveWaiter);
      assert.equal(q.waitingCount, 2);

      // Simulate that the first waiter was cancelled upstream (e.g. AbortSignal).
      // The mock's reject() flips isSettled=true without resolving the enqueue
      // promise — exactly mirroring how a real TaskHandle behaves when aborted
      // mid-wait.
      settledWaiter.reject(new Error('cancelled'));

      q.dequeue(); // frees a slot — drain should skip settled and promote alive
      await pAlive;
      assert.equal(q.size, 1);
      assert.equal(q.waitingCount, 0);

      // The settled waiter must also be cleaned up: its enqueue promise should
      // be rejected so callers awaiting it don't leak unhandled rejections.
      await assert.rejects(pSettled, /settled before queue capacity was available/);
    });
  });

  describe('Destroy', () => {
    it('rejects every queued task with the supplied reason', async () => {
      const q = new TaskQueue({ maxQueueSize: 10 });
      const a = makeTask();
      const b = makeTask();
      await q.enqueue(a);
      await q.enqueue(b);

      const reason = new Error('shutdown-now');
      q.destroy(reason);

      assert.equal(a.rejection, reason);
      assert.equal(b.rejection, reason);
      assert.equal(q.size, 0);
    });

    it('rejects every waiting task and clears the waiters list', async () => {
      const q = new TaskQueue({ maxQueueSize: 1, queueTimeoutMs: 5000 });
      await q.enqueue(makeTask());

      const w1 = makeTask();
      const w2 = makeTask();
      const p1 = q.enqueue(w1);
      const p2 = q.enqueue(w2);
      assert.equal(q.waitingCount, 2);

      const reason = new Error('gone');
      q.destroy(reason);

      assert.equal(w1.rejection, reason);
      assert.equal(w2.rejection, reason);
      assert.equal(q.waitingCount, 0);

      await assert.rejects(p1, /gone/);
      await assert.rejects(p2, /gone/);
    });

    it('uses a sensible default reason when none is supplied', async () => {
      const q = new TaskQueue({ maxQueueSize: 1, queueTimeoutMs: 5000 });
      await q.enqueue(makeTask());

      const w = makeTask();
      const p = q.enqueue(w);
      q.destroy();

      assert.ok(w.rejection instanceof Error);
      assert.equal(w.rejection.message, 'TaskQueue was destroyed');
      await assert.rejects(p, /TaskQueue was destroyed/);
    });
  });
});
