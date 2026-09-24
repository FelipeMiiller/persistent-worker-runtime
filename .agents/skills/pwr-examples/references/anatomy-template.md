# Anatomy Template — Copy-paste skeleton

Use this as the starting point for any new `examples/*.js` file. Fill in the `<…>` placeholders. Every example in this repo follows this shape; deviating requires justification in the PR.

## `[perf-tested]` template

```js
/**
 * [perf-tested] Example: <feature name>.
 *
 * Demonstrates <what> AND quantifies the win against <baseline>.
 *
 * Use cases:
 *   - <bullet 1>
 *   - <bullet 2>
 *
 * What this example measures:
 *   - <metric 1> (<units>)
 *   - <metric 2> (<units>)
 *
 * Run: `node examples/<file>.js`
 */

import { createWorkerRuntime } from '../src/index.js';

// === Configuration ===

const TASK_COUNT = 50;
const PER_TASK_MS = 20;

// === Worker fns (no closure references; constants inlined) ===

const workFn = () =>
  new Promise((resolve) => setTimeout(resolve, 20)); // PER_TASK_MS inlined

// === Scenarios ===

async function scenarioA() {
  const runtime = await createWorkerRuntime({ workers: 2 });
  const start = performance.now();
  await runtime.executeAll(
    Array.from({ length: TASK_COUNT }, () => ({
      type: 'work',
      payload: {},
      fn: workFn,
    })),
  );
  const elapsedMs = performance.now() - start;
  await runtime.shutdown();
  return elapsedMs;
}

async function scenarioB() {
  // Inline main-thread baseline — no runtime.
  const start = performance.now();
  for (let i = 0; i < TASK_COUNT; i++) {
    await workFn();
  }
  const elapsedMs = performance.now() - start;
  return elapsedMs;
}

// === Main ===

async function main() {
  console.log(`--- EXAMPLE: <feature name> ---\n`);
  console.log(`Workload: ${TASK_COUNT} tasks × ${PER_TASK_MS} ms each.\n`);

  const aMs = await scenarioA();
  const bMs = await scenarioB();

  console.log('\n=== Results ===\n');
  console.table({
    'A. With optimization': { elapsedMs: aMs.toFixed(2) },
    'B. Without (baseline)': { elapsedMs: bMs.toFixed(2) },
  });

  const speedup = bMs / Math.max(aMs, 0.001);
  console.log(`\nSpeedup: ${speedup.toFixed(2)}× faster with the runtime.`);

  console.log('\nTake-away: <one-line interpretation of the result>.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## `[correctness]` template

```js
/**
 * [correctness] Example: <feature name>.
 *
 * Demonstrates <what the contract is>.
 *
 * Why [correctness]: <rationale paragraph — workload too small to drive a metric, the property is binary, etc.>
 *
 * Run: `node examples/<file>.js`
 */

import { createWorkerRuntime } from '../src/index.js';

async function main() {
  console.log(`--- EXAMPLE: <feature name> ---\n`);

  const runtime = await createWorkerRuntime({ workers: 1 });

  // Scenario 1: <contract path>
  console.log('--- Scenario 1: ... ---');
  // ... exercise the contract ...

  // Scenario 2: <another contract path>
  console.log('\n--- Scenario 2: ... ---');
  // ... exercise another contract path ...

  await runtime.shutdown();
  console.log('\n--- Example complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## `[api-surface]` template

```js
/**
 * [api-surface] Example: <feature name>.
 *
 * Demonstrates the API surface for <feature>.
 *
 * Why [api-surface]: <rationale paragraph — the win is API ergonomics, not raw speed; wall-clock comparison would be micro-noise; etc.>
 *
 * Run: `node examples/<file>.js`
 */

import { createWorkerRuntime } from '../src/index.js';

async function main() {
  console.log(`--- EXAMPLE: <feature name> ---\n`);

  const runtime = await createWorkerRuntime({ workers: 1 });

  // Pattern 1: <pattern name>
  console.log('[pattern 1] ...');
  // ... show the API ...

  // Pattern 2: <pattern name>
  console.log('\n[pattern 2] ...');
  // ... show the API ...

  await runtime.shutdown();
  console.log('\n--- Example complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## Quick checklist before committing

```text
- [ ] Header tag is one of [perf-tested] / [correctness] / [api-surface] (exactly one)
- [ ] Configuration block at top with UPPER_SNAKE_CASE constants
- [ ] Worker fns inline any referenced constants (ADR-0012)
- [ ] If [perf-tested]: ends with console.table + speedup line + take-away
- [ ] If [correctness] or [api-surface]: ends with "Why [tag]:" paragraph in JSDoc
- [ ] main().catch() error handler at bottom
- [ ] npm run lint passes
- [ ] node examples/<file>.js exits 0 and prints expected output
```

## When the template doesn't fit

If the example needs a non-standard structure (multi-routing, custom handler module, multi-phase demo), document the deviation in the JSDoc:

```js
/**
 * [perf-tested] Example: <feature>.
 *
 * Non-standard structure because <reason>.
 *
 * ...
 */
```

Examples of accepted deviations: `examples/broadcast-cache-invalidation.js` (5 phases, no side-by-side table — cache hit/miss shown via labels). The metric is the cumulative saving printed in the take-away.
