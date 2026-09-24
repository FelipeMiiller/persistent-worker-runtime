/**
 * Example: Streaming CSV export with observable backpressure
 *
 * Demonstrates how the runtime throttles a fast generator when the
 * consumer can't keep up — the same shape as exporting rows to a
 * slow HTTP endpoint, a transactional outbox, or a rate-limited
 * third-party API. The producer yields 1000 rows instantly; the
 * consumer "uploads" each row with a 5 ms simulated I/O delay.
 *
 * Key behaviors exercised:
 * - The bounded buffer (highWaterMark) crosses upward as the
 *   producer outpaces the consumer → `MSG_STREAM_PAUSE` to the
 *   worker, generator parks at its yield expression.
 * - As the consumer drains, the buffer drops below HWM / 2 →
 *   `MSG_STREAM_RESUME`, the worker continues.
 * - Both crossings emit `stream:backpressure { state, queueLength }`
 *   on the runtime's EventTarget. Telemetry observers can graph
 *   these events to detect consumer starvation. Listener uses
 *   `addEventListener` (web standard) and reads payload from
 *   `event.detail`. See `examples/event-target-pattern.js` for the
 *   recommended pattern with AbortController cleanup.
 * - `runtime.stats()` reports `activeStreams` while the stream is
 *   in flight.
 *
 * Run: `node examples/streaming-csv-export.js`
 */

import { createWorkerRuntime } from '../src/index.js';

// === Configuration ===

const ROW_COUNT = 1_000;
const HIGH_WATER_MARK = 8;
const CONSUMER_DELAY_MS = 5; // simulates per-row HTTP I/O

// === Main ===

async function main() {
  console.log('--- EXAMPLE: Streaming CSV export with backpressure ---\n');

  const runtime = await createWorkerRuntime({ workers: 1 });

  // Telemetry — count crossing events so we can verify that
  // backpressure actually engaged. Uses web-standard EventTarget
  // (`addEventListener`); payload lives on `event.detail`.
  const backpressureLog = [];
  let pausedCount = 0;
  let resumedCount = 0;
  runtime.addEventListener('stream:backpressure', (event) => {
    const { state, queueLength } = event.detail;
    backpressureLog.push({
      t: Date.now() - t0,
      state,
      queueLength,
    });
    if (state === 'paused') pausedCount++;
    else if (state === 'resumed') resumedCount++;
  });

  // Synthetic CSV producer — yields { row, payload } objects. In a
  // real app this would read from a database cursor or fs.createReadStream.
  // `rowCount` is passed via payload (NOT a closure variable) because
  // the worker reconstructs the generator via `new Function(fnCode)`,
  // which does not transport closure scope — see ADR-0012.
  const t0 = Date.now();
  const stream = runtime.stream(
    async function* exportRows({ rowCount }) {
      for (let i = 0; i < rowCount; i++) {
        // Synchronous yield — the worker can pump chunks as fast as
        // IPC allows. The consumer's delay is what creates pressure.
        yield {
          row: i,
          data: `row-${i},value,${(i * 7) % 100}\n`,
        };
      }
    },
    { rowCount: ROW_COUNT },
    { highWaterMark: HIGH_WATER_MARK },
  );

  console.log(
    `[producer] streaming ${ROW_COUNT} rows to a slow consumer ` +
      `(HWM=${HIGH_WATER_MARK}, consumer delay=${CONSUMER_DELAY_MS} ms/row)\n`,
  );

  let rowsWritten = 0;
  let bytesWritten = 0;
  for await (const chunk of stream) {
    rowsWritten++;
    bytesWritten += chunk.data.length;
    // Simulate slow I/O — the producer will quickly outrun us and
    // backpressure will engage.
    await new Promise((r) => setTimeout(r, CONSUMER_DELAY_MS));
  }

  const totalMs = Date.now() - t0;
  const throughput = rowsWritten / (totalMs / 1000);

  console.log('\n=== Results ===');
  console.log(`  rows written:    ${rowsWritten}`);
  console.log(`  bytes written:   ${bytesWritten}`);
  console.log(`  total time:      ${totalMs} ms`);
  console.log(`  throughput:      ${throughput.toFixed(1)} rows/sec`);
  console.log(`  backpressure:    ${pausedCount} paused + ${resumedCount} resumed events`);
  console.log(`  activeStreams:   peaked during run; final=${runtime.stats.activeStreams}`);

  // === Backpressure timeline (first 10 events) ===
  console.log('\n=== Backpressure timeline (first 10 events) ===');
  for (const e of backpressureLog.slice(0, 10)) {
    const arrow = e.state === 'paused' ? '⏸  PAUSE ' : '▶  RESUME';
    console.log(`  [t=${e.t.toString().padStart(5)} ms] ${arrow}  queueLength=${e.queueLength}`);
  }
  if (backpressureLog.length > 10) {
    console.log(`  ... and ${backpressureLog.length - 10} more event(s) suppressed for brevity`);
  }

  await runtime.shutdown();
  console.log('\n--- Streaming CSV export example complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
