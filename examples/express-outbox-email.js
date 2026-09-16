/**
 * Example: Transactional Outbox Pattern with Persistent Worker Runtime
 *
 * Demonstrates how to handle a user registration endpoint:
 * 1. Save user to database (simulated)
 * 2. Save outbox record
 * 3. Return HTTP 201 Created immediately (in ~3ms)
 * 4. Dispatch email and 30-day trial provisioning to background worker threads
 * 5. Update outbox record asynchronously upon completion
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
      const user = { id: Date.now(), ...userData };
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
        console.log(`[DB OUTBOX] Record #${id} updated to status: ${status}`);
      }
    },
  };

  // Simulating an incoming HTTP POST /register handler
  async function handleRegisterRequest(requestBody) {
    const start = performance.now();

    // Step 1: Atomic Database Write
    const { user, outbox1, outbox2 } = await db.saveUserAndOutbox(requestBody);

    // Step 2: Non-blocking dispatch to worker threads (takes microseconds!)
    const emailTask = runtime.dispatch({
      type: 'send_email',
      payload: { outboxId: outbox1.id, to: user.email, name: user.name },
      retries: 2, // Automatic retries with exponential backoff on failure
      fn: async (p) => {
        // Simulates rendering heavy HTML email template & network send
        return { messageId: `msg_${Date.now()}`, sentTo: p.to };
      },
    });

    const trialTask = runtime.dispatch({
      type: 'provision_trial',
      payload: { outboxId: outbox2.id, userId: user.id, days: 30 },
      fn: async (p) => {
        // Simulates calling external licensing microservice
        return { licenseKey: `lic_${p.userId}_30d`, expiresAt: Date.now() + 30 * 86400000 };
      },
    });

    // Step 3: Wire asynchronous confirmations to update Outbox
    emailTask.onComplete(async (result) => {
      await db.updateOutbox(outbox1.id, 'COMPLETED', result);
    });
    emailTask.onError(async (err) => {
      await db.updateOutbox(outbox1.id, 'FAILED', { error: err.message });
    });

    trialTask.onComplete(async (result) => {
      await db.updateOutbox(outbox2.id, 'COMPLETED', result);
    });
    trialTask.onError(async (err) => {
      await db.updateOutbox(outbox2.id, 'FAILED', { error: err.message });
    });

    const httpDuration = performance.now() - start;

    // Step 4: Responds to HTTP client immediately!
    console.log(`[HTTP 201 Created] Returned to client in ${httpDuration.toFixed(2)}ms!`);
    return {
      status: 201,
      body: { success: true, userId: user.id },
    };
  }

  // Trigger simulated request
  await handleRegisterRequest({ name: 'Alice Cooper', email: 'alice@example.com' });

  // Wait a moment for background workers to finish
  await new Promise((r) => setTimeout(r, 100));

  await runtime.shutdown();
  console.log('\n--- Example Finished Cleanly ---');
}

main().catch(console.error);
