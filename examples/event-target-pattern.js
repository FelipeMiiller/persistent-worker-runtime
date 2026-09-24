/**
 * Example: EventTarget observation patterns
 *
 * Since v0.3.x, the runtime extends web-standard `EventTarget` (not Node's
 * `EventEmitter`). All runtime events (`stream:*`, `worker:*`, `task:*`)
 * dispatch as `CustomEvent` with the original payload on `event.detail`.
 *
 * This example shows three patterns for observing events, in order of
 * recommendation:
 *
 *   1. `addEventListener(name, fn, { signal })` — the recommended web-standard
 *      pattern. Pass an `AbortSignal` to auto-remove the listener when the
 *      signal fires; no manual `removeEventListener` bookkeeping. Listener
 *      receives the full `CustomEvent` (read payload from `event.detail`).
 *
 *   2. Bounded-N event collector — `addEventListener` + AbortSignal wrapped
 *      in a small "collect N events then resolve" helper. Same idiomatic
 *      shape as `events.on()` async iteration, with predictable extraction
 *      semantics across both EventTarget and EventEmitter (the `on()`
 *      iterator yields tuples differently per target, which is easy to get
 *      wrong; this version is unambiguous).
 *
 *   3. `addEventListener` + `removeEventListener` — manual subscription.
 *      Useful when you need to detach a listener at a specific moment
 *      independent of an AbortSignal.
 *
 * Backward compatibility: `.on()` / `.once()` / `.off()` / `.removeListener()`
 * / `.emit()` still work via the runtime's compat shim (see
 * `src/event-target-compat.js`). Prefer the new patterns for v0.3.x+ code;
 * shim is scheduled for removal in v0.4.x.
 *
 * Run: `node examples/event-target-pattern.js`
 */

import { createWorkerRuntime } from '../src/index.js';

// === Configuration ===

const TASK_COUNT = 4;
const PER_TASK_MS = 60;

// === Main ===

async function main() {
  console.log('--- EXAMPLE: EventTarget observation patterns ---\n');

  const runtime = await createWorkerRuntime({ workers: 1 });

  // ──────────────────────────────────────────────────────────────────────
  // Pattern 1 (RECOMMENDED): addEventListener with AbortSignal
  //
  // Wire all task events to a single AbortController. Aborting removes
  // every listener atomically — no manual cleanup needed even if the
  // runtime outlives this scope.
  // ──────────────────────────────────────────────────────────────────────
  console.log('[pattern 1] addEventListener(name, fn, { signal }) — AbortController cleanup');

  const observerAbort = new AbortController();
  const task1Events = [];

  for (const eventName of ['task:completed', 'task:failed']) {
    runtime.addEventListener(
      eventName,
      (event) => {
        // Payload is on event.detail (CustomEvent convention).
        task1Events.push({ name: eventName, taskId: event.detail.taskId });
        console.log(`  [observer] ${eventName} — taskId=${event.detail.taskId}`);
      },
      { signal: observerAbort.signal }, // auto-remove on abort
    );
  }

  // Use executeAll for a Promise[] (so we can await completion) — the
  // events fire identically to dispatch() with onComplete().
  // NOTE: the worker reconstructs `fn` via `new Function(fnCode)` and does
  // NOT transport closure scope (see ADR-0012 + streaming-llm.js for the
  // same constraint). Constants like PER_TASK_MS must travel via payload.
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
  console.log(`  [main] executeAll returned ${results.length} result(s)\n`);

  // One line of cleanup — applies to ALL listeners registered with this signal.
  observerAbort.abort('demo-done');
  console.log(
    `  → observerAbort.abort() removed ${task1Events.length} listener call(s) atomically\n`,
  );

  // ──────────────────────────────────────────────────────────────────────
  // Pattern 2: bounded-N event collector via addEventListener
  //
  // `node:events.on()` is convenient but its event-extraction semantics
  // differ subtly between EventEmitter and EventTarget; for reliability
  // across both, build a small "collect N events" helper with
  // addEventListener + AbortSignal. Same idiomatic shape, no surprise
  // about whether yields are tuples or bare events.
  // ──────────────────────────────────────────────────────────────────────
  console.log('[pattern 2] "collect N events" via addEventListener + AbortSignal');

  /** @returns {Promise<CustomEvent[]>} resolves once `count` events have fired */
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
  const _dispatched = await runtime.executeAll(
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
  //
  // Use when you need to detach a specific listener at a specific moment
  // (not via AbortController). Keep a reference to the same function you
  // passed in — `removeEventListener` matches by reference.
  // ──────────────────────────────────────────────────────────────────────
  console.log('[pattern 3] addEventListener + removeEventListener (manual)');

  const seen = [];
  const handler = (event) => {
    seen.push(event.detail.taskId);
  };
  runtime.addEventListener('task:failed', handler);

  // Dispatch a task that always succeeds (no `task:failed` will fire).
  await runtime.execute({
    type: 'pattern3_ok',
    payload: {},
    fn: () => 'ok',
  });

  // Manually detach — important if the listener outlives its useful scope.
  runtime.removeEventListener('task:failed', handler);
  console.log(`  → handler removed; subsequent task:failed events would NOT be seen\n`);

  // ──────────────────────────────────────────────────────────────────────
  // Backward-compat shim still works (deprecation in v0.3.x, removed in
  // v0.4.x). Documented for migration awareness only.
  // ──────────────────────────────────────────────────────────────────────
  console.log('[backward-compat] .on() / .off() still work via compat shim (v0.4.x removal)');
  const shimCount = { count: 0 };
  const shimHandler = (_taskId) => {
    shimCount.count++;
  };
  runtime.on('task:completed', shimHandler);
  await runtime.execute({
    type: 'pattern4_done',
    payload: {},
    fn: () => 'done',
  });
  runtime.off('task:completed', shimHandler);
  console.log(`  → .on() saw ${shimCount.count} task:completed event(s) before .off()\n`);

  await runtime.shutdown();
  console.log('--- EventTarget observation example complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
