# Disaster Recovery Plan

> **Status**: Living document. Update after every incident, every game day, and every architecture change.
> **Owner**: SRE + Platform team. Reviewed quarterly.
> **Last validated against runtime**: v0.2.1 (post-release hygiene `99ef885`) — adaptive controller (ADR-0014, T1–T12) + runtime hardening (ADR-0024, HARDEN-01..11) all shipped. §8 captures the remaining operational gaps; nothing in this plan depends on unimplemented features.

---

## 1. Scope

This document covers disaster recovery for a production deployment of the `persistent-worker-runtime`. The runtime itself is **stateless** at the worker level (each `Worker` is a V8 isolate with ephemeral state — see ADR-0001 §Architectural Mechanics). DR therefore focuses on three things:

1. **The runtime host(s)** — replaceable in minutes via the runtime's container/AMI definition.
2. **Task durability** — in-flight and queued tasks that have not yet produced their side effect (DB write, message publish, etc.).
3. **Supervised external dependencies** — Postgres (primary + replicas), Redis (cache + rate limit), message broker (if any), object storage for state.

The DR plan assumes the runtime is deployed behind a managed load balancer (nginx / HAProxy / cloud L7) and that the surrounding infrastructure (DNS, secrets store, monitoring) is itself a separate concern handled by the platform team.

### What is *not* in scope

- Source code loss — handled by Git + remote backup of forks.
- Compromise of secrets — handled by Vault rotation, not by DR.
- Region-wide internet failure — outside our control; documented as "unrecoverable from our side".
- Application-level bugs (incorrect business logic) — handled by rollback/feature flag, not DR.

---

## 2. Recovery Objectives

Targets assume the architecture described in `BENCHMARKS.md §18` (≤ 16 workers per instance, scale horizontally by adding instances):

| Severity | Scenario | RTO (time to recover) | RPO (data loss window) | Owner |
|---|---|---|---|---|
| **S0 — Trivial** | Single worker crash (recycle path) | 0 seconds (auto-spawn) | 0 (worker is stateless) | Supervisor auto |
| **S1 — Minor** | Single instance crash / health check fails | ≤ 2 minutes (LB removes + auto-scaling spins up) | 0 (no local state to lose) | LB + autoscaler |
| **S2 — Moderate** | TaskQueue overflow / sustained backpressure | ≤ 15 minutes (manual: drain queue, scale workers, restart) | 0 (queue is in-memory; tasks dropped with rejection error) | On-call SRE |
| **S3 — Significant** | Single AZ failure | ≤ 30 minutes (LB fails over to other AZs) | 0 if async durable queue; ≤ 5 minutes if in-memory queue | On-call SRE + Platform |
| **S4 — Major** | Postgres primary failure | ≤ 15 minutes (failover to replica) | ≤ 30 seconds (replication lag at fail-over moment) | DBA + Platform |
| **S5 — Severe** | Region failure | ≤ 4 hours (activate standby region) | ≤ 5 minutes (last cross-region snapshot) | Incident commander |

**Notes**:
- RPO for S2/S3 is 0 *only* when the queue is backed by durable storage (Postgres-backed queue, Kafka, SQS). If the runtime is using the default in-memory `TaskQueue`, a process crash drops queued tasks — see §5.2 for the upgrade path.
- S4's RPO depends on Postgres replication topology (sync vs async replication). Synchronous replicas give RPO=0; the 30s figure assumes the default `async` setting.

---

## 3. Architecture Topology (Reference)

The DR plan assumes this layout:

```
                     Region A (primary)                              Region B (standby, scaled-down)
                     ─────────────────────                           ──────────────────────────────────
   ┌─────────────────────────────────────────────┐                ┌─────────────────────────────────────┐
   │  AZ-A                  AZ-B                 │                │  AZ-C                                │
   │  ┌──────────────┐     ┌──────────────┐      │                │  ┌──────────────┐                    │
   │  │ App ×2-4     │     │ App ×2-4     │      │                │  │ App ×1 (DR)  │                    │
   │  │ workers: 16  │     │ workers: 16  │      │                │  │ workers: 8   │                    │
   │  └──────┬───────┘     └──────┬───────┘      │                │  └──────┬───────┘                    │
   │         │                    │              │                │         │                            │
   │         └────────┬───────────┘              │                │         │                            │
   │                  ▼                          │                │         │                            │
   │         ┌────────────────────┐              │                │         │                            │
   │         │ LB (nginx/HAProxy) │              │                │         │  (cold standby — only spins │
   │         │ + health checks    │              │                │         │   up during DR activation)    │
   │         └─────────┬──────────┘              │                │         │                            │
   └───────────────────┼─────────────────────────┘                └─────────┼────────────────────────────┘
                       │                                                      │
                       ▼                                                      ▼
            ┌──────────────────────┐                              ┌──────────────────────┐
            │ Redis (cache+rate)   │   ◄── async replication ──► │ Redis (replica)      │
            └──────────┬───────────┘                              └──────────────────────┘
                       │
                       ▼
            ┌──────────────────────┐                              ┌──────────────────────┐
            │ Postgres primary     │   ◄── streaming replica  ──► │ Postgres replica     │
            │ (AZ-A)               │                              │ (Region B)           │
            └──────────────────────┘                              └──────────────────────┘
```

Cross-region replication is asynchronous by default; the RPO of 5 minutes for S5 reflects the worst case before the last successful snapshot.

---

## 4. Backup Strategy (3-2-1 Rule Applied)

Three copies, two different storage media, one offsite. Per data class:

| Data | Copy 1 (primary) | Copy 2 (local snapshot) | Copy 3 (offsite) | Frequency | Retention |
|---|---|---|---|---|---|
| **Postgres** | Primary instance | Daily base backup on AZ-local NVMe | Cross-region snapshot (S3 / GCS) | Continuous WAL archiving + daily base | 7d hot, 30d warm, 1y cold |
| **Redis** | Primary instance | AOF rewrite (default 1s fsync) | — (replica only) | Every 1s | 1h hot, 7d via replica |
| **TaskQueue state** | (in-memory, see §5.2) | — | — | n/a | n/a |
| **Runtime config / env** | Source repo | — | Image registry (immutable tags) | Per deploy | Permanent per tag |
| **Secrets** | Vault | — | Vault replicas (HA) | Per rotation | Per secret TTL |
| **Observability data** | Prometheus TSDB | Loki log archive | S3 cold storage | Continuous | 30d hot, 1y cold |

**Restore drill**: weekly, automated. Last successful restore + checksum verification is recorded in the runbook (`runbook.md` §Backup Drills).

---

## 5. Failover Procedures

Each scenario has a **detect → decide → execute** structure. The first two steps are usually automated (alerting + runbook pages on-call). Execution may be manual for S3+.

### 5.1 Worker crash (S0 — auto, no human)

The supervisor detects `worker.exited` and spawns a replacement (see `supervisor.js#checkRecycling`). In-flight task state is **lost** — the task's parent Promise rejects with the worker's exit code. If the task was dispatched via `runtime.execute(...)`, the caller sees a rejection and the retry policy (ADR-0007) decides whether to re-dispatch.

**Action**: none. Verify in post-incident review that the retry policy caught the task; if not, log as data loss.

### 5.2 Single instance crash (S1 — auto via autoscaler)

LB health check (`GET /healthz`) fails for ≥ 3 consecutive 1-second probes. LB removes the instance. Auto-scaling group launches a replacement. The replacement comes up cold (~ 5-15 seconds for `Worker` spawn × `WORKER_CONCURRENCY`).

**Data loss**: any tasks queued in the crashed instance's in-memory `TaskQueue`. See §5.2.1.

**Recovery time**: 2 minutes end-to-end (LB removal + replacement boot + warmup).

#### 5.2.1 Critical: in-memory queue drops on crash

The default `TaskQueue` (`src/task-queue.js`) keeps pending tasks in memory. A crash drops them. Mitigations, in order of preference:

1. **Recommended for prod**: front the runtime with a durable external queue (SQS, Kafka, Postgres-backed). The runtime reads from the external queue, so crash loses only the in-flight ones (handled by retry).
2. **Acceptable for low-loss workloads**: keep in-memory queue but reduce `maxQueueSize` and rely on caller-side retry. Document the data-loss window in the API contract.
3. **Experimental**: use Postgres-backed queue inside the runtime (`options.queueBackend: 'postgres'` — TBD; tracked in §8).

### 5.3 TaskQueue overflow / sustained backpressure (S2 — on-call)

Detected by: queue depth alert (> 80% of `maxQueueSize` for 5 minutes) OR `runtime.stats.adaptive.lastResizeReason === 'grow'` sustained for 10+ minutes.

**Recovery steps**:
1. Check current worker count vs `WORKER_CONCURRENCY` cap — is the runtime already at max?
2. If yes: scale horizontally (add an instance). LB distributes new load.
3. If no: increase `WORKER_CONCURRENCY` and restart, OR enable the adaptive controller (T7 wiring required).
4. Inspect queue contents — are tasks stuck on a specific affinity key? May indicate a bad worker.
5. Capture `runtime.stats.adaptive` snapshot before mitigation for postmortem.

### 5.4 Single AZ failure (S3)

LB detects AZ-local instances failing health checks. Routes traffic to surviving AZ.

**Recovery steps**:
1. Verify other AZs are absorbing load — watch `runtime.stats.adaptive.effectiveWorkers` per instance, ensure no saturation.
2. If surviving AZs are saturated, manually scale them up.
3. Bring up replacement instances in a third AZ (if available) — DR drills should pre-warm AMIs.
4. Once AZ is back, rebalance gradually (don't rejoin all instances at once or you'll overwhelm cold caches).

### 5.5 Postgres primary failure (S4 — DBA)

Detected by: connection refused from app → pg_isready check → alert.

**Recovery steps**:
1. Verify replica is healthy and replication lag is acceptable.
2. Promote replica: `pg_ctl promote` or cloud-managed equivalent (RDS failover, Cloud SQL failover).
3. App connection pool re-resolves DNS to the new primary within seconds.
4. **Verify in-flight tasks**: tasks mid-transaction may need to be re-driven. Use the retry policy (ADR-0007) — failed transactions during the failover window are normal.

### 5.6 Region failure (S5 — incident commander)

This is a war-room scenario. Decisions are made by the incident commander (engineering lead + SRE + DBA).

**Recovery steps**:
1. **Declare the incident** on the status page. Internal stakeholders per the escalation tree (see `runbook.md`).
2. **DNS failover** to the standby region's LB. TTL on the public DNS should already be ≤ 60 seconds.
3. **Warm the standby** — the standby region's app instances are scaled down (cost-saving). Spin them up to full capacity. The runtime's own boot time is short; the bottleneck is usually the Postgres replica promotion + Redis promotion.
4. **Postgres**: promote the cross-region replica. RPO is the last successful cross-region snapshot (≤ 5 minutes by default).
5. **Redis**: the cross-region replica becomes the new primary. Brief TTL miss during failover is acceptable; cache rebuilds.
6. **Validate**: smoke test critical endpoints, watch error rate for 30 minutes.
7. **Communicate**: status page updates every 30 minutes until resolution.

---

## 6. Recovery Procedures (Step-by-Step)

These are the literal steps an on-call engineer follows during an incident. They assume basic familiarity with the runtime's CLI / container image.

### 6.1 Replace a single instance (S1)

```bash
# 1. Confirm the instance is unhealthy
LB_DASHBOARD_URL=https://...
# Look for the instance IP / container ID

# 2. (Optional) Force-evict from LB to drop traffic immediately
ssh lb-host 'curl -X DELETE http://consul/v1/agent/service/deregister/<service-id>'

# 3. Wait for auto-scaling group to launch a replacement
# (Or manually: scale up + wait for new instance + health check pass)

# 4. Verify new instance is healthy
curl http://new-instance:3000/healthz
# Expect: {"status":"ok","workers":16,"queueDepth":0}

# 5. Postmortem within 24h
```

### 6.2 Restore Postgres from snapshot (S4 — extreme)

```bash
# 1. Identify the snapshot to restore
# In S3 / GCS, find the latest snapshot BEFORE the incident time
SNAPSHOT_ID="snap-2026-09-18T0300Z"

# 2. Spawn a new instance from the snapshot
# (Cloud-specific: aws rds restore-db-instance-to-point-in-time, etc.)

# 3. Wait for the new instance to be available
# This can take 5-30 minutes for large DBs

# 4. Update connection string (or DNS) to point to the new instance

# 5. Verify
psql -h new-primary -c "SELECT count(*) FROM tasks WHERE created_at > now() - interval '5 minutes';"
# Should show recent activity

# 6. The DRILLED-RESTORE record in runbook.md §Backup Drills must be updated.
```

### 6.3 Activate standby region (S5)

```bash
# 1. (Incident commander only) Update DNS to point to standby region
# This depends on the DNS provider — see platform runbook.

# 2. Scale standby region app instances to full capacity
# (Cloud-specific — e.g., aws autoscaling update-auto-scaling-group --desired-capacity 8)

# 3. Promote Postgres replica
# (Cloud-specific or self-managed: pg_ctl promote)

# 4. Promote Redis replica (or accept cache miss)
# Redis Sentinel / Cluster: failover via sentinel CLI

# 5. Health-check loop
for instance in $(terraform output -json standby_instances | jq -r '.[]'); do
  curl -sf http://$instance:3000/healthz || echo "FAIL: $instance"
done

# 6. Status page updates every 30 min until resolution
```

---

## 7. Testing Schedule

| Frequency | Test | Owner | Pass criteria |
|---|---|---|---|
| Weekly (automated) | Backup restore drill — Postgres snapshot → fresh instance → verify checksum | Platform | Restored instance boots, accepts connections, last 24h data queryable |
| Weekly (automated) | Synthetic transaction — send 100 tasks, confirm completion | SRE | All 100 complete within SLO, no errors |
| Monthly | Single instance kill (SIGKILL) → verify auto-recovery | SRE | New instance up within 2 minutes, no task loss (when queue is durable) |
| Quarterly | AZ failover drill — block AZ-A traffic, verify AZ-B absorbs | SRE + Platform | p99 latency stays within SLO during failover |
| Quarterly | Postgres failover drill — promote replica, verify app reconnects | DBA + SRE | App reconnects within 60 seconds, error rate < 1% during failover |
| Annually | Full region failover — activate Region B | Incident commander + leadership | RTO ≤ 4 hours, RPO ≤ 5 minutes, status page updated throughout |

---

## 8. Open Items (gaps to close)

These are concrete items that improve DR posture. None block the runtime from being production-usable **today** — every deferred item has a user-side workaround that works against the current `src/`. The subsections below capture each gap's goal, current state, why it's deferred, the workaround that already works, and the estimated effort to close it.

Quick reference (full detail follows):

| §    | Item                                       | Status   | Workaround in place                                                                                                              |
| ---- | ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 8.1  | SIGTERM handler with drain timeout         | deferred | User-wired `process.on('SIGTERM', () => runtime.shutdown())` — see `skills/.../references/observability.md §Lifecycle`           |
| 8.2  | Health-check endpoint (`/healthz`, `/readyz`) | deferred | User-side `http.createServer` reading `runtime.stats()` and `runtime.getWorkers()` (ADR-0024 / HARDEN-03)                       |
| 8.3  | OpenTelemetry traces                       | deferred | User installs `@opentelemetry/api`; runtime preserves `AsyncResource` context across the main → worker boundary (transport only)|
| 8.4  | Durable queue backend (Postgres `SKIP LOCKED`) | deferred | Caller fronts the runtime with an external queue (SQS / Kafka / Postgres) — see §5.2.1 and ADR-0020                            |
| 8.5  | Chaos game day playbook                    | missing  | —                                                                                                                                  |
| 8.6  | Cross-region snapshot automation           | missing  | —                                                                                                                                  |

### 8.1 SIGTERM handler with drain timeout

**Goal**: A built-in `createWorkerRuntime({ shutdown: { signals: true, drainMs: 30_000 } })` option that registers `process.on('SIGTERM')` / `process.on('SIGINT')` automatically and invokes `runtime.shutdown()` with a configurable drain timeout before SIGKILL fallback.

**Current state**:

- `runtime.shutdown()` is **idempotent** and does the right thing — drains the queue, closes main-thread `BroadcastChannel` instances, terminates workers, releases the Event Loop (`src/worker-runtime.js:1187`, `src/supervisor.js:835`).
- The wiring pattern users should adopt is already documented in `skills/persistent-worker-runtime/references/observability.md §Lifecycle`:
  ```js
  process.on('SIGTERM', () => runtime.shutdown());
  ```
- **No built-in signal-listener registration** in `src/`. Installing the listener inside `createWorkerRuntime()` is currently the user's responsibility.

**Why deferred**: requires settling API shape across three boundaries — (a) supervisor / runtime / process-lifecycle ownership (who owns the `process` listener when the runtime is one of many in a process?), (b) re-entrancy (a second `SIGTERM` mid-shutdown must not start a parallel drain), and (c) k8s-style grace-period semantics (`terminationGracePeriodSeconds` ≈ 30s default). All three are spec decisions rather than code; deferring avoids baking in an opinion before a production deployment exposes the real constraints.

**Workaround today**: the snippet above, plus re-killing the process with `SIGKILL` after the platform grace period (`terminationGracePeriodSeconds: 30` in the k8s pod spec). Listen for both `SIGTERM` and `SIGINT`:

```js
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => runtime.shutdown());
}
```

`runtime.shutdown()` is already idempotent — a double-signal is safe.

**Estimated effort to close**: ~25 LOC + 5 tests; one new ADR (or amendment to ADR-0018 §Shutdown Semantics). Owner: TBD.

---

### 8.2 Health-check endpoint (`/healthz`, `/readyz`)

**Goal**: Stdlib HTTP endpoints returning `{ status: 'ok' | 'draining', workers, queueDepth }` for LB health checks. `/healthz` = liveness (process alive); `/readyz` = readiness (pool ready to accept work — 503 during `shutdown()`).

**Current state**:

- **No HTTP server in `src/`.** The runtime is a library, not a daemon — HTTP is intentionally out of scope to avoid pulling `http.createServer` into the boot path for users who don't want it (ADR-0005).
- **All telemetry the response body needs is already implemented:** `runtime.stats()` (full counters + `adaptive` block, ADR-0014 T10-E) and `runtime.getWorkers()` (per-worker snapshot, ADR-0024 / HARDEN-03).
- The LB-side integration is documented in §6.1 (single-instance replace runbook) and §5.2 (auto-scaler flow).

**Why deferred**: a built-in opt-in server (`createWorkerRuntime({ health: { port: 3000 } })`) is the right long-term design but introduces a port-allocation concern (what if the user's app already binds 3000?), a graceful-shutdown hook (the server must 503 → drain → close), and a meaningful test surface (port-bound tests are notoriously flaky in CI). Non-trivial.

**Workaround today**: a minimal caller-side handler (~12 lines):

```js
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...runtime.stats() }));
  } else if (req.url === '/readyz') {
    res.writeHead(runtime.isShuttingDown ? 503 : 200);
    res.end();
  }
});
server.listen(3000);
```

`runtime.stats()` already returns counters plus `workers: {...}` and `adaptive: {...}` blocks (ADR-0024 + ADR-0014 surface). For `/readyz` 503-during-shutdown, gate on the existing `isShuttingDown` flag.

**Estimated effort to close**:

- _"Ship a recipe only" option_: ~30 LOC example + docs cross-link. ~10 minutes.
- _"Built-in opt-in server" option_: ~80 LOC in `src/health-server.js` + 5 tests + shutdown coordination. 1–2 hours. Decision required.

---

### 8.3 OpenTelemetry traces

**Goal**: Stdlib-compatible spans (`@opentelemetry/api` style) so users can plug in their own exporter (OTLP / Jaeger / Honeycomb) without forcing the runtime to import OTel itself — ADR-0005 forbids runtime deps.

**Current state**:

- **Partial foundation in place.** `src/task-handle.js:47` documents integration with `AsyncResource` (`node:async_hooks`) for APM/OpenTelemetry context propagation. The runtime preserves context across the main-thread → worker-thread boundary via `AsyncResource`, which is the same transport the OTel Node SDK uses under the hood.
- **No spans emitted from the runtime.** No `tracer.startSpan`, no `span.end()`, no `exporter.flush()`. Users running OTel must wrap their own task fns.
- **Coverage today** is whatever the user adds: queue-wait, worker-dispatch, recycle, preemption, stream-chunk — none of these are auto-traced.

**Why deferred**: scope decisions dominate the implementation:

- (a) One span per `execute()`, or split into queue-wait / dispatch / worker / result?
- (b) `dispatch()` (fire-and-forget, ADR-0003) emits a lifetime span that ends on completion / error, or closes at dispatch and relies on the user-internal event chain?
- (c) Peer-dep pattern (`@opentelemetry/api` optional, only required when the user supplies an exporter) keeps zero-deps while unlocking OTel — but requires the runtime to **not** import the package eagerly.

Without production telemetry to anchor these choices, building first locks us in.

**Workaround today**:

1. User installs `@opentelemetry/api` and `@opentelemetry/sdk-node` themselves.
2. Wrap task fns in `tracer.startActiveSpan('my-task', async () => {...})`.
3. The runtime's `AsyncResource` propagation means spans created on the main thread flow into worker execution **without extra wiring** — this is already working today.

**Estimated effort to close**: ~120 LOC adapter + span-boundary spec + 5 tests + ADR. Owner: TBD.

---

### 8.4 Durable queue backend (Postgres `SKIP LOCKED`)

**Goal**: `createWorkerRuntime({ queueBackend: 'postgres', postgres: { connectionString: ... } })` so `dispatch()` writes to a Postgres queue table and workers pull via `SELECT … FOR UPDATE SKIP LOCKED`. Closes the RPO>0 gap on S1 (single-instance crash) for users who already operate Postgres.

**Current state**:

- **Not implemented.** ADR-0020 records the **decision** (Postgres-first; Kafka or SQS acceptable alternatives) and explicitly defers implementation: *"Tracked separately as T7-extension or T12 — this ADR records the decision, not the implementation steps."* (ADR-0020 §Implementation Notes).
- `src/task-queue.js` is the only backend — well-tested, in-memory, zero deps.
- §5.2.1 documents the in-memory queue crash-loss behavior and ranks this as the **#1 RPO risk** for production deployments without external durability.

**Why deferred**:

- **Schema design** decisions: queue table shape, indexes for FIFO + worker affinity (`affinityKey`), retention policy for completed rows.
- **Peer-dep without breaking ADR-0005:** the runtime must work when `pg` is absent (in-memory fallback) but switch to Postgres when present. Non-trivial factory wiring.
- **Migration story**: existing single-instance users get the new option as additive, but tests / benchmarks must keep both code paths green.
- **Operational concerns**: queue table needs TTL / vacuum to avoid unbounded growth, plus a way to inspect backlog (`runtime.queueStats()`).

**Workaround today**: per §5.2.1 — front the runtime with a **durable external queue** (SQS / Kafka / Postgres). The caller reads from the external queue and feeds the runtime via `dispatch()` (which becomes the inner, idempotent worker). For RPO=0 with the in-memory queue, ensure callers use ADR-0007 retry semantics with idempotent task fns.

**Estimated effort to close**: ~300–400 LOC across `src/queue/postgres-backend.js` + `pg` peer-dep + tests + migration tooling + ADR. Owner: TBD.

---

### 8.5 Chaos game day playbook

**Goal**: Scheduled drills (chaos-mesh / Gremlin scenarios) that exercise the runtime's failure modes systematically — single-worker kill, `SIGKILL` the whole instance, Postgres primary failover during active dispatch, broadcast-channel storm — with a written playbook so on-call engineers can run them with confidence.

**Current state**: missing. §7 lists the test cadence (weekly / monthly / quarterly) but no executable drill scripts.

**Estimated effort to close**: ~150 LOC bash + ~50 lines of runbook entries. Owner: TBD.

---

### 8.6 Cross-region snapshot automation

**Goal**: Automated snapshot push from the primary region's storage to the standby region (AWS Backup plans, GCP Backup, or equivalent), replacing the manual §4 dance.

**Current state**: missing. §4 §Postgres row documents today's manual cross-region snapshot.

**Estimated effort to close**: depends on cloud choice (Terraform module + AWS Backup plan ≈ 80 LOC; GCP equivalent ≈ 100 LOC). Owner: TBD.

---

## 9. References

### Architecture Decision Records

- ADR-0001 — Persistent Worker Runtime over worker_threads
- ADR-0007 — Automatic retry policies with exponential backoff
- ADR-0009 — Elastic worker pool auto-scaling
- ADR-0010 — Automatic worker recycling (anti-memory-leak)
- ADR-0014 — Adaptive concurrency auto-tuning via Event Loop utilization
- ADR-0017 — Cooperative cancellation via AbortSignal
- ADR-0018 — Fire-and-forget hazard with `execute` and post-shutdown flakes
- ADR-0019 — Default workers reduced from `availableParallelism()` to 1
- **ADR-0020 — Durable external queue for production deployments** (closes the in-memory queue RPO gap, §5.2.1)
- **ADR-0021 — Multi-AZ active-active deployment topology** (formalizes the §3 topology diagram)

### Other docs

- `BENCHMARKS.md` §18 — CPU saturation point (T6 prep: empirical foundation for `WORKER_CONCURRENCY`)
- `runbook.md` — daily operation, alerts, escalation
