import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerRuntime } from '../src/index.js';
import { TaskAbortedError } from '../src/errors.js';

describe('Cancellation via AbortSignal', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 2 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('rejects a task when its signal is aborted before execution', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      runtime.execute({
        type: 'noop',
        payload: {},
        signal: controller.signal,
        fn: () => 'unreachable',
      }),
      (err) => err instanceof TaskAbortedError
    );
  });

  it('cancels a long-running task when the signal is aborted mid-execution', async () => {
    const controller = new AbortController();

    const promise = runtime.execute({
      type: 'long',
      payload: { durationMs: 5000 },
      signal: controller.signal,
      fn: async (p) => {
        await new Promise((r) => setTimeout(r, p.durationMs));
        return 'should-not-reach';
      },
    });

    setTimeout(() => controller.abort(), 50);

    await assert.rejects(promise, (err) => err instanceof TaskAbortedError);
  });

  it('does not affect other tasks when one is aborted', async () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const p1 = runtime.execute({
      type: 'long',
      payload: { durationMs: 5000 },
      signal: controller1.signal,
      fn: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return 'p1-result';
      },
    });
    const p2 = runtime.execute({
      type: 'fast',
      payload: {},
      signal: controller2.signal,
      fn: () => 'p2-result',
    });

    setTimeout(() => controller1.abort(), 30);

    // p1 aborts, p2 succeeds
    await assert.rejects(p1, (err) => err instanceof TaskAbortedError);
    const result2 = await p2;
    assert.equal(result2, 'p2-result');
  });

  it('completes successfully if signal is never aborted', async () => {
    const controller = new AbortController();
    const result = await runtime.execute({
      type: 'fast',
      payload: { v: 99 },
      signal: controller.signal,
      fn: (p) => p.v * 2,
    });
    assert.equal(result, 198);
    assert.equal(controller.signal.aborted, false);
  });

  it('cancellation of an already-settled task is a no-op', async () => {
    const controller = new AbortController();
    const promise = runtime.execute({
      type: 'fast',
      payload: { v: 1 },
      signal: controller.signal,
      fn: (p) => p.v + 1,
    });
    const result = await promise;
    assert.equal(result, 2);
    // Aborting after completion must not throw or affect anything
    controller.abort();
    assert.equal(controller.signal.aborted, true);
  });
});
