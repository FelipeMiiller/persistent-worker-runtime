# ADR-0020: Durable External Queue for Production Deployments

- **Date**: 2026-09-18
- **Status**: Accepted
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

- **Option A — Postgres-backed queue** (e.g., `SELECT … FOR UPDATE SKIP LOCKED`)
- **Option B — Kafka (or compatible: Redpanda, MSK)**
- **Option C — AWS SQS (or compatible: GCS Pub/Sub equivalent)**
- **Option D — Keep in-memory queue, reduce `maxQueueSize` and rely on caller-side retry**

## Decision Outcome

Chosen option: **"Option A — Postgres-backed queue"**, with explicit guidance that **Option B (Kafka)** is acceptable when an event-streaming tier already exists. **Option C (SQS)** is acceptable for cloud-native deployments where the team has no Postgres operational expertise. The decision is "durable queue, Postgres-first", not "Postgres only".

The factory will gain a new option:

```js
createWorkerRuntime({
  queueBackend: 'memory',     // default — current behavior, for tests
  // or
  queueBackend: 'postgres',
  postgres: { connectionString: process.env.DATABASE_URL },
  // or
  queueBackend: 'kafka',
  kafka: { brokers: [...] },
});
```

### Positive Consequences

- S1 incidents drop **zero** queued work (RPO=0 achievable without external orchestration).
- Multi-instance deployments become safe: any instance can crash mid-dispatch without losing tasks.
- Existing Postgres operational tooling (pg_dump, PITR, replicas) covers queue durability — no new backup strategy needed.
- `SELECT … FOR UPDATE SKIP LOCKED` is a battle-tested pattern, no exotic dependencies.

### Negative Consequences

- Adds ~5-15ms to queue→worker latency (Postgres round-trip vs in-memory pointer swap).
- Couples runtime availability to Postgres availability — Postgres outage stops dispatch even if the runtime itself is healthy.
- Schema migration burden: new table(s) for queue state, indexes for FIFO ordering, vacuum strategy for old completed rows.
- Operational complexity: queue table needs retention policy (TTL or archive) to avoid unbounded growth.

## Pros and Cons of the Options

### Option A — Postgres-backed queue ✅ Chosen (default recommendation)

- ✅ Reuses Postgres already in the architecture (DR plan §3).
- ✅ ACID guarantees from a system we already operate.
- ✅ `SKIP LOCKED` provides safe concurrent consumption across N runtime instances.
- ✅ Backups and replicas already cover queue durability — DR is free.
- ❌ +5-15ms queue→worker latency vs in-memory.
- ❌ Couples runtime availability to Postgres health.

### Option B — Kafka

- ✅ Best-in-class for high-throughput event streaming.
- ✅ Decouples queue durability from transactional store (Postgres).
- ❌ Adds a new infrastructure dependency (Kafka cluster, ZooKeeper/KRaft, monitoring).
- ❌ Overkill for workloads that don't already need event streaming.
- ❌ Operational burden of broker upgrades, partition rebalancing, etc.

### Option C — SQS / cloud-native message broker

- ✅ Fully managed — zero ops burden on the team.
- ✅ Auto-scales, auto-retries, native DLQ.
- ❌ Cloud vendor lock-in (each cloud has a different offering).
- ❌ Per-message cost at scale adds up.
- ❌ Latency higher than in-memory, similar to Postgres.

### Option D — In-memory queue + smaller `maxQueueSize` + caller-side retry

- ✅ Zero infrastructure change.
- ❌ **Still loses tasks on crash** — the data-loss problem is not solved, just bounded.
- ❌ Shifts durability burden to every caller.
- ❌ Caller-side retry must be idempotent (often it isn't).
- ❌ Does not satisfy DR plan RPO=0 requirement.

## Implementation Notes

Tracked separately as T7-extension or T12 — this ADR records the decision, not the implementation steps. The factory API will likely add a `queueBackend` discriminator; the existing `TaskQueue` becomes the `'memory'` implementation.

## Links

- `docs/operations/disaster-recovery.md` §5.2.1 — the gap this ADR closes.
- ADR-0007 — Automatic retry policies with exponential backoff (complements this ADR for already-dispatched tasks).
- ADR-0009 — Elastic worker pool auto-scaling (multi-instance deployments assume safe queue sharing).
- ADR-0018 — Fire-and-forget hazard with `execute` and post-shutdown flakes (related shutdown semantics).
- Superseded by: none.
- Supersedes: none (this is a new decision).
