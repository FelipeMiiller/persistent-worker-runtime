# Agent Handover Guide: Persistent Worker Runtime

> **Audience**: AI Coding Agents (Antigravity, Claude Code, Cursor, Windsurf, Copilot) or engineers starting a new chat/session on this repository.
> **Last Updated**: 2026-09-16
> **Active Branch**: `develop`

---

## 🎯 1. Project Overview & Context

- **Repository**: `https://github.com/FelipeMiiller/persistent-worker-runtime`
- **Local Path**: `c:\repository\persistent-worker-runtime`
- **NPM Package**: `persistent-worker-runtime` (version `0.1.0` live on registry)
- **Goal**: Build a high-performance persistent worker runtime for Node.js over native `worker_threads`, keeping the Event Loop 100% dedicated to non-blocking I/O while persistent workers execute CPU-bound tasks and transactional outbox background jobs with warm L1 heaps.
- **Node.js Core Target**: Designed as a zero-dependency reference implementation proposed for inclusion into Node.js core stdlib (`node:worker_threads`).

---

## 🔒 2. Non-Negotiable Operational Rules

1. **Active Branch**: All work is conducted directly on the **`develop`** branch.
   - **`main` is protected**: Never commit directly to `main`. Releases are merged via PRs from `develop`.
2. **Zero External Dependencies**: `package.json` has `dependencies: {}`. Do NOT install external runtime npm packages under any circumstances. Everything must use standard Node.js built-ins (`node:worker_threads`, `node:test`, `node:events`, `node:async_hooks`, `node:perf_hooks`).
3. **Language**: **100% English** across all code, docstrings, tests, ADRs, specs, and commit messages.
4. **Testing Gate**: Every single task must have tests. All tests (`npm test`) must pass with 100% approval before making any commit.
5. **Atomic Conventional Commits**: Commit each task atomically (`feat:`, `fix:`, `test:`, `docs:`).

---

## 📍 3. Current State & Where to Start

### What was completed in the previous session:
1. Initial version `v0.1.0` built, tested (13/13 passing tests, >80% coverage), tagged, released, and published to NPM.
2. 5 enterprise Architecture Decision Records (ADRs) were created, reviewed, and committed to `develop`:
   - [`ADR-0010: Automatic Worker Recycling and Heap Rejuvenation`](docs/adr/0010-automatic-worker-recycling-anti-memory-leak.md)
   - [`ADR-0011: Hard Preemption and Thread Termination for Runaway Tasks`](docs/adr/0011-hard-preemption-and-timeout-termination-for-runaway-tasks.md)
   - [`ADR-0012: Streaming Task Results via Async Generators and Structured IPC`](docs/adr/0012-streaming-task-results-via-async-generators.md)
   - [`ADR-0013: Worker Inter-Communication via Native BroadcastChannel`](docs/adr/0013-worker-inter-communication-via-broadcast-channel.md)
   - [`ADR-0014: Adaptive Concurrency Auto-Tuning via Event Loop Utilization (ELU)`](docs/adr/0014-adaptive-concurrency-auto-tuning-via-event-loop-utilization.md)
3. The specification and task breakdown for the **FIRST feature (ADR-0010)** was created and strictly validated:
   - **Spec**: [`.specs/features/worker-recycling/spec.md`](.specs/features/worker-recycling/spec.md) (Validated: 0 errors, 0 warnings)
   - **Tasks**: [`.specs/features/worker-recycling/tasks.md`](.specs/features/worker-recycling/tasks.md) (Validated: 0 errors, 0 warnings)
   - **State Snapshot**: [`.specs/STATE.md`](.specs/STATE.md) (Decisions AD-001 to AD-014 logged)

---

## 🚀 4. Exact Next Action for the New Chat

**Your immediate goal**: Implement **Phase 1: Worker Recycling (ADR-0010)** following the tasks defined in [`.specs/features/worker-recycling/tasks.md`](.specs/features/worker-recycling/tasks.md).

### Step-by-Step Execution Plan:

1. **Verify Baseline**:
   ```bash
   git status
   npm test
   ```
   Confirm you are on `develop` and all 13 tests pass.

2. **Execute Task T1** (`src/worker-runtime.js`):
   - Add `maxTasksPerWorker` (default `Infinity`) and `maxMemoryMb` (default `Infinity`) to `WorkerRuntime` constructor options.
   - Validate options (must be positive numbers or `Infinity`, throw `TypeError` or `RangeError` on invalid values).
   - Pass options down to `Supervisor`.
   - Write unit tests in `test/recycling.test.js`.
   - Run `npm test`. Commit: `feat(runtime): add maxTasksPerWorker and maxMemoryMb configuration and validation`.

3. **Execute Task T2** (`src/worker-thread-entry.js`):
   - In worker thread task completion handler, sample heap usage via `process.memoryUsage().heapUsed`.
   - Return `{ memoryUsageBytes }` in the task completion IPC message payload.
   - Run `npm test`. Commit: `feat(worker): report memory usage on task completion in worker thread`.

4. **Execute Task T3** (`src/worker-handle.js`):
   - Add `'recycling'` status to `WorkerHandle`.
   - Ensure `isIdle` returns `false` when status is `'recycling'`.
   - Add `markRecycling()` and `isRecycling` getter.
   - Record last sampled memory usage.
   - Run `npm test`. Commit: `feat(worker-handle): add recycling state and lifecycle checks`.

5. **Execute Task T4** (`src/supervisor.js`):
   - In `Supervisor`, check `maxTasksPerWorker` and `maxMemoryMb` after each task completes.
   - If exceeded:
     - Mark worker as recycling via `worker.markRecycling()`.
     - Emit `worker_recycling` event with `{ workerId, reason, tasksCompleted, memoryUsage }`.
     - Spawn a replacement worker to maintain pool capacity.
     - Once replacement is ready and current task is settled, terminate the old worker via `worker.terminate()`.
     - Emit `worker_recycled` event with `{ oldWorkerId, newWorkerId }`.
   - Write integration test verifying zero dropped tasks during recycling under concurrent load.
   - Run `npm test`. Commit: `feat(supervisor): implement graceful worker recycling and replacement`.

6. **Execute Task T5** (`src/index.d.ts` & `src/worker-runtime.js`):
   - Expose cumulative `recycledWorkersCount` in `runtime.stats()`.
   - Update `src/index.d.ts` with all new types, options, events, and stats properties.
   - Run full suite and coverage:
     ```bash
     npm test
     npm run test:coverage
     ```
   - Commit: `feat(types): expose recycling telemetry and update TypeScript declarations`.

7. **Push and Proceed**:
   - Once all 5 tasks pass and are committed, push to `develop`:
     ```bash
     git push origin develop
     ```
   - Proceed to feature 2 (**ADR-0011: Hard Preemption Watchdog**).

---

## 🛠 5. Useful Verification Commands

```bash
# Run unit and integration tests
npm test

# Run code coverage (>80% required)
npm run test:coverage

# Run benchmarks
npm run benchmark:all

# Validate spec.md structure (Python 3)
python <skill-dir>/scripts/validate_spec.py .specs/features/worker-recycling/spec.md --root .

# Validate tasks.md structure (Python 3)
python <skill-dir>/scripts/validate_tasks.py .specs/features/worker-recycling/tasks.md --root .
```
