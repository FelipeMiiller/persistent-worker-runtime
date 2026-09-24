/**
 * [perf-tested] Persistent Stateful Worker with L1 In-Memory Model Cache.
 *
 * Demonstrates the win of keeping a model/dataset alive in a worker's L1
 * private heap across many task executions, then quantifies it against the
 * "reload every query" baseline.
 *
 * Why this matters: in a real app, "loading the model" can be seconds to
 * minutes (tokenizer weights, vector index, compiled regex tables, ML model
 * weights). A persistent worker pays that cost ONCE; an ephemeral worker
 * (or a stateless pool) pays it on every task. The L1 cache is what makes
 * the persistent model viable.
 *
 * What this example measures:
 *   - Total time for 10 queries with the model preloaded into L1 state
 *     (Scenario A — persistent).
 *   - Total time for 10 queries where the model is rebuilt inside the fn
 *     body on every call (Scenario B — ephemeral).
 *   - Side-by-side table + speedup ratio.
 *
 * Run: `node examples/persistent-ai-model.js`
 */

import { createWorkerRuntime, TaskHandle } from '../src/index.js';

const MODEL_SIZE = 5_000;
const QUERY_COUNT = 10;

/**
 * NOTE: fn bodies run inside the worker thread via `new Function(fnCode)`,
 * which does NOT transport closures from the main module. The model-build
 * loop is therefore duplicated verbatim inside each fn that needs it
 * (init fn for Scenario A, query fn for Scenario B). Both copies are the
 * same `MODEL_SIZE` so the cost is comparable.
 */

async function scenarioPersistent() {
  const runtime = await createWorkerRuntime({ workers: 1 });
  const aiWorker = await runtime.createWorker({ name: 'embeddings-persistent' });

  const totalStart = performance.now();

  // ONE-TIME init: build model and stash in L1.
  await aiWorker.executeTask(
    new TaskHandle({
      type: 'init_model',
      fn: (_, state) => {
        // Model-build loop — inlined into the fn body (no closure transport).
        const map = new Map();
        for (let i = 0; i < 5000; i++) {
          map.set(i, [Math.random(), Math.random(), Math.random()]);
        }
        state.set('embedding_model', map);
        return { initialized: true };
      },
    }),
  );

  // N queries against the warm L1 cache.
  for (let i = 0; i < QUERY_COUNT; i++) {
    await aiWorker.executeTask(
      new TaskHandle({
        type: 'embed',
        payload: { id: i },
        fn: (p, state) => {
          const model = state.get('embedding_model');
          const vector = model.get(p.id) ?? [0, 0, 0];
          return { id: p.id, vector };
        },
      }),
    );
  }

  const totalMs = performance.now() - totalStart;
  await aiWorker.terminate();
  await runtime.shutdown();
  return totalMs;
}

async function scenarioEphemeral() {
  const runtime = await createWorkerRuntime({ workers: 1 });

  const totalStart = performance.now();

  // NO init task. Model rebuilt INSIDE the fn body on every call.
  for (let i = 0; i < QUERY_COUNT; i++) {
    await runtime.execute({
      type: 'embed',
      payload: { id: i },
      fn: (p) => {
        // Build the model fresh every call — simulates "no L1 cache".
        const map = new Map();
        for (let j = 0; j < 5000; j++) {
          map.set(j, [Math.random(), Math.random(), Math.random()]);
        }
        return { id: p.id, vector: map.get(p.id) ?? [0, 0, 0] };
      },
    });
  }

  const totalMs = performance.now() - totalStart;
  await runtime.shutdown();
  return totalMs;
}

async function main() {
  console.log('--- EXAMPLE: Persistent worker (L1 cache) vs ephemeral rebuild ---\n');
  console.log(
    `Workload: build a ${MODEL_SIZE.toLocaleString()}-entry model (one-time cost) + run ${QUERY_COUNT} queries.\n`,
  );

  const persistentMs = await scenarioPersistent();
  const ephemeralMs = await scenarioEphemeral();

  console.log(`\n=== Total time for ${QUERY_COUNT} queries ===\n`);
  console.table({
    'A. Persistent (L1 cache, model built once)': {
      totalMs: persistentMs.toFixed(2),
      modelBuilds: '1',
    },
    'B. Ephemeral (no L1 cache, model rebuilt every query)': {
      totalMs: ephemeralMs.toFixed(2),
      modelBuilds: `${QUERY_COUNT}`,
    },
  });

  const speedup = ephemeralMs / Math.max(persistentMs, 0.001);
  console.log(
    `\nSpeedup: ${speedup.toFixed(2)}× faster with the L1 cache.\n` +
      `Persistent worker paid the model-load cost once; ephemeral paid it ${QUERY_COUNT}× times.`,
  );

  if (persistentMs < ephemeralMs) {
    console.log(
      '\n✅ The win compounds: longer model loads and more queries → larger speedup ratio.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
