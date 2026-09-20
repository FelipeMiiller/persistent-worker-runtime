# Test Templates â€” persistent-worker-runtime

Reusable test snippets. Each template corresponds to a gotcha in [gotchas.md](gotchas.md) or a Node-pattern in [node-patterns.md](node-patterns.md). Copy, adapt the values, run.

All templates use `node:test` (the built-in Node.js test runner). Match the style of existing tests in `test/`:

- `import { describe, it, before, after, beforeEach } from 'node:test';`
- `import assert from 'node:assert/strict';`
- `import * as common from './common.js';`  â† for Node-pattern helpers
- `describe('Topic', () => { it('does X', async () => { /* ... */ }); });`

---

## Template 1: Memory measurement (forces `heapUsed` growth)

Use when: you need to assert that a feature allocates memory proportional to workload.

**Gotcha reference:** [gotchas #1, #2](gotchas.md#1-processmemoryusageheapused-excludes-off-heap-allocations)

```js
import { createWorkerRuntime } from '../src/index.js';
import { performance } from 'node:perf_hooks';

describe('Memory measurement template', () => {
  it('grows heapUsed proportionally to unique-content payloads', async () => {
    const runtime = createWorkerRuntime({ workers: 2 });

    // Capture BEFORE
    if (global.gc) global.gc();
    await sleep(100);
    const heapBefore = process.memoryUsage().heapUsed;

    // Dispatch N tasks each with unique-content payload
    const N = 1000;
    const handles = [];
    for (let i = 0; i < N; i++) {
      // Per-task unique seed prevents V8 string-internalization dedup
      const seed = String.fromCharCode(...Array.from({ length: 8 }, (_, k) => ((i >> (k * 8)) & 0xFF) || 1));
      const payload = (seed + 'x').repeat(2_000); // ~4KB unique per task
      handles.push(runtime.dispatch({ fn: consume, payload }));
    }

    // AWAIT all dispatches â€” fire-and-forget = CI flake (gotcha #3)
    await Promise.all(handles.map((h) => h.promise.catch(() => {})));

    // Capture AFTER
    if (global.gc) global.gc();
    await sleep(100);
    const heapAfter = process.memoryUsage().heapUsed;

    const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);

    // N tasks Ã— 4KB unique payload = 4MB minimum heap growth
    assert.ok(heapDeltaMb > 2, `expected heap growth > 2 MB, got ${heapDeltaMb.toFixed(2)} MB`);

    await runtime.shutdown();
  });
});

function consume(payload) {
  // Force payload into heapUsed by reading it (not just passing through)
  let acc = '';
  for (let i = 0; i < 10; i++) acc += payload.slice(0, 500);
  return { len: acc.length };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**When to use Buffers instead:** if you're testing off-heap allocation (e.g., a feature designed to use ArrayBuffer transfer), check `memoryUsage().external` instead of `heapUsed`.

---

## Template 2: Watchdog preemption

Use when: testing that runaway tasks are killed within `timeoutMs + killGracePeriodMs`.

**Gotcha reference:** [gotcha #4](gotchas.md#4-watchdog-requires-timeoutms--0--default-0-is-silent-no-op)

```js
import { createWorkerRuntime } from '../src/index.js';

describe('Watchdog preemption template', () => {
  it('kills runaway task within timeoutMs + grace', async () => {
    const runtime = createWorkerRuntime({
      workers: 1,
      preemption: { forceKillOnTimeout: true, killGracePeriodMs: 100 },
    });

    const startTime = Date.now();
    const handle = runtime.dispatch({
      fn: () => { while (true) {} },  // runaway
      timeoutMs: 500,                  // explicit (don't rely on default!)
      forceKillOnTimeout: true,
    });

    // Wait for the watchdog to fire
    const error = await handle.promise.catch((e) => e);

    const elapsedMs = Date.now() - startTime;

    assert.ok(error instanceof Error, 'expected task to reject');
    assert.match(error.message, /timeout|preempt/i);

    // timeoutMs (500) + killGracePeriodMs (100) + watchdog latency (50)
    assert.ok(elapsedMs < 1000, `preemption took ${elapsedMs}ms, expected < 1000ms`);
    assert.ok(elapsedMs >= 500, `preemption fired before timeout (${elapsedMs}ms < 500ms)`);

    await runtime.shutdown();
  });
});
```

**Always** pass `timeoutMs` explicitly. The post-ADR-0024 default is 5000ms, but relying on defaults in tests is fragile.

---

## Template 3: Live-mirror stats assertion

Use when: testing that `runtime.stats.X` accurately reflects the controller's internal state.

**Gotcha reference:** [gotcha #9](gotchas.md#9-runtimestatsx-is-a-live-reference-not-a-snapshot)

```js
import { createWorkerRuntime } from '../src/index.js';

describe('Live-mirror stats template', () => {
  it('runtime.stats.adaptive mirrors controller.getStats() exactly', async () => {
    const runtime = createWorkerRuntime({ workers: 4 });

    // Boot â€” controller starts ticking
    await sleep(1500);  // let at least 1 tick fire

    // âœ… Destructure into local vars synchronously, BEFORE any await
    const {
      elu,
      latencyP99Ms,
      effectiveWorkers,
      ticksSinceResize,
      lastResizeReason,
      lastResizeAt,
    } = runtime.stats.adaptive;

    // Now we can await safely
    await sleep(100);

    // Asserts on the captured local vars
    assert.equal(typeof elu, 'number');
    assert.equal(typeof latencyP99Ms, 'number');
    assert.ok(elu >= 0 && elu <= 1);
    assert.ok(latencyP99Ms < 1000, 'latencyP99Ms should be in milliseconds');
    assert.equal(effectiveWorkers, 4);
    assert.ok(ticksSinceResize >= 1);

    await runtime.shutdown();
  });
});
```

**Without the destructure**, the values can shift between read and assert:

```js
// âŒ WRONG
const stats = runtime.stats.adaptive;
await sleep(100);
assert.equal(stats.effectiveWorkers, 4);  // tick may have changed it
```

---

## Template 4: Two-snapshot "is counter alive"

Use when: testing that a counter monotonically increments between samples.

**Gotcha reference:** [gotcha #12](gotchas.md#12-two-snapshot-pattern-for-is-counter-alive)

```js
import { createWorkerRuntime } from '../src/index.js';

describe('Two-snapshot template', () => {
  it('ticksSinceResize monotonically increments', async () => {
    const runtime = createWorkerRuntime({ workers: 2 });

    // Wait for at least one tick to seed the counter
    await sleep(1500);

    // Capture before
    const before = runtime.stats.adaptive.ticksSinceResize;

    // Wait a known interval (must be > tick cadence)
    await sleep(2500);  // tick cadence is 1000ms by default

    // Capture after
    const after = runtime.stats.adaptive.ticksSinceResize;

    assert.ok(
      after > before,
      `expected ticksSinceResize to increment over 2.5s; before=${before} after=${after}`,
    );

    await runtime.shutdown();
  });
});
```

---

## Template 5: Burst-then-idle (controller-driven workload)

Use when: testing that the adaptive controller fires `grow` or `shrink` based on signal sampling.

**Gotcha reference:** [gotcha #13](gotchas.md#13-setimmediate-chain-saturates-main-thread--controller-sees-wrong-signal)

```js
import { createWorkerRuntime } from '../src/index.js';

describe('Burst-then-idle template', () => {
  it('fires grow when workers are saturated and main thread is idle', async () => {
    const runtime = createWorkerRuntime({ workers: 4 });

    // Phase 1: synchronous burst to saturate workers
    const handles = [];
    for (let i = 0; i < 500; i++) {
      handles.push(
        runtime.dispatch({
          fn: busyWork,
          payload: { iter: 100_000 },
        }),
      );
    }

    // Don't await yet â€” we want workers busy
    // But DO attach no-op catches so unhandled rejections don't fire later
    handles.forEach((h) => h.promise.catch(() => {}));

    // Phase 2: idle settle window (main thread idle, controller samples)
    await sleep(7000);

    // Capture controller state
    const { effectiveWorkers, lastResizeReason, lastResizeAt } = runtime.stats.adaptive;

    // Controller should have fired grow
    assert.ok(
      effectiveWorkers > 4,
      `expected effectiveWorkers > 4 after grow burst, got ${effectiveWorkers}`,
    );
    assert.equal(lastResizeReason, 'grow');

    // Cleanup
    await Promise.all(handles.map((h) => h.promise.catch(() => {})));
    await runtime.shutdown();
  });
});

function busyWork({ iter }) {
  let sum = 0;
  for (let i = 0; i < iter; i++) sum += Math.sqrt(i);
  return { sum };
}
```

**Anti-pattern to avoid:**

```js
// âŒ BAD â€” setImmediate chain saturates main thread
function dispatchTick() {
  if (!running) return;
  for (let i = 0; i < 5; i++) runtime.dispatch({ fn: work });
  setImmediate(dispatchTick);
}
setImmediate(dispatchTick);  // main thread ~95% busy, controller sees wrong signal
```

---

## Template 6: Async activity after test end â€” regression test

Use when: writing a test that needs to **catch** the async-activity-after-test-end flake, OR reproducing one that occurred in CI.

**Gotcha reference:** [gotcha #3](gotchas.md#3-async-activity-after-test-end--ci-flake-node-test-runner--worker_threads)

```js
import { createWorkerRuntime } from '../src/index.js';

describe('Async-activity-after-test-end template', () => {
  it('catches fire-and-forget dispatch', async () => {
    // Install an unhandled-rejection trap
    const unhandled = [];
    const trap = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', trap);

    try {
      const runtime = createWorkerRuntime({ workers: 1 });

      // BAD: fire-and-forget
      runtime.dispatch({ fn: longWork, timeoutMs: 2000 });

      // Test function returns â€” but worker is still busy
      await sleep(100);

      // Wait for the worker to finish
      await sleep(2500);

      // Assert NO unhandled rejections occurred during this window
      assert.equal(
        unhandled.length,
        0,
        `fire-and-forget produced ${unhandled.length} unhandled rejections`,
      );

      await runtime.shutdown();
    } finally {
      process.off('unhandledRejection', trap);
    }
  });

  it('CLEAN pattern: await dispatch before returning', async () => {
    const runtime = createWorkerRuntime({ workers: 1 });

    // GOOD: await the dispatch
    const handle = runtime.dispatch({ fn: longWork, timeoutMs: 2000 });
    await handle.promise;

    // No async activity after this point
    await runtime.shutdown();
  });
});

function longWork() {
  // Simulate 500ms of work
  const start = Date.now();
  while (Date.now() - start < 500) {}
  return { ok: true };
}
```

---

## Template 7: Pre-aborted signal

Use when: testing that a stream/task with an already-aborted signal doesn't crash and emits the right event.

```js
import { createWorkerRuntime } from '../src/index.js';

describe('Pre-aborted signal template', () => {
  it('stream() with pre-aborted signal emits stream:aborted immediately', async () => {
    const runtime = createWorkerRuntime({ workers: 1 });

    const ac = new AbortController();
    ac.abort();  // pre-abort

    const abortedEvents = [];
    runtime.on('stream:aborted', (e) => abortedEvents.push(e));

    // stream() should NOT throw; should emit aborted immediately
    const stream = runtime.stream({
      fn: async function* () { yield 'never'; },
      signal: ac.signal,
    });

    // Wait for the abort to propagate
    await sleep(50);

    assert.equal(abortedEvents.length, 1);
    assert.equal(abortedEvents[0].reason, 'pre-aborted-signal');

    await runtime.shutdown();
  });
});
```

---

## Template 8: Cross-platform CI verification

Use when: writing a test that has known OS-specific behavior. Use `process.platform` to gate:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Cross-platform line ending', () => {
  it('reads CRLF correctly on Windows, LF on Unix', () => {
    // Skip on the wrong platform OR run differently per OS
    if (process.platform === 'win32') {
      const content = readFileSync('test/fixtures/sample-crlf.txt', 'utf8');
      assert.ok(content.includes('\r\n'), 'Windows file should have CRLF');
    } else {
      const content = readFileSync('test/fixtures/sample-lf.txt', 'utf8');
      assert.ok(!content.includes('\r\n'), 'Unix file should NOT have CRLF');
    }
  });
});
```

Or skip entirely on the wrong platform with a documented reason:

```js
it('Windows-specific behavior', { skip: process.platform !== 'win32' && 'Windows-only test' }, () => {
  // ...
});
```

---

## Helper: shared test utilities

These are patterns I use across the test suite. Consider extracting to `test/_helpers.js`:

```js
// test/_helpers.js
import { performance } from 'node:perf_hooks';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

export function snapMemory() {
  const m = process.memoryUsage();
  return {
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    rss: m.rss,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
}

export function uniquePayload(seed, sizeKb = 4) {
  // Per-task unique seed + repetition forces heapUsed growth (gotchas #1, #2)
  const seedStr = String.fromCharCode(...Array.from({ length: 8 }, (_, k) => ((seed >> (k * 8)) & 0xFF) || 1));
  return (seedStr + 'x').repeat(sizeKb * 256);  // ~4KB unique per task
}

export function captureStats(runtime) {
  // Synchronously capture all stat fields into a snapshot object
  return { ...runtime.stats };
}

export function captureAdaptiveStats(runtime) {
  return { ...runtime.stats.adaptive };
}

export async function withTrap(handler, fn) {
  // Trap unhandled rejections during the test body
  const trap = (reason) => handler(reason);
  process.on('unhandledRejection', trap);
  try {
    return await fn();
  } finally {
    process.off('unhandledRejection', trap);
  }
}
```

**Usage:**

```js
import { sleep, captureAdaptiveStats, uniquePayload } from './_helpers.js';

it('counter increments', async () => {
  const runtime = createWorkerRuntime({ workers: 1 });
  await sleep(1500);

  const before = captureAdaptiveStats(runtime).ticksSinceResize;
  await sleep(2500);
  const after = captureAdaptiveStats(runtime).ticksSinceResize;

  assert.ok(after > before);
  await runtime.shutdown();
});
```

---

## Template 9: Node-pattern — `mustCall` replaces ad-hoc counters

Use when: testing that an event fires exactly N times.

**Node-pattern reference:** [node-patterns.md lesson 1](node-patterns.md#lesson-1-did-event-x-fire-must-mean-exactly-n-times)

```js
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';
import * as common from './common.js';

describe('mustCall — exact N times', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 1 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('task:completed fires EXACTLY once per dispatch', async () => {
    // ? OLD pattern — counter ad-hoc; misses "fired twice"
    // let counter = 0;
    // runtime.on('task:completed', () => { counter++; });
    // await runtime.dispatch({ fn: work });
    // assert.equal(counter, 1);  // passes even if event fires again during cleanup

    // ? NEW pattern — mustCall(1) catches zero OR two fires on process.exit
    runtime.on(
      'task:completed',
      common.mustCall((event) => {
        assert.equal(event.taskId, 'task-1');
      }, 1),
    );

    await runtime.dispatch({ fn: work, taskId: 'task-1' });
    // If task:completed fires 0 times OR 2+ times, the test FAILS at process.exit.
  });

  it('worker:recycled fires AT LEAST once after grow burst', async () => {
    runtime.on(
      'worker:recycled',
      common.mustCallAtLeast((event) => {
        assert.ok(event.workerId);
      }, 1),
    );

    await growBurst();  // forces recycling
    // At least 1 fire required; 2+ is fine (e.g., multiple workers recycle).
  });
});
```

---

## Template 10: Node-pattern — `mustNotCall` tests absence

Use when: testing that an event should NEVER fire.

**Node-pattern reference:** [node-patterns.md lesson 2](node-patterns.md#lesson-2-this-should-not-happen-is-testable)

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';
import * as common from './common.js';

describe('mustNotCall — should not happen', () => {
  it('no task:completed after runtime.shutdown()', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });

    runtime.on(
      'task:completed',
      common.mustNotCall('task completed after shutdown — worker leaked an event'),
    );

    await runtime.shutdown();
    await common.sleep(100);  // wait for any rogue late event

    // If task:completed fired, the test FAILED IMMEDIATELY (mustNotCall throws).
  });

  it('no stream:yield after consumer break', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });
    const stream = runtime.stream({ fn: async function* () { yield 'a'; yield 'b'; } });

    runtime.on(
      'stream:yield',
      common.mustNotCall('stream yielded after consumer break'),
    );

    const it = stream[Symbol.asyncIterator]();
    await it.next();
    await it.return();  // explicit return, not break

    await common.sleep(50);
    await runtime.shutdown();
  });
});
```

---

## Template 11: Node-pattern — `expectWarning` asserts warning shape

Use when: a public API emits a `process.emit('warning', ...)` and you want to lock the message + code.

**Node-pattern reference:** [node-patterns.md lesson 3](node-patterns.md#lesson-3-process-warnings-are-public-api-contracts)

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';
import * as common from './common.js';

describe('expectWarning — PersistentWorkerRuntimeDefaultSizing', () => {
  it('emits warning with exact message and code on multi-core host', () => {
    // Assume isMainThread + availableParallelism() > 4
    if (!common.isMainThread) return;

    common.expectWarning(
      'PersistentWorkerRuntimeDefaultSizing',
      /started with default workers=\d+ on a \d+-core host/,
      'ERR_PERSISTENT_WORKER_DEFAULT_SIZING',
    );

    createWorkerRuntime();  // triggers the warning

    // If the warning doesn't fire, OR fires with a different message/code,
    // the test FAILS at process.exit.
  });

  it('does NOT emit warning when workers is explicit', () => {
    if (!common.isMainThread) return;

    // Trap any warning and fail the test if fired
    let warned = false;
    const trap = () => { warned = true; };
    process.on('warning', trap);
    try {
      createWorkerRuntime({ workers: 4 });
    } finally {
      process.off('warning', trap);
    }
    assert.equal(warned, false, 'explicit workers should silence the warning');
  });
});
```

---

## Template 12: Node-pattern — `getArrayBufferViews` for complete transfer coverage

Use when: transferring ArrayBuffers to a worker.

**Node-pattern reference:** [node-patterns.md lesson 4](node-patterns.md#lesson-4-test-what-matters-not-whats-easy)

```js
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';
import * as common from './common.js';

describe('getArrayBufferViews — transfer covers all views', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 1 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('transfers a single ArrayBuffer and detaches ALL typed-array views', async () => {
    const buf = new ArrayBuffer(1024);
    const view = new Uint8Array(buf);
    view[0] = 0x42;
    view[1023] = 0xff;

    // Pre-capture ALL views BEFORE the transfer. Constructing views on a
    // detached ArrayBuffer throws, so we MUST capture them first.
    const viewsBefore = common.getArrayBufferViews(buf);
    for (const v of viewsBefore) {
      assert.equal(v.buffer.byteLength, 1024, 'pre-transfer view should be full');
    }

    await runtime.execute({
      type: 'inspect',
      payload: { buffer: buf },
      transferList: [buf],
      fn: (p) => new Uint8Array(p.buffer),
    });

    assert.equal(buf.byteLength, 0, 'sender buffer must be detached');

    // Every captured view must point to a detached ArrayBuffer.
    // v.buffer.byteLength returns 0 when detached; v.byteLength throws.
    for (const v of viewsBefore) {
      assert.equal(
        v.buffer.byteLength,
        0,
        `${v.constructor.name}'s ArrayBuffer must be detached after transfer`,
      );
    }
  });
});
```

---

## Template 13: Node-pattern — `platformTimeout` for slow-CI stability

Use when: any test that uses `await sleep(N)` where N > 1000.

**Node-pattern reference:** [node-patterns.md lesson 5](node-patterns.md#lesson-5-test-isolation-is-non-negotiable)

```js
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';
import * as common from './common.js';

describe('platformTimeout — slow-CI stable', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 2 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('controller ticks fire within scaled timeout', async () => {
    // ? WRONG — fixed 1500ms flakes on slow CI
    // await sleep(1500);

    // ? RIGHT — platformTimeout scales for debug/RISC-V/AIX
    await common.sleep(common.platformTimeout(1500));

    const { ticksSinceResize } = runtime.stats.adaptive;
    assert.ok(ticksSinceResize >= 1, 'controller should have ticked at least once');
  });
});
```

---

## Template 14: Node-pattern — `expectWarning` for negative path (no warning when configured)

Use when: ensuring a warning does NOT fire when its trigger condition is absent.

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';
import * as common from './common.js';

describe('warning negative path', () => {
  it('does not emit PersistentWorkerRuntimeDefaultSizing when workers explicit', () => {
    // Trap any warning and fail if it fires
    const trap = (warning) => {
      assert.fail(`Unexpected warning: ${warning.name} — ${warning.message}`);
    };
    process.on('warning', trap);

    try {
      createWorkerRuntime({ workers: 4 });  // explicit, no warning
    } finally {
      process.off('warning', trap);
    }
    // Test passes if no warning fires.
  });

  it('does not emit warning when WORKER_CONCURRENCY env var set', () => {
    process.env.WORKER_CONCURRENCY = '4';
    const trap = (warning) => {
      assert.fail(`Unexpected warning: ${warning.name}`);
    };
    process.on('warning', trap);

    try {
      createWorkerRuntime();
    } finally {
      process.off('warning', trap);
      delete process.env.WORKER_CONCURRENCY;
    }
  });
});
```
