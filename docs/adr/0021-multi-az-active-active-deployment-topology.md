# ADR-0021: Multi-AZ Active-Active Deployment Topology

- **Date**: 2026-09-18
- **Status**: Accepted
- **Deciders**: SRE + Platform team
- **Tags**: architecture, availability, deployment, prod-readiness

## Context and Problem Statement

A single runtime instance is a single point of failure. The disaster recovery plan (`docs/operations/disaster-recovery.md` §5.1-5.4) calls out three failure modes that a single instance cannot survive:

1. **Worker crash** (S0) — already handled by the supervisor's auto-recycle (ADR-0010).
2. **Instance crash** (S1) — health check fails, but traffic doesn't auto-recover until a replacement exists.
3. **AZ failure** (S3) — the entire availability zone becomes unreachable.

Even with auto-scaling in place, an instance crash leaves a small RTO window (2 minutes for replacement to boot + health check pass). And no auto-scaling strategy helps if the AZ itself is the failure domain — every instance in the AZ dies at once.

The Phase E benchmark (`BENCHMARKS.md §18`) also establishes that **vertical scaling beyond ~16 workers per instance is counterproductive**. Scaling must happen horizontally — and horizontally means multiple instances, which means an availability story for those instances.

## Decision Drivers

- **AZ failure tolerance**: a single AZ going down must not cause user-visible downtime.
- **Graceful degradation**: losing one instance should not saturate the others (capacity headroom required).
- **Operational simplicity**: topology must be explainable in one diagram to on-call engineers.
- **Cost ceiling**: avoid paying for "always-on" standby instances that idle 99% of the time — but accept a small standby footprint.
- **No single point of failure**: every component in the request path must have ≥2 replicas.

## Considered Options

- **Option A — Single AZ, single instance, auto-scaling only**
- **Option B — Single AZ, multiple instances, auto-scaling**
- **Option C — Multi-AZ, N+M active-passive** (N active instances, M hot standby)
- **Option D — Multi-AZ active-active (chosen)**

## Decision Outcome

Chosen option: **"Option D — Multi-AZ active-active"**.

The deployment topology is: **≥ 2 instances per AZ, across ≥ 2 AZs**, with a load balancer in front doing health-check-based routing. Each instance runs `WORKER_CONCURRENCY=8-16` workers (Phase E sweet spot). Capacity target: N+M where N is steady-state traffic and M is the headroom to absorb a peer instance dying.

Concrete sizing example for the 28-core homelab benchmark host:
- 4 instances × 8 workers each = 32 total workers.
- One instance dies → 24 workers remain (75% capacity). LB reroutes traffic, surviving instances absorb it.
- One AZ dies → 2 instances × 8 workers = 16 workers. Capacity drops to 50%, alert fires.

### Positive Consequences

- **AZ failure tolerance**: an AZ outage does not stop service — surviving AZs absorb traffic.
- **Graceful degradation on instance death**: LB removes unhealthy instance, traffic redistributes in seconds.
- **Rolling deploys become trivial**: replace one instance at a time, LB drains the old one naturally.
- **Capacity headroom is explicit and tunable**: N+M sizing makes the failure budget visible.

### Negative Consequences

- **2× the infrastructure cost** vs single-AZ (instances, LB, monitoring).
- **Cross-AZ network latency** for any stateful operation (DB writes, cache misses): typically < 2ms intra-region, more if cross-region.
- **Distributed-systems complexity**: tasks that touch shared state across instances (e.g., the durable queue from ADR-0020) need correct locking semantics.
- **Observability must be unified**: metrics from N instances need aggregation in Prometheus, not per-instance dashboards.

## Pros and Cons of the Options

### Option A — Single AZ, single instance, auto-scaling ❌ Rejected

- ✅ Simplest topology. Cheapest.
- ❌ SPOF. AZ failure = total outage.
- ❌ Even brief instance restart = brief outage.
- ❌ Health-check + replacement RTO is 2 minutes minimum; users see this as downtime.

### Option B — Single AZ, multiple instances ❌ Rejected

- ✅ Tolerant of instance failure within an AZ.
- ✅ Still cheap.
- ❌ Still SPOF at the AZ level.
- ❌ Deployments limited to a single failure domain.

### Option C — Multi-AZ N+M active-passive ⚠️ Acceptable alternative

- ✅ Lower cost than active-active (only N is "live" traffic).
- ✅ AZ failure tolerance.
- ❌ Failover delay: standby instance must boot, warm up, take traffic. Visible latency bump.
- ❌ Failover automation is hard to get right (split-brain risk if both think they're active).
- ❌ Underutilized standby hardware.

### Option D — Multi-AZ active-active ✅ Chosen

- ✅ Zero-downtime failover (LB just routes around the dead peer).
- ✅ All capacity is utilized (no idle standby).
- ✅ Rolling deploys are simple (replace one at a time).
- ❌ Higher baseline cost (every instance is doing real work).
- ❌ Requires careful capacity planning to absorb peer failures.
- ❌ Observability must aggregate across instances.

## Capacity Sizing Rules

The decision includes these explicit sizing rules:

1. **N+M formula**: `instances = ceil(peak_traffic / capacity_per_instance) + 1` minimum. The "+1" is the headroom for one peer dying.
2. **Per-instance capacity**: `WORKER_CONCURRENCY ≤ availableParallelism() / 2` on the host (leave cores for OS + other services). On the 28-core homelab benchmark host: `WORKER_CONCURRENCY ≤ 14`, round down to 8 for predictable behavior under load.
3. **Workers per instance**: 8-16, per Phase E finding that throughput plateaus at ~16 workers.
4. **AZ distribution**: at least 2 AZs; instances spread evenly. With 4 instances, deploy 2 per AZ.

## Anti-Patterns to Avoid

- **Single-instance production deployment** — never. Even a "small" workload deserves 2 instances for failover.
- **Active-passive without automatic failover** — manual failover doesn't work at 3am.
- **Cross-region single-instance** — even worse: an entire region outage takes down the service.
- **Skipping capacity headroom** — if every instance runs at 100% utilization, losing any peer saturates the rest. Always budget 25-30% headroom.

## Links

- `docs/operations/disaster-recovery.md` §3 — the topology diagram this ADR formalizes.
- `BENCHMARKS.md` §18 — Phase E saturation analysis that motivates the per-instance worker cap.
- ADR-0009 — Elastic worker pool auto-scaling (the mechanism for N+M scaling).
- ADR-0019 — Default workers reduced to 1 (the conservative default; production overrides via `WORKER_CONCURRENCY`).
- ADR-0020 — Durable external queue (multi-instance safety assumes durable queue; they go together).
- Supersedes: none.
