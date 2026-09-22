# Issue 002: Wave 4 (T9-T11) review findings

**Severity:** low-to-medium (1 hygiene fix, 1 cosmetic, 3 docs)
**Found by:** post-implementation review of Wave 4 commits (`3882ee8` T9, `cdb8ce4` T10, `35cec8f` T11)
**Date:** 2026-09-21
**Closed:** 2026-09-22 (all 3 findings + Track 2 chunk leak fixed and shipped in **v0.2.0**)
**Component:** `src/supervisor.js`, `src/worker-handle.js`, `src/worker-runtime.js`

> Companion handoff for the "next chat" to pick up before declaring
> `runtime-hardening` stable. Three real findings (one worth fixing
> before release, two cosmetic/docs), and three "good to know" notes
> about behavior changes.

---

## Finding 1 — T11: pending recycle-backoff Promise leaks when shutdown cancels timer mid-backoff

**Severity:** medium (hygiene — not a correctness bug, but a leaked closure until GC)

### Symptom

When `runtime.shutdown()` is called while a recycle-backoff timer is in
flight (i.e., the old worker is sitting in `runtime.getWorkers()` with
`status: 'recycling'` during the grace window), the shutdown path
correctly `clearTimeout`s the timer but the awaiting `new Promise(...)`
inside `#checkRecycling` never resolves. The `.then(...)` chain
attached to `#spawnWorker()` hangs too. The closure (holding `worker`
and the local `replacement` Promise) stays in memory until the
`WorkerRuntime` instance is GC'd.

### Repro

```js
const runtime = await createWorkerRuntime({
  workers: 1,
  maxTasksPerWorker: 1,
  recycleBackoffMs: 5000,
});

// Trigger a recycle — worker enters backoff
await runtime.execute({ fn: () => 42 });
await new Promise(resolve => setTimeout(resolve, 100)); // let spawn complete

// Mid-backoff shutdown
await runtime.shutdown();
// The recycle's .then chain is now permanently pending.
// GC eventually collects it when the runtime is dropped.
```

### Root cause

`src/supervisor.js:676-689` (the backoff block):

```js
if (this.#recycleBackoffMs > 0) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, this.#recycleBackoffMs);
    this.#recycleBackoffTimers.set(worker.id, timer);
  });
  this.#recycleBackoffTimers.delete(worker.id);
  if (this.#isShuttingDown) return;
}
```

`shutdown()` clears the timer via `clearTimeout(timer)` (line 852) but
the local `resolve` callback inside the awaiting Promise is never
invoked. The Promise is left pending forever.

### Impact

- **In practice:** benign — users typically drop the runtime reference
  after `shutdown()` resolves, GC cleans up the leak.
- **In principle:** sloppy. Future refactors (e.g., adding backoff
  telemetry that reads from the awaited Promise) would surface the
  hang.

### Proposed fix

Store the `resolve` callback alongside the timer in
`#recycleBackoffTimers`. Have `shutdown()` invoke `resolve()` for each
pending entry (in addition to `clearTimeout`):

```js
// In #checkRecycling backoff block:
this.#recycleBackoffTimers.set(worker.id, { timer, resolve });

// In shutdown():
for (const entry of this.#recycleBackoffTimers.values()) {
  clearTimeout(entry.timer);
  entry.resolve(); // ← releases the pending Promise
}
this.#recycleBackoffTimers.clear();
```

### Test plan

- Add a test that calls `shutdown()` while a recycle-backoff is in
  flight; verify the awaited Promise resolves within a small timeout
  (e.g., 200 ms), not after the full `recycleBackoffMs`.
- Verify no `unhandledRejection` events fire during shutdown-during-backoff.

### Tracking

- **Status:** ✅ fixed — `714f1e6` (2026-09-21). `src/supervisor.js` now stores
  `{ timer, resolve }` in `#recycleBackoffTimers`; `shutdown()` invokes
  `entry.resolve()` after `clearTimeout`, releasing the awaiting Promise so
  the `.then()` chain attached to `#spawnWorker()` runs to completion.
- Test: `test/recycle-backoff.test.js` adds "shutdown() during a
  recycle-backoff releases the awaiting Promise (regression for Finding 1
  in .agents/issues/002)" — verifies prompt shutdown return, no
  unhandledRejection, clean post-shutdown state.
- Caveat documented in the test: closure release itself isn't directly
  observable without `--expose-gc`; the test enforces the user-visible
  contract (promptness + clean state) and acts as a regression guard.
- Pipeline after fix: 562/563 passing (was 561/562), 0 fail, 1 skipped
  (unchanged — same chunk leak from Track 2).

---

## Finding 2 — T10: `#startWorkerPoll` has redundant `if/else` branches

**Severity:** low (cosmetic — both branches call `#checkRecycling`)

### Symptom

`src/supervisor.js:805-833` (the poll body inside `#startWorkerPoll`):

```js
const accumulationEnabled = this.#accumulationRateMbPerSec !== Infinity;
for (const worker of this.#workers.values()) {
  if (accumulationEnabled) {
    this.#sampleAccumulation(worker);
    this.#checkRecycling(worker);
  } else {
    this.#checkRecycling(worker);
  }
  this.#checkWorkerWatchdog(worker);
}
```

The two branches are identical except for `#sampleAccumulation`. The
intent (gate memory sampling on accumulation being enabled) is buried
inside an over-branched structure.

### Proposed simplification

```js
const accumulationEnabled = this.#accumulationRateMbPerSec !== Infinity;
for (const worker of this.#workers.values()) {
  if (accumulationEnabled) {
    this.#sampleAccumulation(worker);
  }
  this.#checkRecycling(worker);
  this.#checkWorkerWatchdog(worker);
}
```

### Impact

- Zero functional change. Just code-clarity.

### Tracking

- **Status:** ⏳ open — cosmetic. Fix opportunistically whenever
  `#startWorkerPoll` is next touched.
- Estimated effort: ~5 min.

---

## Finding 3 — T9: fresh-worker priority masks FIFO/LRU distinction in fresh pools

**Severity:** docs (not a bug — the implementation matches the spec)

### Symptom

In a fresh pool (no worker has `tasksCompleted > 0`), the dispatch
algorithm picks the **first fresh worker in insertion order** regardless
of `dispatchStrategy`. So `lru` and `fifo` produce identical behavior
for the first `workers` dispatches. The strategies only diverge once
at least one worker has `tasksCompleted > 0`.

### Where to look

- `src/supervisor.js:347-365` (`#pickByStrategy`): the fresh-worker
  priority branch picks `candidates.find(w => w.tasksCompleted === 0)`
  without applying the configured strategy.
- `test/round-robin-dispatch.test.js`: the FIFO test uses a
  `pre-warm` step to make all workers non-fresh before asserting
  FIFO concentration on worker 0. Without pre-warm, the test would
  fail (would observe fresh-priority behavior).

### Impact

- All strategies behave correctly per spec. Just worth documenting
  that "fresh" means "never had a task" not "just recycled" — both
  satisfy `tasksCompleted === 0`, and both get priority in all
  strategies.

### Proposed action

Add a one-line note to the `dispatchStrategy` getter in `src/worker-runtime.js`
and `src/supervisor.js` clarifying the fresh-worker priority behavior.
Already mentioned in the inline comment on `#pickByStrategy`, but
worth duplicating in the user-facing getter for discoverability.

### Tracking

- **Status:** ⏳ docs only — handle when T12 README updates land.

---

## Behavior changes worth knowing (Wave 4)

> None of these are bugs. They're documented in the commit messages but
> worth re-surfacing for the next chat to communicate clearly.

### BC-1: T9 — Multi-worker pools no longer "sticky" on worker 0

**Before T9:** `runtime.execute()` in a 4-worker pool would land all
sequential tasks on `workers[0]` (the first-spawned worker, which
stayed idle between dispatches).

**After T9:** tasks round-robin via LRU (default), so consecutive
tasks may land on different workers.

**Impact:** tests that rely on state-continuity across consecutive
tasks on the same worker need `workers: 1` or `affinityKey`.
`test/broadcast-worker-context.test.js` already wraps in a
single-worker runtime for this reason — that fix is in `3882ee8`.

### BC-2: T10 — Supervisor-level watchdog preempts at `workerPollIntervalMs` (default 1000ms)

**Before T10:** tasks with `forceKillOnTimeout: true` pre-empted at
`task.timeoutMs`.

**After T10:** in addition to the per-task watchdog, the supervisor
poll also checks at `workerPollIntervalMs`. For tasks with
`timeoutMs > workerPollIntervalMs` (the typical case where `timeoutMs`
defaults to 5000ms and `workerPollIntervalMs` defaults to 1000ms), the
supervisor now pre-empts at ~1s instead of ~5s.

**Impact:** users with `timeoutMs: 5000, forceKillOnTimeout: true`
expecting 5s now get pre-empted at 1s. The per-task watchdog still
fires (no-op since the supervisor already terminated), but the
end-user-visible preemption latency drops.

**Mitigation if longer timeouts are needed:** set
`workerPollIntervalMs` higher (e.g., 10000).

### BC-3: T10 — Supervisor poll always runs (was gated on accumulation)

**Before T10:** poll ran only when `accumulationRateMbPerSec !== Infinity`.

**After T10:** poll always runs once the supervisor starts. Accumulation
sampling inside the poll is still gated on accumulation being enabled.

**Impact:** users with accumulation disabled now have an `unref`'d
`setInterval` running at `workerPollIntervalMs`. Custo per tick is
O(N) (one early-return guard call per worker). `unref` ensures the
poll never blocks event loop shutdown.

---

## Pre-stable checklist (for the next chat)

| # | Item | Status |
|---|------|--------|
| 1 | Finding 1 — T11 backoff Promise leak fix | ✅ fixed (`714f1e6`) |
| 2 | Finding 2 — T10 `#startWorkerPoll` simplification | ✅ fixed (`12f7603`) |
| 3 | Finding 3 — T9 fresh-priority doc note in getter | ⏳ docs |
| 4 | Track 2 (chunk leak) — un-skip the `streaming-edge-cases` test, add guard | ✅ fixed (`b5c4bde`) |
| 5 | Track 5 (hot-path CI gate) — wire `benchmarks/hot-path-micro.benchmark.js` into `npm run validate` or pre-push | ⏳ queue |
| 6 | T12 docs — README § / BENCHMARKS § / HANDOVER refresh / STATE.md final + ADR-0024 status `Proposed` → `Accepted` | ⏳ queue |
| 7 | version bump `0.1.0` → `0.2.0` + CHANGELOG.md | ⏳ queue |

After #4-#7 land, emit the **"stable v0.2.0 ready"** alert per the
user's standing rule: `bump version + npm publish + git tag`.

---

## Cross-references

- Wave 4 commits: `3882ee8` (T9), `cdb8ce4` (T10), `35cec8f` (T11).
- Wave 4 post-review fix: `714f1e6` (Finding 1 — recycle-backoff Promise leak).
- Wave 4 post-review fix: `12f7603` (Finding 2 — `#startWorkerPoll` redundant if/else collapse).
- Track 2 fix: `b5c4bde` (chunk leak — suppress late `stream:chunk` events after shutdown).
- Feature spec: `.specs/features/runtime-hardening/spec.md` + `tasks.md`.
- ADR: `docs/adr/0024-runtime-observability-and-recycling-hardening.md`
  (currently `Proposed`).
- Pipeline at handoff time: 561/562 tests pass (1 skipped =
  `streaming-edge-cases` chunk leak, the Track 2 item), 0 fail,
  lint clean. 22 commits ahead of origin/develop.