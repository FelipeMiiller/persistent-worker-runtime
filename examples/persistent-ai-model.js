/**
 * Example: Persistent Stateful Worker with L1 In-Memory Model Cache
 *
 * Demonstrates how to initialize a model or dataset once in the worker's
 * private L1 heap memory, then query it repeatedly with 0 reload cost.
 */

import { createWorkerRuntime, TaskHandle } from '../src/index.js';

async function main() {
  console.log('--- EXAMPLE: Persistent Stateful Worker (L1 Memory) ---\n');

  const runtime = await createWorkerRuntime({ workers: 2 });

  // 1. Spawn a dedicated worker for embeddings / AI operations
  const aiWorker = await runtime.createWorker({ name: 'embeddings-engine' });

  console.log('Warming up model weights in worker L1 memory...');

  // 2. Load model weights once into the worker's private L1 heap
  const initTask = new TaskHandle({
    type: 'init_model',
    fn: (_, state) => {
      // Simulates loading a heavy vocabulary or vector weights table
      const vocab = new Map([
        ['node', [0.12, 0.88, 0.45]],
        ['concurrency', [0.78, 0.23, 0.91]],
        ['worker', [0.34, 0.67, 0.19]],
      ]);
      state.set('embedding_model', vocab);
      return { initialized: true, vocabSize: vocab.size };
    },
  });

  const initResult = await aiWorker.executeTask(initTask);
  console.log(`Model initialized with ${initResult.vocabSize} vectors.\n`);

  // 3. Process queries: each task reads from the warm in-memory model in L1
  const queries = ['node', 'concurrency', 'worker'];

  for (const word of queries) {
    const queryTask = new TaskHandle({
      type: 'embed_word',
      payload: { word },
      fn: (p, state) => {
        const model = state.get('embedding_model');
        const vector = model.get(p.word) || [0, 0, 0];
        return { word: p.word, vector };
      },
    });

    const res = await aiWorker.executeTask(queryTask);
    console.log(`Embedding for "${res.word}":`, res.vector);
  }

  await aiWorker.terminate();
  await runtime.shutdown();
  console.log('\n--- AI Worker Terminated Cleanly ---');
}

main().catch(console.error);
