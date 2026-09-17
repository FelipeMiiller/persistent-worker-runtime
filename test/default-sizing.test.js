/**
 * Tests for ADR-0019: Default worker pool size reduced from
 * `availableParallelism() - 1` to `1` with a startup warning on hosts with
 * >4 cores, plus validation of `options.resourceLimits`.
 *
 * Spec: docs/adr/0019-default-workers-reduced-from-availableparallelism-to-1.md
 * @see §Verification (4 required tests) and §2 resourceLimits validation.
 */
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import { createWorkerRuntime } from '../src/index.js';

describe('ADR-0019: Default worker pool sizing and resourceLimits validation', () => {
  let runtime;

  // Capture every Node process warning emitted during a test scope so we can
  // assert on the optional PersistentWorkerRuntimeDefaultSizing code. We
  // monkey-patch `process.emitWarning` rather than relying on the
  // `'warning'` event because the Node test runner installs its own internal
  // warning handlers, and emitted warnings can race with listener attachment.
  let warnings;
  let originalEmitWarning;

  function captureWarnings() {
    warnings = [];
    originalEmitWarning = process.emitWarning;
    process.emitWarning = function patchedEmitWarning(warning, ...args) {
      const opts = args[0];
      const code = typeof opts === 'string' ? opts : opts?.code;
      warnings.push({ message: String(warning), code });
      // Intentionally do NOT forward to the original emitWarning — this keeps
      // the test output clean and prevents the Node test runner from
      // converting the warning into a test-report diagnostic.
    };
    return () => {
      process.emitWarning = originalEmitWarning;
      originalEmitWarning = null;
      warnings = null;
    };
  }

  function sizingWarnings() {
    return warnings.filter((w) => w.code === 'PersistentWorkerRuntimeDefaultSizing');
  }

  afterEach(async () => {
    if (originalEmitWarning) {
      process.emitWarning = originalEmitWarning;
      originalEmitWarning = null;
      warnings = null;
    }
    if (runtime) {
      await runtime.shutdown();
      runtime = null;
    }
  });

  // 1) ADR §Verification — Default size is 1 when no `workers` option is given.
  it('uses default workers=1 when no workers option is provided', async () => {
    runtime = await createWorkerRuntime({});
    assert.equal(runtime.stats.totalWorkers, 1, 'default pool size must be 1 per ADR-0019');
  });

  // 2) ADR §Verification — Explicit `workers: N` produces N workers and
  //    suppresses the default-sizing warning regardless of host size.
  it('respects an explicit workers:N and emits no default-sizing warning', async () => {
    const stop = captureWarnings();
    try {
      runtime = await createWorkerRuntime({ workers: 3 });
      assert.equal(runtime.stats.totalWorkers, 3);
      // Let any pending warning event drain through the Event Loop.
      await new Promise((r) => setImmediate(r));
      assert.equal(
        sizingWarnings().length,
        0,
        'explicit workers:N must suppress the PersistentWorkerRuntimeDefaultSizing warning',
      );
    } finally {
      stop();
    }
  });

  // 3) ADR §Verification — On a host with >4 cores, default sizing emits the
  //    PersistentWorkerRuntimeDefaultSizing warning. Skipped on small hosts.
  it('emits PersistentWorkerRuntimeDefaultSizing warning when default is taken on >4-core host', async () => {
    if (availableParallelism() <= 4) {
      // The other branch is exercised on this run; nothing to assert here.
      return;
    }
    const stop = captureWarnings();
    try {
      runtime = await createWorkerRuntime({});
      assert.equal(runtime.stats.totalWorkers, 1);
      await new Promise((r) => setImmediate(r));
      const found = sizingWarnings();
      assert.equal(found.length, 1, 'expected exactly one sizing warning');
      assert.match(found[0].message, /workers=1/);
      assert.match(found[0].message, /core host/);
      assert.match(found[0].message, /createWorkerRuntime\(\{ workers: N \}\)/);
    } finally {
      stop();
    }
  });

  // 4) ADR §Verification — On a host with ≤4 cores, default sizing emits
  //    NO warning (don't nag small hosts). Skipped on hosts that can't
  //    observe this branch naturally; the >4-core branch test above
  //    confirms the inverse.
  it('does NOT emit default-sizing warning when default is taken on ≤4-core host', async () => {
    if (availableParallelism() > 4) {
      // Cannot simulate a smaller host without DI/mocking hooks; skip on big boxes.
      return;
    }
    const stop = captureWarnings();
    try {
      runtime = await createWorkerRuntime({});
      assert.equal(runtime.stats.totalWorkers, 1);
      await new Promise((r) => setImmediate(r));
      assert.equal(
        sizingWarnings().length,
        0,
        'small hosts must not be nagged with the sizing warning',
      );
    } finally {
      stop();
    }
  });

  // 5) ADR §2 — resourceLimits must be an object or undefined.
  it('throws TypeError when resourceLimits is not an object (string)', async () => {
    await assert.rejects(
      () => createWorkerRuntime({ resourceLimits: 'invalid' }),
      (err) => {
        assert.ok(
          err instanceof TypeError,
          `expected TypeError, got ${err.constructor.name}: ${err.message}`,
        );
        assert.match(err.message, /resourceLimits must be an object/);
        return true;
      },
    );
  });

  it('throws TypeError when resourceLimits is null', async () => {
    await assert.rejects(
      () => createWorkerRuntime({ resourceLimits: null }),
      (err) => err instanceof TypeError,
    );
  });

  it('throws TypeError when resourceLimits is a number', async () => {
    await assert.rejects(
      () => createWorkerRuntime({ resourceLimits: 42 }),
      (err) => err instanceof TypeError,
    );
  });

  // 6) ADR §2 — Each known resourceLimits key, if present, must be a
  //    positive number.
  it('throws RangeError when resourceLimits value is negative', async () => {
    await assert.rejects(
      () => createWorkerRuntime({ resourceLimits: { maxOldGenerationSizeMb: -1 } }),
      (err) => {
        assert.ok(err instanceof RangeError, `expected RangeError, got ${err.constructor.name}`);
        assert.match(err.message, /maxOldGenerationSizeMb/);
        return true;
      },
    );
  });

  it('throws RangeError when resourceLimits value is zero', async () => {
    await assert.rejects(
      () => createWorkerRuntime({ resourceLimits: { maxOldGenerationSizeMb: 0 } }),
      (err) => err instanceof RangeError,
    );
  });

  it('throws RangeError when resourceLimits value is non-numeric', async () => {
    await assert.rejects(
      () => createWorkerRuntime({ resourceLimits: { stackSizeMb: 'lots' } }),
      (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /stackSizeMb/);
        return true;
      },
    );
  });

  // Positive case — valid resourceLimits must round-trip without error.
  it('accepts a fully valid resourceLimits object without throwing', async () => {
    runtime = await createWorkerRuntime({
      resourceLimits: {
        maxOldGenerationSizeMb: 512,
        maxYoungGenerationSizeMb: 16,
        codeRangeSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    assert.ok(runtime, 'runtime created successfully with valid resourceLimits');
    assert.equal(runtime.stats.totalWorkers, 1);
  });

  // Empty resourceLimits object is valid (all keys undefined → skipped).
  it('accepts an empty resourceLimits object', async () => {
    runtime = await createWorkerRuntime({ resourceLimits: {} });
    assert.ok(runtime);
  });

  // resourceLimits with only some keys set is valid; omitted keys are skipped.
  it('accepts a partial resourceLimits object (only some keys set)', async () => {
    runtime = await createWorkerRuntime({ resourceLimits: { maxOldGenerationSizeMb: 256 } });
    assert.ok(runtime);
  });
});
