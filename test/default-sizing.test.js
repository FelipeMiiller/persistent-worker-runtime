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
import * as common from './common.js';

describe('ADR-0019: Default worker pool sizing and resourceLimits validation', () => {
  let runtime;

  afterEach(async () => {
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
    let fired = null;
    const trap = (warning) => {
      fired = warning;
    };
    process.on('warning', trap);
    try {
      runtime = await createWorkerRuntime({ workers: 3 });
      assert.equal(runtime.stats.totalWorkers, 3);
    } finally {
      process.off('warning', trap);
    }
    assert.equal(
      fired,
      null,
      `explicit workers:N must suppress the PersistentWorkerRuntimeDefaultSizing warning, but got: ${fired?.name ?? 'unknown'}`,
    );
  });

  // 3) ADR §Verification — On a host with >4 cores, default sizing emits the
  //    PersistentWorkerRuntimeDefaultSizing warning. Skipped on small hosts.
  it('emits PersistentWorkerRuntimeDefaultSizing warning when default is taken on >4-core host', async () => {
    if (availableParallelism() <= 4) {
      // The other branch is exercised on this run; nothing to assert here.
      return;
    }
    // Set up the warning promise BEFORE createWorkerRuntime so we don't
    // miss the asynchronous fire. awaitWarning auto-unsubscribes after
    // matching (or timeout).
    const warningPromise = common.awaitWarning(
      'PersistentWorkerRuntimeDefaultSizing',
      /started with default workers=1 on a \d+-core host/,
      3000,
    );
    runtime = await createWorkerRuntime({});
    const warning = await warningPromise;
    assert.equal(warning.name, 'PersistentWorkerRuntimeDefaultSizing');
    assert.equal(runtime.stats.totalWorkers, 1);
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
    let fired = null;
    const trap = (warning) => {
      fired = warning;
    };
    process.on('warning', trap);
    try {
      runtime = await createWorkerRuntime({});
      assert.equal(runtime.stats.totalWorkers, 1);
    } finally {
      process.off('warning', trap);
    }
    assert.equal(
      fired,
      null,
      `small hosts must not be nagged with the sizing warning, but got: ${fired?.name ?? 'unknown'}`,
    );
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
