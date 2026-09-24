/**
 * [perf-tested] EventTarget observation patterns.
 *
 * Since v0.3.x, the runtime extends web-standard `EventTarget` (not Node's
 * `EventEmitter`). All runtime events (`stream:*`, `worker:*`, `task:*`)
 * dispatch as `CustomEvent` with the original payload on `event.detail`.
 *
 * This example shows three patterns for observing events, in order of
 * recommendation, AND quantifies the cleanup cost difference between
 * pattern 1 (`{ signal }`) and pattern 3 (manual `removeEventListener`):
 *
 *   1. `addEventListener(name, fn, { signal })` — RECOMMENDED. AbortSignal
 *      removes ALL listeners on this signal atomically. O(N) listeners →
 *      1 `abort()` call. Same big-O as manual, but zero bookkeeping.
 *   2. Bounded-N event collector — small "collect N events then resolve"
 *      helper built on `addEventListener` + `AbortSignal`.
 *   3. `addEventListener` + `removeEventListener` — manual subscription.
 *      N listeners → N `removeEventListener` calls. Same big-O, more code.
 *
 * Backward compatibility: `.on()` / `.once()` / `.off()` / `.removeListener()`
 * / `.emit()` still work via the runtime's compat shim (see
 * `src/event-target-compat.js`). Prefer the new patterns for v0.3.x+ code;
 * shim is scheduled for removal in v0.4.x.
 *
 * Run: `node examples/event-target-pattern.js`
 */

import { createWorkerRuntime } from '../src/index.js';

const TASK_COUNT = 4;
const PER_TASK_MS = 60;

async function main() {
  console.log('--- EXAMPLE: EventTarget observation patterns ---\n');

  const runtime = await createWorkerRuntime({ workers: 1 });

  // ──────────────────────────────────────────────────────────────────────
  // Pattern 1 (RECOMMENDED): addEventListener with AbortSignal
  // ──────────────────────────────────────────────────────────────────────
  console.log('[pattern 1] addEventListener(name, fn, { signal }) — AbortController cleanup');
  const observerAbort = new AbortController();
  const task1Events = [];

  for (const eventName of ['task:completed', 'task:failed']) {
    runtime.addEventListener(
      eventName,
      (event) => {
        task1Events.push({ name: eventName, taskId: event.detail.taskId });
      },
      { signal: observerAbort.signal },
    );
  }

  const results = await runtime.executeAll(
    Array.from({ length: TASK_COUNT }, (_, i) => ({
      type: 'pattern1_task',
      payload: { i, delayMs: PER_TASK_MS },
      fn: ({ i, delayMs }) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(i * 10), delayMs);
        }),
    })),
  );
  console.log(`  [main] executeAll returned ${results.length} result(s)`);

  observerAbort.abort('demo-done');
  console.log(`  → observerAbort.abort() removed listener group atomically\n`);

  // ──────────────────────────────────────────────────────────────────────
  // Pattern 2: bounded-N event collector via addEventListener
  // ──────────────────────────────────────────────────────────────────────
  console.log('[pattern 2] "collect N events" via addEventListener + AbortSignal');
  function collectN(eventName, count) {
    return new Promise((resolve) => {
      const collected = [];
      const ac = new AbortController();
      const handler = (event) => {
        collected.push(event);
        if (collected.length >= count) {
          ac.abort();
          resolve(collected);
        }
      };
      runtime.addEventListener(eventName, handler, { signal: ac.signal });
    });
  }

  const collectorPromise = collectN('task:completed', 3);
  await runtime.executeAll(
    Array.from({ length: 3 }, (_, i) => ({
      type: 'pattern2_task',
      payload: { i, baseMs: 50 },
      fn: ({ i, baseMs }) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(i), baseMs + i * 20);
        }),
    })),
  );
  const collected = await collectorPromise;
  console.log(
    `  → collected ${collected.length} events; last taskId=${collected.at(-1).detail.taskId}\n`,
  );

  // ──────────────────────────────────────────────────────────────────────
  // Pattern 3: addEventListener + removeEventListener (manual)
  // ──────────────────────────────────────────────────────────────────────
  console.log('[pattern 3] addEventListener + removeEventListener (manual)');
  const seen = [];
  const handler = (event) => {
    seen.push(event.detail.taskId);
  };
  runtime.addEventListener('task:failed', handler);
  await runtime.execute({
    type: 'pattern3_ok',
    payload: {},
    fn: () => 'ok',
  });
  runtime.removeEventListener('task:failed', handler);
  console.log(`  → handler removed via removeEventListener\n`);

  // ──────────────────────────────────────────────────────────────────────
  // Backward-compat shim still works
  // ──────────────────────────────────────────────────────────────────────
  console.log('[backward-compat] .on() / .off() still work via compat shim (v0.4.x removal)');
  const shimCount = { count: 0 };
  const shimHandler = () => {
    shimCount.count++;
  };
  runtime.on('task:completed', shimHandler);
  await runtime.execute({ type: 'pattern4_done', payload: {}, fn: () => 'done' });
  runtime.off('task:completed', shimHandler);
  console.log(`  → .on() saw ${shimCount.count} task:completed event(s) before .off()\n`);

  // ──────────────────────────────────────────────────────────────────────
  // PART 2: Cleanup API surface — pattern 1 vs pattern 3 for N listeners
  // ──────────────────────────────────────────────────────────────────────
  // The perf claim of pattern 1 is API ergonomics, NOT wall-clock speed.
  // Both paths are O(N), but pattern 1 needs 1 call; pattern 3 needs N.
  // We cap LISTENER_COUNT at 10 because Node's EventTarget has a hard
  // limit of 10 per event name (no public API to raise it).
  console.log('=== Part 2: Cleanup API surface for N listeners ===\n');

  const LISTENER_COUNT = 10;

  // Pattern 1 — register N listeners with shared AbortSignal, abort once.
  const acPattern1 = new AbortController();
  for (let i = 0; i < LISTENER_COUNT; i++) {
    runtime.addEventListener(
      'task:completed',
      (_e) => {
        /* no-op */
      },
      { signal: acPattern1.signal },
    );
  }
  const tP1Start = performance.now();
  acPattern1.abort('demo');
  const pattern1Ms = performance.now() - tP1Start;

  // Pattern 3 — register N listeners, remove them one-by-one.
  const refsPattern3 = [];
  for (let i = 0; i < LISTENER_COUNT; i++) {
    refsPattern3.push((_e) => {
      /* no-op */
    });
    runtime.addEventListener('task:completed', refsPattern3.at(-1));
  }
  const tP3Start = performance.now();
  for (const ref of refsPattern3) {
    runtime.removeEventListener('task:completed', ref);
  }
  const pattern3Ms = performance.now() - tP3Start;

  console.log(`  ${LISTENER_COUNT} listeners:\n`);
  console.table({
    'Pattern 1 (AbortController.abort())': {
      cleanupMs: pattern1Ms.toFixed(3),
      apiCalls: 1,
    },
    'Pattern 3 (removeEventListener × N)': {
      cleanupMs: pattern3Ms.toFixed(3),
      apiCalls: LISTENER_COUNT,
    },
  });

  console.log(
    `\nPattern 1 removed ${LISTENER_COUNT} listeners with 1 call (${pattern1Ms.toFixed(3)} ms);\n` +
      `pattern 3 needed ${LISTENER_COUNT} calls (${pattern3Ms.toFixed(3)} ms).\n` +
      'The wall-clock is comparable — what differs is API surface area and leak risk.\n' +
      'Forgetting one `removeEventListener` in pattern 3 = permanent listener leak.',
  );

  await runtime.shutdown();
  console.log('\n--- EventTarget observation example complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
