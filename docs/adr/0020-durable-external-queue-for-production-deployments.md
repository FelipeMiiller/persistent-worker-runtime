# ADR-0020: Durable Queue (SQLite via `node:sqlite`)

- **Date**: 2026-09-18 (originally accepted as RDBMS-first)
- **Revised**: 2026-09-24 — **decision revised to SQLite-only** via `node:sqlite`. External backends (RDBMS / event-streaming tiers) explicitly removed as alternatives (the runtime ships the SQLite backend; users operating other queues continue to use the workaround documented in `docs/operations/disaster-recovery.md §5.2.1`).
- **Status**: Accepted (revised)
- **Deciders**: SRE + Platform team
- **Tags**: architecture, durability, queue, prod-readiness

## Context and Problem Statement

The default `TaskQueue` (see `src/task-queue.js`) keeps pending tasks **in memory**. A runtime crash, instance termination, or process OOM drops every task that has not yet been dispatched to a worker. With our retry policy (ADR-0007) operating only on dispatched-and-failed tasks, **un-dispatched tasks have no recovery path**.

The disaster recovery plan (`docs/operations/disaster-recovery.md` §5.2.1) calls this out explicitly: RPO for an S1 incident is 0 *only* when the queue is backed by durable storage. With the default in-memory queue, every S1 event drops some pending work — and we have no guarantee about how much.

Production deployments cannot accept "some work is silently lost on crash" as a baseline. We need a queue backend that survives the runtime process itself crashing.

## Decision Drivers

- **Durability**: pending tasks must survive runtime process crash (not just worker crash, which is already handled by retry).
- **Low operational overhead**: avoid introducing a new heavy dependency unless we already operate it elsewhere.
- **Multi-instance safety**: must work correctly when multiple runtime instances read from the same queue (no double-dispatch, no lost tasks).
- **Bounded latency**: tail-latency cost of moving from in-memory to durable must stay within current SLO (≤ 10ms queue→worker).
- **Backward compatibility**: the default `TaskQueue` keeps working for tests and small single-instance workloads.

## Considered Options

- **Option A — SQLite via `node:sqlite`** (stdlib, Node 22.13+) — **chosen**
- **Option B — Keep in-memory queue, reduce `maxQueueSize` and rely on caller-side retry** — workaround today, kept on the list as the v0.2.x floor.

External queue backends (RDBMS `SKIP LOCKED`, event-streaming tiers, etc.) were considered at the ADR's original drafting but are now **explicitly out of scope**. Teams operating those tiers continue to front the runtime with their existing queue per `docs/operations/disaster-recovery.md §5.2.1`; the runtime does not ship drivers for them.

## Decision Outcome (revised 2026-09-24)

Chosen option: **"Option A — SQLite via `node:sqlite`", the only durable queue backend shipped by the runtime.** The decision is "durable queue, zero-dep-first, SQLite only".

### Revision rationale (2026-09-24)

The original choice (2026-09-18) was an RDBMS-backed queue for ACID + `SKIP LOCKED` + battle-tested pattern. **SQLite was not in the considered options at the time** because Node's `node:sqlite` module was still flagged experimental. Three facts changed:

1. **`node:sqlite` is now stable** in Node ≥ 22.13 (Jan 2025) — accessible as `require('node:sqlite')` with no flag, no peer dependency.
2. **ADR-0005 forbids runtime dependencies.** Adding any database driver as a peer dep (the cleanest path for an RDBMS-backed queue) introduces an external dependency that the runtime must mention in its README and that complicates install. SQLite through `node:sqlite` keeps the runtime zero-dep.
3. **Tighter scope.** The runtime should not ship drivers for every queue tier the SRE/Platform team might operate. SQLite covers the ~99% of workloads where S1 RPO=0 matters; the long tail (RDBMS / event-streaming tiers) is delegated to the existing caller-side fronting pattern documented in `docs/operations/disaster-recovery.md §5.2.1`.

External RDBMS / event-streaming backends are **explicitly out of scope** for runtime-shipped backends. They are mentioned in the ADR's history for context only.

The factory will gain a new option:

```js
createWorkerRuntime({
  queueBackend: 'memory',     // default — current behavior, for tests
  // or (recommended for prod)
  queueBackend: 'sqlite',
  sqlite: { path: '/var/lib/pwr/queue.db' },
});
```

### Positive Consequences

- S1 incidents drop **zero** queued work (RPO=0 achievable without external orchestration — SQLite writes are committed on disk).
- Multi-instance deployments become safe: any instance can crash mid-dispatch without losing tasks. SQLite uses database-level write serialization (BEGIN IMMEDIATE) which serializes writers but lets readers scale; for the typical workload shape (≤ a few hundred dispatches/sec) this is a non-issue.
- **No peer dependency.** `node:sqlite` is stdlib, ADR-0005 preserved.
- Single-file deployment: the queue is a `.db` file, easy to back up (`sqlite3 .db .dump`), inspect with standard tools, and replicate (Litestream, rqlite, file sync).
- Sync API fits worker_threads semantics perfectly — no async overhead in the hot path.

### Negative Consequences

- Adds ~1-5ms to queue→worker latency (SQLite disk round-trip vs in-memory pointer swap).
- Couples runtime availability to disk I/O health — but the runtime is already coupled to disk (it's a Node process). No new failure mode.
- Schema migration burden: new table(s) for queue state, indexes for FIFO + priority + affinity, retention/vacuum for old completed rows.
- Single-writer concurrency: SQLite serializes writes via BEGIN IMMEDIATE. Adequate for typical workloads, but **NOT** a fit for very-high-throughput multi-instance dispatch. Teams with > ~1000 dispatches/sec should keep the caller-side fronting pattern (external queue tiers) and not enable this backend.
- Adds Node ≥ 22.13 requirement to the runtime's `engines` field.

## Pros and Cons of the Options

### Option A — SQLite via `node:sqlite` ✅ Chosen (only option shipped)

- ✅ **Zero peer dependency** — `node:sqlite` is in Node's stdlib (≥ 22.13). ADR-0005 preserved.
- ✅ **Fastest durability path** — single-file in-process SQLite + POSIX I/O; ~1-5ms added latency vs in-memory.
- ✅ RPO=0 with simple replication — Litestream, rqlite, or just `sqlite3 .db .backup` to S3.
- ✅ Sync API — fits worker_threads semantics; no async overhead in dispatch path.
- ✅ Backups trivially atomic — file-level copy is safe (WAL handles crash-safety).
- ❌ Single-writer concurrency — adequate for typical workloads (≤ ~1000 dispatches/sec) but **not** a fit for very-high-throughput multi-instance dispatch.
- ❌ Bumps Node engines requirement to ≥ 22.13.
- ❌ Schema migration + retention policy still required (same as any queue backend).

### External queue backends (RDBMS / event-streaming tiers) — explicitly **out of scope**

These were considered at the ADR's original drafting and rejected by revision:

- ❌ Adding drivers for any of them breaks ADR-0005 (zero runtime deps) or expands the runtime's maintenance surface.
- ❌ Each tier (RDBMS `SKIP LOCKED`, event-streaming, GCS Pub/Sub, etc.) is already well-served by its existing library ecosystem — the runtime shouldn't compete.
- ✅ Teams operating such tiers **front the runtime with their existing queue** per `docs/operations/disaster-recovery.md §5.2.1`. The runtime is the inner, idempotent worker; the durable queue is upstream.

### Option B — In-memory queue + smaller `maxQueueSize` + caller-side retry (v0.2.x floor, unchanged)

- ✅ Zero infrastructure change.
- ❌ **Still loses tasks on crash** — the data-loss problem is not solved, just bounded.
- ❌ Shifts durability burden to every caller.
- ❌ Caller-side retry must be idempotent (often it isn't).
- ❌ Does not satisfy DR plan RPO=0 requirement.

## Implementation Notes (revised 2026-09-24)

Tracked separately as T13. The factory API adds a `queueBackend` discriminator; the existing `TaskQueue` becomes the `'memory'` implementation, and the new SQLite backend lands in `src/queue/sqlite-backend.js`.

**`node:sqlite` correctness for queue use:**
- SQLite does NOT support row-level `FOR UPDATE SKIP LOCKED`. Worker pull uses `BEGIN IMMEDIATE TRANSACTION` (database-level write lock) + `SELECT … ORDER BY priority DESC, created_at ASC LIMIT 1` + `UPDATE state='processing'` + `COMMIT`. Serialized across writers; fine for typical workloads.
- Each runtime instance opens ONE read+write `DatabaseSync` handle at startup; the file is closed in `runtime.shutdown()`.
- Multi-instance deployments write to the same `.db` file via shared filesystem (NFS, EFS, Cloud SQL via FUSE, etc.) OR replicate via Litestream. The queue backend is filesystem-agnostic.

**Schema sketch** (final shape in the implementation PR):
```sql
CREATE TABLE queue_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT UNIQUE NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  affinity_key TEXT,
  payload BLOB NOT NULL,           -- JSON.stringify(task)
  state TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  attempt INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX queue_tasks_pending ON queue_tasks(state, priority DESC, enqueued_at ASC) WHERE state = 'pending';
```

**Backwards compatibility:** the default `queueBackend: 'memory'` keeps the existing `TaskQueue` and tests intact. The SQLite backend is opt-in.

**Out-of-scope backends** (RDBMS / event-streaming tiers): not shipped, not planned. Documented in `docs/operations/disaster-recovery.md §5.2.1` as the caller-side fronting workaround for teams already operating those tiers.

## Links

- `docs/operations/disaster-recovery.md` §5.2.1 — the gap this ADR closes.
- ADR-0007 — Automatic retry policies with exponential backoff (complements this ADR for already-dispatched tasks).
- ADR-0009 — Elastic worker pool auto-scaling (multi-instance deployments assume safe queue sharing).
- ADR-0018 — Fire-and-forget hazard with `execute` and post-shutdown flakes (related shutdown semantics).
- Superseded by: none (this ADR's recommendation was REVISED from RDBMS-first to SQLite-first; the ADR itself remains current).
- Supersedes: none (this is a new decision, revised once on 2026-09-24).
