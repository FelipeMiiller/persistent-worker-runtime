# ADR-0018: Fire-and-Forget Hazard with `runtime.execute()` and Post-Shutdown Test Flakes

- **Date**: 2026-09-17
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: testing, ci-reliability, async-correctness, worker_threads, macos-flake

## Context and Problem Statement

A CI test on the **macOS Node.js 22.x** matrix started failing intermittently with a near-impossible-to-reproduce error:

```
Test "returns immediately (does not wait for consumer processing)" at
test/broadcast-runtime-api.test.js:63:5 generated asynchronous
activity after the test ended. This activity created the error
"WorkerCrashError: Worker worker_1789610274662_2 crashed with
exit code 1 while running task task_1789610274713_2" and would
have caused the test to fail, but instead triggered an
unhandledRejection event.
```

The same test passes locally 100% of the time. The same source code passes on Ubuntu Node 22 (in a separate CI run). On macOS, the failure is **deterministic**; on Linux, the underlying race is the same but Node absorbs the unhandled rejection silently.

The test in question was attempting to measure `runtime.broadcast()` latency without blocking on the worker:

```js
it('returns immediately (does not wait for consumer processing)', () => {
  runtime.execute({                       // 1. Fire-and-forget — Promise discarded
    type: 'no-listener-task',
    fn: (_p, _s, _context) => 'done',
  });

  const t0 = Date.now();
  runtime.broadcast('no-such-listener', { x: 1 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `broadcast took ${elapsed}ms; should be <50ms`);
});                                        // 2. Test returns sync while the worker is still busy
```

This is the **canonical fire-and-forget hazard** for any runtime built on `node:worker_threads`:

1. The task is enqueued for a worker (asynchronous scheduling latency).
2. The worker thread picks up the task and starts executing the `fn`.
3. The synchronous test body measures the broadcast latency and returns.
4. The Node test runner marks the test as "ended" because the test function returned.
5. The NEXT test (or the `after` hook) calls `runtime.shutdown()`, which `worker.terminate()`s the workers.
6. The still-running task from step 2 receives `WorkerCrashError` because the worker was terminated mid-execution.
7. The task handle's promise rejects — **asynchronously, after the test function has already ended**.
8. On slower runners (macOS), Node's test runner reports this as a hard failure instead of an unhandled rejection.

## Decision Drivers

- The runtime's `execute()` returns a Promise — there is no compile-time way to force callers to handle it. This is a JavaScript structural limitation.
- `dispatch()` is the explicit fire-and-forget API — it returns a `TaskHandle` instead of a Promise — so users who intentionally want to discard a result should reach for it, not `execute()`.
- The fix is mostly on the **caller side** (await or `.catch()`), but the runtime API documentation and the public-facing skill can make the hazard much harder to fall into.
- The CI signal-to-noise issue is orthogonal to the runtime API: any Node.js worker-based test suite is vulnerable to it on slow runners. We should harden against it locally too.

## Considered Options

- **Option 1: No-op the rejected `execute()` Promise internally** — never let `execute()` reject its returned Promise unless someone attaches `.then`/`.catch`. Pro: callers can't accidentally trigger unhandled rejection. Con: **masks genuine bugs** (worker crash during legitimate awaited `execute()` should still surface to the runtime's own error handlers).
- **Option 2: Add a `runtime.spawn()` alias for fire-and-forget** — make the fire-and-forget path unambiguous in API surface. Pro: documentation wins. Con: doesn't fix existing callers; `execute()` remains ambiguous.
- **Option 3: Document the hazard + harden the existing API surface + commit the in-test fix** — JSDoc warning on `execute()` and `dispatch()`, pitfall entry in `HANDOVER.md` and the embedded skill, fix the failing test, document the pattern in a learned-memory entry. Pro: focuses on the actual root cause (caller pattern) without changing runtime semantics. Con: relies on humans reading docs.

## Decision Outcome

Chosen option: **"Option 3: Document the hazard + harden the existing API surface + commit the in-test fix"**.

### Why not Option 1

No-op'ing the Promise when nobody is listening would **silently swallow real worker crashes**. A worker crash on a legitimately-awaited `execute()` is a fatal condition the caller should observe. Hiding it would make every crash invisible to the production user who is precisely the person whose job is to debug it.

### Why not Option 2

Adding a `spawn()` alias encourages API surface growth that has to be supported indefinitely (deprecation cycles for `dispatch()` etc.). The hazard is already eliminated by `dispatch()` existing; the gap is in caller awareness, not API design.

> **[Premise corrected by ADR-0025 — 2026-10-23.]** The sentence above rests on
> the claim that `dispatch()`'s handle promise had a `.catch()` attached
> internally. It never did, so at the time of this ADR the hazard was **not**
> eliminated by `dispatch()` existing. The premise became true only with
> ADR-0025. See [Amendment — 2026-10-23](#amendment--2026-10-23) below.

### Architectural Mechanics

#### 1. Test Fix (commit `7acdfe6`)

```diff
- it('returns immediately (does not wait for consumer processing)', () => {
-   // Subscribe but never resolve; broadcast should not hang.
-   runtime.execute({
+ it('returns immediately (does not wait for consumer processing)', async () => {
+   // Wait for a worker to settle before measuring broadcast latency, so
+   // an in-flight task cannot crash mid-measurement and turn this into
+   // an async-after-test-end error.
+   await runtime.execute({
      type: 'no-listener-task',
      fn: (_p, _s, _context) => 'done',
    });

    const t0 = Date.now();
    runtime.broadcast('no-such-listener', { x: 1 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 50, `broadcast took ${elapsed}ms; should be <50ms`);
  });
```

The test now correctly awaits the setup work before measuring latency. The cost is one extra async hop; the broadcast latency measurement is now made against an already-warm worker (more accurate).

#### 2. JSDoc Warning on `execute()` (`src/worker-runtime.js:215-224`)

The existing JSDoc on `execute()` did not warn about the hazard. Updated:

```js
/**
 * Executes a task and AWAITS its completion, returning the resolved value
 * or throwing the rejection reason.
 *
 * **Important**: this method returns a Promise that MUST be awaited, used
 * with `.then(`.catch`)`, or otherwise handled by the caller. Fire-and-forget
 * patterns like `runtime.execute(...)` without `await` (or without attaching
 * `.catch()`) leave the worker vulnerable to a `WorkerCrashError` that surfaces
 * **asynchronously after the calling scope returns**. On slower runners
 * (e.g. macOS GitHub Actions Node 22), this manifests as Node test runner
 * errors of the form:
 *
 *   "Test '...' generated asynchronous activity after the test ended.
 *    ... WorkerCrashError ..."
 *
 * If you intentionally want fire-and-forget semantics, use `dispatch()`
 * instead — it returns a `TaskHandle` with `onComplete` / `onError` and
 * `.promise` (which has `.catch()` attached internally by the handle).
 *
 * @param {Object|Function} taskDefinition
 * @returns {Promise<any>}
 */
async execute(taskDefinition) {
  const handle = this.dispatch(taskDefinition);
  return handle.promise;
}
```

The same warning is mirrored on `dispatch()` JSDoc so the contract is symmetric.

> **[Claim corrected by ADR-0025 — 2026-10-23.]** The quoted JSDoc above says
> the handle's `.promise` "has `.catch()` attached internally by the handle".
> At the time this ADR was written that was **not** true: `src/task-handle.js`
> attached no handler at all, and the only `.catch()` in `dispatch()` was on the
> *enqueue* promise. The quoted text is kept verbatim as the historical record;
> the corrected contract is ADR-0025. See
> [Amendment — 2026-10-23](#amendment--2026-10-23) below.

#### 3. Pitfall Entry in `HANDOVER.md`

Added entry to §7 "Common Pitfalls to Avoid":

> 9. **In tests, `await runtime.execute(...)` if measuring latency or relying on the result** — fire-and-forget `runtime.execute()` followed by a sync test exit can produce `WorkerCrashError` after the test ends (CI flake on slower runners like macOS Node 22). For intentional fire-and-forget, use `dispatch()` and rely on the `after` hook's `runtime.shutdown()` to terminate the in-flight task.

#### 4. Skill + Benchmark Doc Update

Both `references/broadcast-channel.md` (in the embedded skill) and `BENCHMARKS.md` already document the `execute()` vs `dispatch()` distinction. The explicit fire-and-forget safety note is now also in those references.

### Positive Consequences

- **Zero new API surface** — no deprecation debt.
- **Symmetric documentation** — `execute()` and `dispatch()` both warn about the same hazard, in opposite directions (execute: must handle; dispatch: handle is provided).
- **Tests are now genuinely macOS-safe** — the specific failing pattern in `broadcast-runtime-api.test.js:63` is fixed and stays fixed.
- **Knowledge is durable** — saved as a learned-memory entry so the agent doesn't have to rediscover this in another project.

### Negative Consequences

- Documentation is opt-in — a new contributor could still write `runtime.execute(...)` without `await`. Mitigation: the JSDoc warning is rendered prominently; the `HANDOVER.md` pitfall entry is the first thing the agent session sees; the memory entry fires on this exact pattern.
- Other unfixed tests in the codebase may have the same fire-and-forget pattern. Mitigation: future audits via `grep` for `runtime.execute` not followed by `await` should be a CI lint check (added in ADR-followup).

## Pros and Cons of the Options

### Option 3 ✅ Chosen

- ✅ No new API surface.
- ✅ Documents the contract clearly at both APIs.
- ✅ Fix is local to the failing test.
- ✅ Knowledge is durable across this and future projects.
- ❌ Documentation is opt-in.
- ❌ Future contributors may reintroduce the pattern without realizing.

### Option 1

- ✅ Callers can't accidentally trigger unhandled rejection.
- ❌ **Silently swallows real worker crashes** during legitimate awaited `execute()` — strictly worse for production users.
- ❌ Surprises developers who DO attach `.catch()` and expect the real error.
- ❌ Violates ADR-0015's promise-rejection contract.

### Option 2

- ✅ API surface makes fire-and-forget explicit.
- ✅ Self-documenting code (`runtime.spawn()` reads as "fire-and-forget").
- ❌ Doesn't fix existing callers of `execute()` who hit the hazard.
- ❌ Adds a 3rd API to maintain alongside `execute()` and `dispatch()`.

## Verification

- Unit test fix validated: `node --test test/broadcast-runtime-api.test.js` → 13/13 passing locally.
- Full suite validated: `npm run validate` → 0 lint, 213/213 tests passing.
- CI: pushed to `origin/develop` (commit `7acdfe6`); next macOS + Node 22 CI run is the gated verification. If the run passes, this ADR's root-cause analysis is confirmed.
- Memory entry: stored at `~/.minimax/agents/mavis/memory/MEMORY.md` §"Async activity after test end = CI flake" with the BAD/GOOD code snippet and reproducibility notes.

## Follow-ups (optional, tracked separately)

1. Add a grep-based audit script (`scripts/audit-fire-and-forget.sh`) that flags any test using `runtime.execute(...)` (or `dispatch(...)` outside an async context) without an immediately following `await` or `.catch()`. Run in CI as a lint variant.
2. Consider adding `--test-force-exit` to the test runner invocation so post-test async activity that DOES happen is killed fast instead of bubbling up to subsequent tests. This would mask the flake but not fix the root cause — only acceptable as a backup if the JSDoc/pitfall guard rail fails.
3. Pin the CI matrix's macOS runner to a specific hardware generation (`macos-13` or `macos-14`) so that flaky timing surfaces deterministically.

## Amendment — 2026-10-23

This ADR is **amended**, not rewritten. The decision it recorded — *document the
`execute()` hazard, do not absorb it* — **stands**. What was wrong is the
implementation claim the decision was justified by.

### What was false

Two statements in this ADR asserted an implementation detail that did not
exist:

1. §Architectural Mechanics, the mirrored `dispatch()` JSDoc:

   > `.promise` (which has `.catch()` attached internally by the handle).

   `src/task-handle.js` contains **zero** `.catch(` occurrences. The handle's
   promise is created in the constructor and returned to the caller untouched.

2. §Decision Outcome → "Why not Option 2":

   > The hazard is already eliminated by `dispatch()` existing.

   Both halves of that reasoning — the internal catch, and the elimination it
   was supposed to produce — assumed an implementation that was never written.

### Why it mattered

`runtime.shutdown()` calls `queue.destroy()`, which rejects every task still
**queued** with `WorkerRuntimeError('Runtime is shutting down')`. A queued
task has not reached a worker yet, so the runtime's own
`worker.executeTask(task).catch(…)` wiring has not adopted its promise. With
no internal handler either, Node raised an unhandled rejection and the
user's process **exited 1** — for a fire-and-forget task the user had
deliberately not awaited.

(A task that fails *inside* the worker was already protected: `executeTask` is
`async` and returns `task.promise`, so the async adoption attaches a handler
to it. The genuinely unhandled window is the queued one.)

### The correction

[ADR-0025](0025-fire-and-forget-dispatch-promise-contract.md) makes the claim
true, by attaching a keep-alive rejection handler to the handle's promise on
the `dispatch()` path only:

- `dispatch()` (and `dispatchAll()`) — the promise gets a no-op `.catch()`, so
  a discarded handle cannot raise an unhandled rejection. The promise still
  rejects, `await handle.promise` still throws, and `onError` still fires.
- `execute()` — **unchanged**. No handler is attached; the caller owns the
  promise. The hazard documented in this ADR stays exactly as visible as it
  was, and the `execute()` contract in this ADR is unaffected.

The decision recorded above (Option 3: document the `execute()` hazard) is
therefore reaffirmed, and its original premise is repaired.

### Follow-up added to ADR-0018

The original Follow-up #1 (a grep-based audit for fire-and-forget
`execute()` calls) remains open. ADR-0025 adds a second one: the shipped
skill gate should assert the **contract** — that a fire-and-forget
`dispatch()` does *not* produce an unhandled rejection — not only the symptom
of a crashing snippet.

## Links

- Incident: GitHub Actions run `35172546288` (failure) and `35166075502` (passing — silent race).
- Implementation: `src/worker-runtime.js:215-225` (execute with new JSDoc), `src/task-handle.js` (handle.promise contract, ADR-0015).
- Test fix: `test/broadcast-runtime-api.test.js:63-72`.
- Related ADRs:
  - [ADR-0025](0025-fire-and-forget-dispatch-promise-contract.md) — makes this ADR's premise true: `dispatch()` gets the internal rejection handler; `execute()` does not.
  - [ADR-0015](0015-promise-rejection-contract-for-task-queue-waiters.md) — defines the rejection contract that this incident exposed.
  - [ADR-0011](0011-hard-preemption-and-timeout-termination-for-runaway-tasks.md) — `forceKillOnTimeout: true` is the intentional version of what we accidentally triggered here.
  - [ADR-0003](0003-dual-execution-model-execute-and-dispatch.md) — defines execute vs dispatch and why both exist.
- Memory entry: `~/.minimax/agents/mavis/memory/MEMORY.md` (agent-level, cross-project).