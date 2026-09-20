import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';
import * as common from './common.js';

describe('Zero-Copy ArrayBuffer Transfer', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 1 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  // Node-pattern: pre-capture typed-array views BEFORE the transfer. After
  // the transfer, `buf.byteLength === 0`, but `view.byteLength` throws on a
  // detached buffer. We assert against `v.buffer.byteLength` (returns 0 per
  // V8 spec when detached) for each pre-captured view.
  //
  // Why this matters: catches regressions where only Uint8Array is detached
  // but DataView / Int32Array / BigInt64Array is not.
  it('transfers a single ArrayBuffer to the worker and detaches ALL typed-array views', async () => {
    const buf = new ArrayBuffer(1024);
    const view = new Uint8Array(buf);
    view[0] = 0x42;
    view[1023] = 0xff;

    // Pre-flight: enumerate every typed-array view of the buffer.
    const viewsBefore = common.getArrayBufferViews(buf);
    assert.ok(viewsBefore.length > 0, 'should enumerate at least one typed-array view');
    for (const v of viewsBefore) {
      assert.equal(v.buffer.byteLength, 1024, 'pre-transfer view should be full');
    }

    const result = await runtime.execute({
      type: 'inspect',
      payload: { buffer: buf },
      transferList: [buf],
      fn: (p) => {
        const v = new Uint8Array(p.buffer);
        return { byteLength: v.byteLength, first: v[0], last: v[1023] };
      },
    });

    assert.equal(result.byteLength, 1024);
    assert.equal(result.first, 0x42);
    assert.equal(result.last, 0xff);

    // Root buffer must be detached.
    assert.equal(buf.byteLength, 0, 'sender buffer must be detached after transfer');

    // Every captured view's underlying ArrayBuffer must be detached.
    for (const v of viewsBefore) {
      assert.equal(
        v.buffer.byteLength,
        0,
        `${v.constructor.name}'s ArrayBuffer must be detached after transfer`,
      );
    }
  });

  it('handles multiple ArrayBuffers in transferList', async () => {
    const a = new ArrayBuffer(64);
    const b = new ArrayBuffer(128);

    const result = await runtime.execute({
      type: 'inspect_two',
      payload: { a, b },
      transferList: [a, b],
      fn: (p) => ({ aLen: p.a.byteLength, bLen: p.b.byteLength }),
    });

    assert.equal(result.aLen, 64);
    assert.equal(result.bLen, 128);
    assert.equal(a.byteLength, 0);
    assert.equal(b.byteLength, 0);
  });

  it('routes a TypedArray view via transferList (the underlying buffer is transferred)', async () => {
    const u8 = new Uint8Array(256);
    u8[0] = 0xab;

    const result = await runtime.execute({
      type: 'view_check',
      payload: { view: u8 },
      transferList: [u8.buffer],
      fn: (p) => {
        const v = new Uint8Array(p.view);
        return { first: v[0], length: v.length };
      },
    });

    assert.equal(result.first, 0xab);
    assert.equal(result.length, 256);
    assert.equal(u8.buffer.byteLength, 0, 'underlying buffer must be detached');
  });

  it('falls back to structured clone when transferList is omitted', async () => {
    const buf = new ArrayBuffer(64);
    const view = new Uint8Array(buf);
    view[0] = 0x77;

    const result = await runtime.execute({
      type: 'inspect',
      payload: { buffer: buf },
      // no transferList
      fn: (p) => ({ first: new Uint8Array(p.buffer)[0] }),
    });

    assert.equal(result.first, 0x77);
    assert.equal(buf.byteLength, 64, 'sender buffer preserved when not in transferList');
  });
});
