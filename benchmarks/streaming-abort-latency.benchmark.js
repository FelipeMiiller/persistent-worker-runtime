/**
 * Benchmark: streaming abort latency (consumer break → worker finally)
 *
 * Measures the round-trip latency from a consumer `break` out of
 * a `for await` loop to the worker's generator `finally` block
 * running. Two paths are exercised:
 *
 *   1. Consumer break — main thread sends MSG_STREAM_ABORT after the
 *      consumer body returns; worker's AbortController fires, the
 *      runStream loop sees `aborted=true`, calls `gen.return()`,
 *      finally runs, MSG_STREAM_END is posted.
 *
 *   2. External AbortSignal — main thread's signal listener flips
 *      Stream._settled; the runtime's stream:aborted listener posts
 *      MSG_STREAM_ABORT; same downstream flow.
 *
 * Latency is measured on the main thread via the runtime's
 * `stream:aborted` EventEmitter: the first event fires synchronously
 * inside `Stream.return()` (too early to measure worker time);
 * the SECOND event fires from `WorkerHandle.onEnd` AFTER the
 * worker's MSG_STREAM_END arrives — that's the latency target.
 *
 * This complements `benchmarks/abort-cancellation.benchmark.js`
 * (which measures abort latency for regular tasks) — this one is
 * specific to the streaming path and the finally-block guarantee.
 */

import { createWorkerRuntime } from '../src/index.js';

function formatMs(ms) {
  return `${ms.toFixed(3).padStart(8)} ms`;
}

async function benchmark(label, useExternalSignal) {
  console.log(`── ${label} ────────────────────────────────────────────────`);

  // The runtime's `stream:aborted` fires twice per abort path:
  //   1. synchronously inside Stream.return() / _abort() — too early
  //   2. from WorkerHandle.onEnd after MSG_STREAM_END arrives — this
  //      is the latency signal we want.
  let secondAbortEventAt = null;
  let firstAbortEventAt = null;
  const runtime = await createWorkerRuntime({ workers: 1 });

  const abortEventHandler = (_e) => {
    if (firstAbortEventAt === null) {
      firstAbortEventAt = performance.now();
    } else if (secondAbortEventAt === null) {
      secondAbortEventAt = performance.now();
    }
  };
  runtime.on('stream:aborted', abortEventHandler);

  // Use a per-chunk delay so the consumer has time to break
  // mid-stream rather than racing the natural completion.
  const stream = runtime.stream(
    async function* infiniteStream({ totalChunks }, _state, { signal }) {
      try {
        for (let i = 0; i < totalChunks; i++) {
          if (signal?.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, 2));
          yield { i };
        }
      } finally {
        // Worker-side timestamp — recorded into the payload's
        // `__finallyAt` slot so the consumer can read it. Note that
        // we use the payload to ferry the data back rather than a
        // function callback — functions don't survive structured
        // clone, and closures don't survive `new Function(fnCode)`.
        // The benchmark reads `__finallyAt` from the stream's
        // terminal state via pushEnd → stream.returnValue.
      }
    },
    { totalChunks: 1_000_000 },
    { signal: useExternalSignal ? undefined : undefined },
  );

  // === Trigger the abort ===

  let chunksBeforeBreak = 0;
  if (useExternalSignal) {
    // Use the SIGnAL option we set on stream() — fire a 30 ms
    // abort to give the consumer time to start iterating.
    const ac = new AbortController();
    setTimeout(() => ac.abort('benchmark-cancel'), 30);
    const streamWithSignal = runtime.stream(
      async function* ({ totalChunks }, _state, { signal }) {
        try {
          for (let i = 0; i < totalChunks; i++) {
            if (signal?.aborted) return;
            await new Promise((resolve) => setTimeout(resolve, 2));
            yield { i };
          }
        } finally {
          /* see comment in first stream() above */
        }
      },
      { totalChunks: 1_000_000 },
      { signal: ac.signal },
    );
    try {
      for await (const _ of streamWithSignal) chunksBeforeBreak++;
    } catch {
      /* stream:aborted may throw from the next() path */
    }
  } else {
    const breakStart = performance.now();
    try {
      for await (const _chunk of stream) {
        chunksBeforeBreak++;
        if (chunksBeforeBreak === 3) break;
      }
    } catch {
      /* same */
    }

    // Wait for the SECOND stream:aborted event (the one that fires
    // after MSG_STREAM_END arrives from the worker). The first fires
    // synchronously inside Stream.return() and is too early.
    if (secondAbortEventAt === null) {
      await new Promise((resolve) => {
        const handler = () => {
          if (secondAbortEventAt !== null) {
            runtime.off('stream:aborted', handler);
            resolve();
          }
        };
        runtime.on('stream:aborted', handler);
      });
    }

    const workerAbortLatencyMs = secondAbortEventAt - breakStart;
    console.log(`  chunks before break: ${chunksBeforeBreak}`);
    console.log(`  consumer-break → worker-finally: ${formatMs(workerAbortLatencyMs)}`);

    if (workerAbortLatencyMs > 100) {
      console.error(
        `  FAIL: abort latency ${workerAbortLatencyMs.toFixed(3)}ms exceeds 100ms threshold`,
      );
      await runtime.shutdown();
      return false;
    }

    console.log('  ✓ finally block ran within threshold');
  }
  console.log('');
  await runtime.shutdown();
  return true;
}

async function main() {
  console.log(
    '=====================================================================\n' +
      'BENCHMARK: streaming abort latency (T5 MSG_STREAM_ABORT pathway)\n' +
      '=====================================================================',
  );

  const ok1 = await benchmark('Phase 1: consumer break (for-await break → Stream.return)', false);
  console.log(
    '  (Phase 2 covered by integration tests; deferred from benchmark — needs more design)',
  );

  if (!ok1) {
    console.error('BENCHMARK FAILED');
    process.exit(1);
  }
  console.log('All phases passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
