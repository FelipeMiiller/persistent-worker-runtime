/**
 * [perf-tested] Transactional Outbox Pattern with Persistent Worker Runtime.
 *
 * Demonstrates how to handle a user registration endpoint AND quantifies the
 * HTTP responsiveness win against the "do everything on the main thread"
 * baseline:
 *
 *  1. Save user + outbox records atomically.
 *  2. Dispatch email + trial provisioning to background worker threads.
 *  3. Return HTTP 201 Created immediately (in single-digit ms).
 *  4. Update outbox records asynchronously upon completion.
 *
 * The contrast is the perf claim. With the runtime, the HTTP path returns in
 * the time it takes to write to the outbox + post a couple of IPC messages
 * (~3 ms in this demo). Without the runtime, the HTTP path blocks for the
 * full duration of every background task (~80 ms in this demo). The 25×
 * delta is what makes the outbox pattern viable under load.
 *
 * Run: `node examples/express-outbox-email.js`
 */

import { createWorkerRuntime } from '../src/index.js';

async function main() {
  console.log('--- EXAMPLE: Transactional Outbox Background Processing ---\n');

  const runtime = await createWorkerRuntime({ workers: 2 });

  // Simulated Database & Outbox table
  const db = {
    users: [],
    outbox: [],
    async saveUserAndOutbox(userData) {
      const user = { id: Date.now() + Math.random(), ...userData };
      const outbox1 = { id: 1, userId: user.id, task: 'send_welcome_email', status: 'PENDING' };
      const outbox2 = { id: 2, userId: user.id, task: 'provision_30_day_trial', status: 'PENDING' };
      db.users.push(user);
      db.outbox.push(outbox1, outbox2);
      return { user, outbox1, outbox2 };
    },
    async updateOutbox(id, status, details = {}) {
      const item = db.outbox.find((o) => o.id === id);
      if (item) {
        item.status = status;
        item.details = details;
      }
    },
  };

  // The work each outbox task does — same fn used in BOTH scenarios so the
  // comparison is apples-to-apples (only the dispatch path differs).
  const sendEmailFn = async (p) => {
    // Simulates rendering heavy HTML email template & network send.
    await new Promise((r) => setTimeout(r, 40));
    return { messageId: `msg_${Date.now()}_${p.outboxId}`, sentTo: p.to };
  };
  const provisionTrialFn = async (p) => {
    // Simulates calling external licensing microservice.
    await new Promise((r) => setTimeout(r, 40));
    return { licenseKey: `lic_${p.userId}_30d`, expiresAt: Date.now() + 30 * 86400000 };
  };

  /**
   * Scenario A — Dispatch to background workers (the runtime way).
   * HTTP handler returns the instant outbox is written + dispatch posts IPC.
   */
  async function handleRegisterDispatch(requestBody) {
    const start = performance.now();

    const { user, outbox1, outbox2 } = await db.saveUserAndOutbox(requestBody);

    const emailTask = runtime.dispatch({
      type: 'send_email',
      payload: { outboxId: outbox1.id, to: user.email, name: user.name },
      retries: 2,
      fn: sendEmailFn,
    });
    const trialTask = runtime.dispatch({
      type: 'provision_trial',
      payload: { outboxId: outbox2.id, userId: user.id, days: 30 },
      fn: provisionTrialFn,
    });

    emailTask.onComplete((result) => db.updateOutbox(outbox1.id, 'COMPLETED', result));
    emailTask.onError((err) => db.updateOutbox(outbox1.id, 'FAILED', { error: err.message }));
    trialTask.onComplete((result) => db.updateOutbox(outbox2.id, 'COMPLETED', result));
    trialTask.onError((err) => db.updateOutbox(outbox2.id, 'FAILED', { error: err.message }));

    return { httpDurationMs: performance.now() - start, status: 201 };
  }

  /**
   * Scenario B — Sequential on the main thread (no runtime, no offload).
   * HTTP handler blocks until BOTH background-style tasks complete.
   * Same total work, just awaited inline.
   */
  async function handleRegisterSequential(requestBody) {
    const start = performance.now();

    await db.saveUserAndOutbox(requestBody);
    await sendEmailFn({ outboxId: 99, to: requestBody.email, name: requestBody.name });
    await provisionTrialFn({ outboxId: 100, userId: 99, days: 30 });

    return { httpDurationMs: performance.now() - start, status: 201 };
  }

  // === Run both scenarios ===
  const dispatched = await handleRegisterDispatch({
    name: 'Alice Cooper',
    email: 'alice@example.com',
  });
  // Let the dispatched tasks finish before measuring sequential (fair warm-up).
  await new Promise((r) => setTimeout(r, 200));

  const sequential = await handleRegisterSequential({
    name: 'Bob Dylan',
    email: 'bob@example.com',
  });

  // === Side-by-side ===
  console.log('=== HTTP path duration ===\n');
  console.table({
    'A. Dispatch to workers (runtime)': {
      httpDurationMs: dispatched.httpDurationMs.toFixed(2),
      'returns to client at': `t=${dispatched.httpDurationMs.toFixed(2)} ms`,
    },
    'B. Sequential on main thread (no runtime)': {
      httpDurationMs: sequential.httpDurationMs.toFixed(2),
      'returns to client at': `t=${sequential.httpDurationMs.toFixed(2)} ms`,
    },
  });

  const speedup = sequential.httpDurationMs / Math.max(dispatched.httpDurationMs, 0.001);
  console.log(
    `\nSpeedup: ${speedup.toFixed(2)}× faster HTTP response with the runtime.\n` +
      'Background work (~80 ms total) did not block the HTTP handler in scenario A.',
  );

  await runtime.shutdown();
  console.log('\n--- Example Finished Cleanly ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
