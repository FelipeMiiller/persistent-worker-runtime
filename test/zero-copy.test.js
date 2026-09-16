import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerRuntime } from '../src/index.js';

describe('Zero-Copy ArrayBuffer Transfer', () => {
  let runtime;

  before(async () => {
    runtime = await createWorkerRuntime({ workers: 1 });
  });

  after(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('transfers a single ArrayBuffer to the worker and detaches it on the sender', async () => {
    const buf = new ArrayBuffer(1024);
    const view = new Uint8Array(buf);
    view[0] = 0x42;
    view[1023] = 0xff;

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
    assert.equal(buf.byteLength, 0, 'sender buffer must be detached after transfer');
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
