/**
 * test/dispatch-promise-contract.test.js
 *
 * ADR-0025 — the `dispatch()` promise contract.
 *
 * Before ADR-0025 the published contract was a lie. `dispatch()`'s JSDoc and
 * ADR-0018 both promised that `TaskHandle.promise` had a `.catch()` attached
 * internally, so a fire-and-forget `dispatch()` was "safe". It was not:
 * `src/task-handle.js` never attached one. The observable consequence was that
 * `shutdown()` → `queue.destroy()` → rejected queued tasks → unhandled
 * rejection → the user's process exited 1.
 *
 * ADR-0025 makes the promise TRUE for `dispatch()` (a keep-alive handler is
 * attached to the handle's promise) while deliberately KEEPING the hazard
 * VISIBLE for `execute()` — ADR-0018's Option 3 is not undone.
 *
 * ── Where the hazard actually lives ─────────────────────────────────────────
 *
 * The runtime already does `worker.executeTask(task).catch(...)`
 * (`src/worker-runtime.js`), and `WorkerHandle.executeTask` is `async` and
 * returns `task.promise` — so the async adoption attaches a rejection handler
 * to `task.promise` as soon as the task REACHES A WORKER. A task that fails
 * inside the worker is therefore already protected by the runtime's own
 * wiring, and the keep-alive changes nothing for it.
 *
 * The window where `task.promise` is genuinely unhandled is while the task is
 * still QUEUED — exactly the issue-008 scenario:
 *
 *   - `shutdown()` → `queue.destroy()` → `task.reject(reason)` for every
 *     queued task, with nobody holding the promise;
 *   - a task aborted before it ever reached a worker (same shape: the handle
 *     is rejected while queued).
 *
 * The tests below cover both shapes, plus the `execute()` hazard, which is
 * asserted in a CHILD PROCESS — in-process it would be turned into a test
 * failure by the test runner's own `unhandledRejection` listener.
 *
 * The in-process tests are the regression guard: without the keep-alive they
 * observe the unhandled rejection (and the child process crashes).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkerRuntime } from '../src/index.js';
import * as common from './common.js';

const SRC_INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));

/**
 * Polls `predicate` until it returns true or the budget expires.
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true when the predicate became true in time.
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await common.sleep(10);
  }
  return predicate();
}

/**
 * Runs a child script under a hard wall-clock budget.
 *
 * The child MUST NOT register an `unhandledRejection` listener: the default
 * Node behaviour (raise the rejection as an uncaught exception, exit 1) is
 * exactly what these tests assert on.
 *
 * @param {string} scriptPath Absolute path to the child script.
 * @param {number} [timeoutMs]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runChild(scriptPath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, PWR_SRC_INDEX: SRC_INDEX },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * A task that is rejected BEFORE it reaches a worker — the shape of the
 * issue-008 failure. `TaskHandle`'s constructor rejects a pre-aborted signal
 * synchronously, so the handle's promise is rejected while the task is still
 * queued and nobody holds it.
 */
function queuedRejectionTask(type) {
  return {
    type,
    fn: () => 'never-runs',
    signal: AbortSignal.abort(),
  };
}

// ─── Child scripts ───────────────────────────────────────────────────────────
//
// The runtime module is injected through the PWR_SRC_INDEX env var: a Windows
// absolute path is not a valid ESM specifier on its own.

const CHILD_DISPATCH_THEN_SHUTDOWN = `
import { pathToFileURL } from 'node:url';

const { createWorkerRuntime } = await import(pathToFileURL(process.env.PWR_SRC_INDEX).href);
const runtime = await createWorkerRuntime({ workers: 1 });

// Fire-and-forget. The task is still QUEUED when shutdown() runs, so
// queue.destroy() rejects it — the issue-008 scenario, verbatim.
runtime.dispatch({
  type: 'pwr-child-queued',
  fn: () => 'never-runs',
});

await runtime.shutdown();

setTimeout(() => {
  console.log('PWR_CHILD_SURVIVED');
  process.exit(0);
}, 500);
`;

const CHILD_EXECUTE_UNHANDLED = `
import { pathToFileURL } from 'node:url';

const { createWorkerRuntime } = await import(pathToFileURL(process.env.PWR_SRC_INDEX).href);
const runtime = await createWorkerRuntime({ workers: 1 });

runtime.execute({
  type: 'pwr-child-boom',
  fn: () => {
    throw new Error('pwr-child-boom');
  },
});
// Intentionally NOT awaited and NOT .catch()-handled.

setTimeout(() => {
  // Reaching this line means the rejection was swallowed — the ADR-0018
  // hazard was masked, which would be a contract violation.
  console.error('PWR_CHILD_NO_CRASH');
  process.exit(0);
}, 15000);
`;

describe('dispatch() promise contract — in-process (ADR-0025)', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 1 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('does NOT raise an unhandled rejection for a fire-and-forget dispatch() rejected while queued', async () => {
    const rejections = [];
    const onUnhandledRejection = (reason) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const handle = runtime.dispatch(queuedRejectionTask('pwr-dispatch-queued'));

      let onErrorError = null;
      handle.onError((err) => {
        onErrorError = err;
      });

      // The task really has to fail, otherwise the assertion below is vacuous.
      const settled = await waitFor(() => handle.isSettled, 5000);
      assert.ok(settled, 'the dispatched task must settle within 5s');

      // Give Node the chance to report an unhandled rejection, if there is one.
      await common.sleep(250);

      assert.ok(onErrorError, 'onError must have fired — the task must have failed');
      assert.deepEqual(
        rejections,
        [],
        'a rejected fire-and-forget dispatch() must not raise an unhandled rejection',
      );
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('still rejects handle.promise with the very same error (the failure is not swallowed)', async () => {
    const handle = runtime.dispatch(queuedRejectionTask('pwr-dispatch-promise'));

    let onErrorError = null;
    handle.onError((err) => {
      onErrorError = err;
    });

    let promiseError = null;
    try {
      await handle.promise;
    } catch (err) {
      promiseError = err;
    }

    assert.ok(promiseError, 'await handle.promise must reject');
    assert.match(promiseError.message, /Task aborted before execution/);
    assert.ok(onErrorError, 'onError must have fired');
    assert.equal(
      promiseError,
      onErrorError,
      'the promise and onError must report the same error instance',
    );
  });

  it('still calls onError with the task error', async () => {
    const handle = runtime.dispatch(queuedRejectionTask('pwr-dispatch-onerror'));

    const errors = [];
    handle.onError((err) => {
      errors.push(err);
    });

    const settled = await waitFor(() => handle.isSettled, 5000);
    assert.ok(settled, 'the dispatched task must settle within 5s');
    await common.sleep(50);

    assert.equal(errors.length, 1, 'onError must fire exactly once');
    assert.match(errors[0].message, /Task aborted before execution/);
  });

  it('keeps reporting a task that fails INSIDE the worker through onError and handle.promise', async () => {
    // The runtime already protects this path (the worker's own wiring adopts
    // `task.promise`), but the contract must hold here too: the failure is
    // never swallowed, whichever path produced it.
    const handle = runtime.dispatch({
      type: 'pwr-dispatch-worker-failure',
      fn: () => {
        throw new Error('pwr-dispatch-worker-failure');
      },
    });

    let onErrorError = null;
    handle.onError((err) => {
      onErrorError = err;
    });

    const settled = await waitFor(() => handle.isSettled, 5000);
    assert.ok(settled, 'the dispatched task must settle within 5s');
    await common.sleep(50);

    assert.ok(onErrorError, 'onError must have fired');
    assert.match(onErrorError.message, /pwr-dispatch-worker-failure/);
    await assert.rejects(() => handle.promise, /pwr-dispatch-worker-failure/);
  });

  it('dispatchAll() inherits the fire-and-forget protection', async () => {
    const rejections = [];
    const onUnhandledRejection = (reason) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const handles = runtime.dispatchAll([
        queuedRejectionTask('pwr-dispatch-all-1'),
        queuedRejectionTask('pwr-dispatch-all-2'),
      ]);

      const errors = [];
      for (const handle of handles) {
        handle.onError((err) => {
          errors.push(err);
        });
      }

      const settled = await waitFor(() => handles.every((h) => h.isSettled), 5000);
      assert.ok(settled, 'every dispatched task must settle within 5s');
      await common.sleep(250);

      assert.equal(errors.length, 2, 'both onError callbacks must fire');
      assert.deepEqual(
        rejections,
        [],
        'dispatchAll() must not raise an unhandled rejection either',
      );
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('dispatch()/execute() promise contract — child process (ADR-0025)', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pwr-dispatch-contract-'));
    writeFileSync(
      join(tmpDir, 'child-dispatch-then-shutdown.mjs'),
      CHILD_DISPATCH_THEN_SHUTDOWN,
      'utf8',
    );
    writeFileSync(join(tmpDir, 'child-execute-unhandled.mjs'), CHILD_EXECUTE_UNHANDLED, 'utf8');
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a fire-and-forget dispatch() rejected by shutdown() does NOT crash the process', async () => {
    const child = await runChild(join(tmpDir, 'child-dispatch-then-shutdown.mjs'));

    assert.equal(
      child.code,
      0,
      `expected exit code 0; stdout=${child.stdout}\nstderr=${child.stderr}`,
    );
    assert.match(child.stdout, /PWR_CHILD_SURVIVED/, 'the child must reach its clean exit');
    assert.doesNotMatch(
      child.stderr,
      /triggerUncaughtException/,
      'the queued dispatch() must not become an unhandled rejection',
    );
  });

  it('execute() without await/.catch() still crashes the process (ADR-0018 hazard preserved)', async () => {
    const child = await runChild(join(tmpDir, 'child-execute-unhandled.mjs'));

    assert.notEqual(
      child.code,
      0,
      `expected a non-zero exit code; stdout=${child.stdout}\nstderr=${child.stderr}`,
    );
    assert.match(child.stderr, /pwr-child-boom/, 'the crash must be the task rejection');
    assert.doesNotMatch(
      child.stderr,
      /PWR_CHILD_NO_CRASH/,
      'the rejection must not have been swallowed',
    );
  });
});
