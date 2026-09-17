/**
 * Example: Token-streaming LLM-style consumer
 *
 * Demonstrates how to use `runtime.stream()` to feed tokens to a
 * caller as they're generated — the same shape as OpenAI's
 * `stream=True` chat completions, Anthropic's `stream=true` messages,
 * or any SSE-based model API. The consumer sees the first token in
 * well under a second (TTFT) and can `break` out of the iteration to
 * cancel mid-generation.
 *
 * Key behaviors exercised:
 * - For-await over a runtime.stream() returns chunks as the generator
 *   yields them — no Promise.all waiting for the full response.
 * - An external AbortSignal wired via `options.signal` propagates to
 *   the worker's iterator via MSG_STREAM_ABORT; the generator's
 *   `finally` block still runs (cleanup, partial logging, etc).
 * - Consumer break (`for await (...) { break }`) emits a single
 *   `stream:aborted` event with `reason: 'consumer-return'` — runtime
 *   observers see exactly one abort.
 * - Runtime-level events (`stream:created`, `stream:chunk`,
 *   `stream:end`, `stream:aborted`) are exposed on the runtime's
 *   EventEmitter for observability layers.
 *
 * Run: `node examples/streaming-llm.js`
 */

import { createWorkerRuntime } from '../src/index.js';

// === Configuration ===

const PROMPT_TOKENS = [
  'Once',
  ' upon',
  ' a',
  ' time',
  ',',
  ' a',
  ' persistent',
  ' worker',
  ' runtime',
  ' streamed',
  ' tokens',
  ' to',
  ' an',
  ' attentive',
  ' consumer',
  '.',
];
const PER_TOKEN_MS = 20;
const AUTO_ABORT_MS = 350; // cancels mid-stream to demo signal path

// === Main ===

async function main() {
  console.log('--- EXAMPLE: Streaming LLM-style token consumer ---\n');

  const runtime = await createWorkerRuntime({ workers: 1 });

  // Observability — wire runtime-level events before stream() so we
  // don't miss any. Each event carries { taskId, ... }.
  const eventCounts = { created: 0, chunk: 0, end: 0, aborted: 0 };
  runtime.on('stream:created', () => eventCounts.created++);
  runtime.on('stream:chunk', () => eventCounts.chunk++);
  runtime.on('stream:end', () => eventCounts.end++);
  runtime.on('stream:aborted', ({ reason }) => {
    eventCounts.aborted++;
    console.log(`  [runtime] stream:aborted — reason: ${reason}`);
  });

  // Pre-abort timer — cancels the stream after AUTO_ABORT_MS to
  // exercise the external-signal path. The for-await consumer will
  // exit cleanly when the worker's generator receives MSG_STREAM_ABORT
  // and runs its `finally` block.
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort('user-cancel'), AUTO_ABORT_MS);

  const t0 = Date.now();
  let firstTokenAt = null;
  let tokensReceived = 0;

  // Tokens and timing are passed through the payload (NOT as
  // closure variables) because the worker reconstructs the generator
  // from source via `new Function(fnCode)`, which does not transport
  // closure scope. See ADR-0012 and src/stream-runner.js for details.
  const stream = runtime.stream(
    async function* chat({ tokens, perTokenMs }, { signal }) {
      // Pre-amble — model "thinking" delay. TTFT includes this.
      await new Promise((r) => setTimeout(r, 30));
      for (const token of tokens) {
        if (signal?.aborted) return; // graceful exit
        await new Promise((r) => setTimeout(r, perTokenMs));
        yield { token, finishReason: null };
      }
      yield { token: null, finishReason: 'stop' };
    },
    {
      prompt: 'Write me a story about streaming.',
      tokens: PROMPT_TOKENS,
      perTokenMs: PER_TOKEN_MS,
    },
    // ^ `prompt` is unused inside the generator; the LLM doesn't
    // echo the prompt back. Removing it would change the payload
    // schema demonstration, so it's left in to mirror real APIs.
    { signal: controller.signal },
  );

  console.log('[t=0ms] stream:created (taskId is in runtime events, not on Stream)\n');

  // === Consumer ===

  process.stdout.write('[consumer] ');
  try {
    for await (const chunk of stream) {
      if (firstTokenAt === null) {
        firstTokenAt = Date.now() - t0;
        console.log(`\n[consumer] TTFT = ${firstTokenAt} ms (first token received)`);
        process.stdout.write('[consumer] ');
      }
      tokensReceived++;
      if (chunk.token) {
        process.stdout.write(chunk.token);
      } else {
        process.stdout.write(`<finish:${chunk.finishReason}>`);
      }
    }
  } catch (err) {
    console.log(`\n[consumer] stream threw: ${err.name}: ${err.message}`);
  } finally {
    clearTimeout(abortTimer);
  }

  const totalMs = Date.now() - t0;
  console.log(
    `\n\n[summary] received ${tokensReceived} chunk(s) in ${totalMs} ms ` +
      `(TTFT ${firstTokenAt ?? 'n/a'} ms); stream.aborted=${stream.aborted}, ` +
      `abortedReason=${stream.abortedReason ?? 'none'}`,
  );

  console.log('\n[runtime event counts]', eventCounts);

  await runtime.shutdown();
  console.log('\n--- Streaming LLM example complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
