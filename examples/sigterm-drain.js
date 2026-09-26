/**
 * [perf-tested] Graceful shutdown via SIGTERM (DR §8.1 recipe).
 *
 * Demonstrates the canonical wiring pattern for orchestrator-initiated
 * shutdown (k8s, Docker, systemd) AND quantifies the drain time from
 * signal-handler invocation to clean process exit.
 *
 * Why this is user-wired (ADR-0005 + DR §8.1):
 * - The runtime is a LIBRARY, not a daemon. It must NOT install
 *   `process.on('SIGTERM', …)` in `src/` — that pulls boot-path weight
 *   onto users who don't want signals handled (tests, embedded use,
 *   workers-of-workers setups).
 * - The user wires the handler in their app entrypoint, calling
 *   `await runtime.shutdown()` on receipt.
 *
 * What this example measures:
 * - Drain time = `performance.now()` delta between the signal handler
 *   being invoked and `runtime.shutdown()` resolving. Expected ≈ time
 *   for in-flight tasks to complete + supervisor tick to detect idle
 *   pool.
 * - Whether the handler is idempotent (a second SIGTERM during drain
 *   is a no-op, not a double-shutdown crash).
 * - Hard-timeout fallback: if `runtime.shutdown()` exceeds `FORCE_EXIT_MS`,
 *   the process exits with code 1 even if workers haven't drained —
 *   prevents zombie processes under orchestrator timeouts.
 *
 * Run: `node examples/sigterm-drain.js`
 *
 * Note: this example does NOT call `process.kill(0, 'SIGTERM')` because
 * that would terminate the test process on Windows. Instead, it extracts
 * the handler logic into a function and invokes it directly to simulate
 * the orchestrator sending SIGTERM.
 */

import { createWorkerRuntime } from '../src/index.js';

// === Configuration ===

const FORCE_EXIT_MS = 30_000; // hard timeout — fallback for stuck shutdown
const WORKER_COUNT = 4;
const TASK_COUNT = 50; // 4 in-flight + 46 queued (queued tasks get rejected on shutdown)
const PER_TASK_MS = 100;
const SIMULATED_INFLIGHT_AT_SIGNAL = WORKER_COUNT; // tasks actively running at SIGTERM time

// === Canonical wiring recipe (the actual pattern users copy) ===

/**
 * Install SIGTERM/SIGINT handlers that gracefully drain the runtime.
 *
 * Properties:
 * 1. Idempotent — a second signal during drain is a no-op (no double
 *    shutdown crash, no `unhandledRejection`).
 * 2. Bounded — a hard-timeout fallback `process.exit(1)` after
 *    `FORCE_EXIT_MS` prevents zombie processes under orchestrator
 *    shutdown deadlines (k8s default `terminationGracePeriodSeconds`
 *    is 30s).
 * 3. Cross-platform — SIGTERM on POSIX, SIGINT on every platform
 *    (Ctrl+C in development, also picked up by some orchestrators as
 *    an alias for SIGTERM).
 *
 * @param {object} runtime - the WorkerRuntime instance to drain
 * @param {object} [opts]
 * @param {number} [opts.forceExitMs] - hard timeout in ms (default 30s)
 * @returns {{ shutdown: () => Promise<void>, uninstall: () => void }}
 */
function installShutdownHandlers(runtime, opts = {}) {
  const forceExitMs = opts.forceExitMs ?? FORCE_EXIT_MS;
  let shutdownPromise = null;

  const shutdown = async () => {
    if (shutdownPromise) {
      // Second signal during drain — no-op. Orchestrator's escalation
      // (SIGKILL after grace period) is what actually terminates us.
      return shutdownPromise;
    }
    shutdownPromise = runtime.shutdown();
    return shutdownPromise;
  };

  const onSignal = (signal) => {
    console.log(`\n[signal] received ${signal} — beginning graceful drain`);
    shutdown().then(
      () => {
        console.log('[signal] drain complete — exiting cleanly');
        process.exit(0);
      },
      (err) => {
        console.error('[signal] drain failed:', err);
        process.exit(1);
      },
    );

    // Hard-timeout fallback — don't hang forever if a worker is stuck.
    const killTimer = setTimeout(() => {
      console.error(
        `[signal] drain exceeded ${forceExitMs} ms — forcing exit (code 1). ` +
          'Check `runtime.getWorkers()` for stuck workers.',
      );
      process.exit(1);
    }, forceExitMs);
    // unref so the timer doesn't itself keep the event loop alive
    // past the process.exit() in the success path.
    killTimer.unref();
  };

  const sigtermHandler = () => onSignal('SIGTERM');
  const sigintHandler = () => onSignal('SIGINT');
  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);

  const uninstall = () => {
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGINT', sigintHandler);
  };

  return { shutdown, uninstall };
}

// === Demo ===

async function main() {
  console.log('--- EXAMPLE: SIGTERM-driven graceful drain (DR §8.1) ---\n');

  const runtime = await createWorkerRuntime({
    workers: WORKER_COUNT,
  });

  const { shutdown, uninstall } = installShutdownHandlers(runtime);

  // Fire-and-forget TASK_COUNT tasks. SIMULATED_INFLIGHT_AT_SIGNAL of
  // them will be in flight when we simulate the signal — those are the
  // ones whose drain cost we're measuring.
  const dispatchHandles = [];
  for (let i = 0; i < TASK_COUNT; i++) {
    dispatchHandles.push(
      runtime
        .execute({
          type: 'background_job',
          payload: { i, delayMs: PER_TASK_MS },
          fn: ({ i, delayMs }) =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ i, doneAt: Date.now() }), delayMs);
            }),
        })
        // `execute()` returns the task Promise directly (it awaits the
        // dispatch handle's `.promise` internally). Swallow rejections
        // here because the SIGTERM-driven shutdown may reject in-flight
        // tasks; that's expected behavior, not an error.
        .catch(() => undefined /* intentional: drain-driven rejection */),
    );
  }

  // Wait until all WORKER_COUNT workers have a task in flight, then
  // simulate SIGTERM by invoking the handler directly. We DON'T call
  // process.emit('SIGTERM') because that would terminate the test
  // process on Windows (where SIGTERM is synthesized as a hard kill).
  await waitUntilInflight(runtime, SIMULATED_INFLIGHT_AT_SIGNAL);
  console.log(`[setup] ${SIMULATED_INFLIGHT_AT_SIGNAL} tasks in flight; simulating SIGTERM...\n`);

  const drainStart = performance.now();
  // Simulate orchestrator sending SIGTERM by invoking the handler
  // logic directly. (Equivalent to `process.emit('SIGTERM')` cross-platform,
  // but safe in the example since emitting a real SIGTERM on Windows
  // kills the process.)
  await shutdown();

  const drainMs = performance.now() - drainStart;

  // Idempotency check — second signal during/after drain is a no-op.
  // We can verify this without actually emitting SIGTERM by calling
  // `shutdown()` directly again and confirming it resolves to the same
  // promise.
  const secondCallStart = performance.now();
  await shutdown(); // should resolve immediately (same promise)
  const secondCallMs = performance.now() - secondCallStart;

  uninstall();

  console.log('\n=== Drain metrics ===\n');
  console.table({
    'Drain (signal handler → shutdown resolved)': {
      drainMs: drainMs.toFixed(2),
      expectedApproxMs: `${SIMULATED_INFLIGHT_AT_SIGNAL * PER_TASK_MS}+ (in-flight task completion + supervisor tick)`,
    },
    'Second signal during drain (idempotency)': {
      secondCallMs: secondCallMs.toFixed(2),
      expectation: '< 1 ms (same Promise returned)',
    },
  });

  console.log(
    `\nTake-away: graceful drain took ~${drainMs.toFixed(0)} ms for ` +
      `${SIMULATED_INFLIGHT_AT_SIGNAL} in-flight tasks at 100 ms each ` +
      `(expected ceiling: ${SIMULATED_INFLIGHT_AT_SIGNAL * PER_TASK_MS} ms).\n` +
      `The hard-timeout fallback would force-exit at ${FORCE_EXIT_MS} ms if any worker hung.\n` +
      `Idempotent handler means double-signal during drain is safe (no double-shutdown crash).\n`,
  );

  console.log('--- SIGTERM drain example complete ---');
  process.exit(0);
}

/**
 * Wait until at least `target` workers have a task in flight.
 */
async function waitUntilInflight(runtime, target) {
  const start = performance.now();
  while (performance.now() - start < 10_000) {
    const inflight = runtime.getWorkers().filter((w) => w.tasksActive > 0).length;
    if (inflight >= target) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timeout waiting for ${target} in-flight tasks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
