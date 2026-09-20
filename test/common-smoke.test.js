import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as common from './common.js';

describe('test/common.js smoke', () => {
  it('exports platform constants', () => {
    assert.equal(typeof common.isWindows, 'boolean');
    assert.equal(typeof common.isLinux, 'boolean');
    assert.equal(typeof common.isMacOS, 'boolean');
  });

  it('exports mustCall / mustNotCall / mustCallAtLeast / mustSucceed', () => {
    assert.equal(typeof common.mustCall, 'function');
    assert.equal(typeof common.mustNotCall, 'function');
    assert.equal(typeof common.mustCallAtLeast, 'function');
    assert.equal(typeof common.mustSucceed, 'function');
  });

  it('mustCall wraps a function and tracks call count', () => {
    let counter = 0;
    const wrapped = common.mustCall(() => {
      counter++;
    }, 3);
    wrapped();
    wrapped();
    wrapped();
    assert.equal(counter, 3);
  });

  it('mustNotCall throws if invoked', () => {
    const wrapped = common.mustNotCall('test message');
    assert.throws(() => wrapped(), /test message/);
  });

  it('sleep returns a promise that resolves after ms', async () => {
    const start = Date.now();
    await common.sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 45, `expected ≥45ms, got ${elapsed}ms`);
  });

  it('sleepSync blocks the main thread for ms', () => {
    const start = Date.now();
    common.sleepSync(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 45, `expected ≥45ms, got ${elapsed}ms`);
  });

  it('platformTimeout multiplies correctly', () => {
    // On default CI (not Debug, not RISC-V, not AIX), platformTimeout returns ms unchanged
    const result = common.platformTimeout(1000);
    assert.equal(typeof result, 'number');
    assert.ok(result >= 1000, `expected ≥1000, got ${result}`);
  });

  it('getArrayBufferViews returns all typed-array views', () => {
    const buf = new ArrayBuffer(16);
    const views = common.getArrayBufferViews(buf);
    assert.ok(views.length > 0);
    for (const v of views) {
      assert.equal(v.byteLength, 16);
    }
  });

  it('getBufferSources includes the underlying ArrayBuffer', () => {
    const buf = new ArrayBuffer(16);
    const sources = common.getBufferSources(buf);
    assert.ok(sources.includes(buf));
  });
});
