/**
 * Tests for the Adaptive Concurrency Controller (ADR-0014).
 *
 * T2 coverage:
 *   - `Ewma` arithmetic correctness (hand-computed values for α = 0.3)
 *   - `Ewma` validation (alpha bounds, finite numbers)
 *   - `SignalMonitor` lifecycle (start / stop / sample)
 *   - Controller `tick()` integration (stats.elu, stats.latencyP99Ms,
 *     ticksSinceResize) and start / stop timer wiring.
 *
 * T3+ coverage (debounce, decision matrix, resize actions, runtime
 * integration) lands in subsequent suites.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createAdaptiveController, Ewma, SignalMonitor } from '../src/adaptive-controller.js';

/**
 * Asserts `actual ≈ expected` within a small tolerance for IEEE 754
 * floating-point arithmetic. EWMA hand-computed values like
 * `0.7 * 7 = 4.8999999999999995` cannot use strict `assert.equal`,
 * but they are correct within `1e-9`. The tolerance is large enough
 * to absorb any rounding from `(1 - α) * value` products.
 *
 * @param {number} actual
 * @param {number} expected
 * @param {number} [epsilon=1e-9]
 */
function assertApproxEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${expected} ± ${epsilon}, got ${actual}`,
  );
}

describe('Ewma', () => {
  test('default alpha is 0.3 (first sample seeds verbatim)', () => {
    const ewma = new Ewma();
    ewma.update(10);
    assert.equal(ewma.value(), 10);
  });

  test('initial value() is null (no samples yet)', () => {
    const ewma = new Ewma(0.3);
    assert.equal(ewma.value(), null);
  });

  test('first update seeds the average with the input verbatim', () => {
    const ewma = new Ewma(0.3);
    ewma.update(7.5);
    assert.equal(ewma.value(), 7.5);
  });

  test('constant input keeps the average constant', () => {
    const ewma = new Ewma(0.3);
    ewma.update(5);
    ewma.update(5);
    ewma.update(5);
    assert.equal(ewma.value(), 5);
  });

  test('drops from 10 toward 0 with α=0.3 (hand-computed)', () => {
    const ewma = new Ewma(0.3);
    ewma.update(10);
    ewma.update(0); // 0.3 * 0 + 0.7 * 10 = 7
    assertApproxEqual(ewma.value(), 7);
    ewma.update(0); // 0.3 * 0 + 0.7 * 7 = 4.9
    assertApproxEqual(ewma.value(), 4.9);
    ewma.update(0); // 0.3 * 0 + 0.7 * 4.9 = 3.43
    assertApproxEqual(ewma.value(), 3.43);
  });

  test('rises from 0 toward 1 with α=0.3 (hand-computed)', () => {
    const ewma = new Ewma(0.3);
    ewma.update(0);
    ewma.update(1); // 0.3 * 1 + 0.7 * 0 = 0.3
    assertApproxEqual(ewma.value(), 0.3);
    ewma.update(1); // 0.3 * 1 + 0.7 * 0.3 = 0.51
    assertApproxEqual(ewma.value(), 0.51);
    ewma.update(1); // 0.3 * 1 + 0.7 * 0.51 = 0.657
    assertApproxEqual(ewma.value(), 0.657);
  });

  test('custom alpha applies the same formula (α=0.5 sanity check)', () => {
    const ewma = new Ewma(0.5);
    ewma.update(0);
    ewma.update(10); // 0.5 * 10 + 0.5 * 0 = 5
    assertApproxEqual(ewma.value(), 5);
    ewma.update(10); // 0.5 * 10 + 0.5 * 5 = 7.5
    assertApproxEqual(ewma.value(), 7.5);
  });

  test('rejects non-finite alpha', () => {
    assert.throws(() => new Ewma(Number.NaN), TypeError);
    assert.throws(() => new Ewma(Number.POSITIVE_INFINITY), TypeError);
    assert.throws(() => new Ewma('0.3'), TypeError);
    assert.throws(() => new Ewma(null), TypeError);
  });

  test('rejects alpha outside the open interval (0, 1)', () => {
    assert.throws(() => new Ewma(0), RangeError);
    assert.throws(() => new Ewma(1), RangeError);
    assert.throws(() => new Ewma(-0.1), RangeError);
    assert.throws(() => new Ewma(1.5), RangeError);
  });

  test('rejects non-finite update values', () => {
    const ewma = new Ewma();
    assert.throws(() => ewma.update(Number.NaN), TypeError);
    assert.throws(() => ewma.update(Number.POSITIVE_INFINITY), TypeError);
    assert.throws(() => ewma.update('10'), TypeError);
    assert.throws(() => ewma.update(null), TypeError);
  });
});

describe('SignalMonitor', () => {
  test('constructs without throwing', () => {
    const monitor = new SignalMonitor();
    assert.ok(monitor);
  });

  test('start() and stop() are idempotent (no crash on repeat)', () => {
    const monitor = new SignalMonitor();
    monitor.start();
    monitor.start();
    monitor.stop();
    monitor.stop();
    assert.ok(true);
  });

  test('sample() returns { elu, latencyP99 } with numeric fields', () => {
    const monitor = new SignalMonitor();
    monitor.start();
    const sample = monitor.sample();
    assert.equal(typeof sample.elu, 'number');
    assert.equal(typeof sample.latencyP99, 'number');
    monitor.stop();
  });

  test('first sample.elu is 0 (no prevElu baseline yet)', () => {
    const monitor = new SignalMonitor();
    monitor.start();
    const first = monitor.sample();
    assert.equal(first.elu, 0);
    monitor.stop();
  });

  test('subsequent sample().elu is in [0, 1] for a typical idle tick', () => {
    const monitor = new SignalMonitor();
    monitor.start();
    monitor.sample(); // First call seeds prevElu; returns elu=0
    const second = monitor.sample();
    assert.ok(second.elu >= 0 && second.elu <= 1, `elu=${second.elu} should be in [0, 1]`);
    monitor.stop();
  });

  test('sample() can be called repeatedly without leaking state', () => {
    const monitor = new SignalMonitor();
    monitor.start();
    for (let i = 0; i < 10; i++) monitor.sample();
    monitor.stop();
    assert.ok(true);
  });
});

describe('createAdaptiveController — T2 tick integration', () => {
  test('getStats() returns the documented shape with null signals initially', () => {
    const controller = createAdaptiveController({ minWorkers: 1, maxWorkers: 4 });
    const stats = controller.getStats();
    assert.equal(typeof stats.enabled, 'boolean');
    assert.equal(stats.enabled, true);
    assert.equal(stats.elu, null);
    assert.equal(stats.latencyP99Ms, null);
    assert.equal(stats.effectiveWorkers, 1);
    assert.equal(stats.ticksSinceResize, 0);
    assert.equal(stats.lastResizeReason, null);
    assert.equal(stats.lastResizeAt, null);
  });

  test('first tick() initializes stats.elu and stats.latencyP99Ms', () => {
    const controller = createAdaptiveController({ minWorkers: 1, maxWorkers: 4 });
    controller.tick();
    const stats = controller.getStats();
    assert.equal(typeof stats.elu, 'number');
    assert.equal(typeof stats.latencyP99Ms, 'number');
    assert.equal(stats.ticksSinceResize, 1);
  });

  test('each tick() increments ticksSinceResize', () => {
    const controller = createAdaptiveController({ minWorkers: 1, maxWorkers: 4 });
    controller.tick();
    controller.tick();
    controller.tick();
    assert.equal(controller.getStats().ticksSinceResize, 3);
  });

  test('start() arms a timer that fires tick() at samplingCadenceMs', async () => {
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      samplingCadenceMs: 20,
    });
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 75));
    controller.stop();
    // 75ms / 20ms cadence ≈ 3-4 ticks fired (allow for jitter)
    const ticks = controller.getStats().ticksSinceResize;
    assert.ok(ticks >= 2 && ticks <= 5, `expected 2-5 ticks, got ${ticks}`);
  });

  test('stop() cancels the timer (no further ticks after stop)', async () => {
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      samplingCadenceMs: 20,
    });
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.stop();
    const ticksAtStop = controller.getStats().ticksSinceResize;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const ticksAfter = controller.getStats().ticksSinceResize;
    assert.equal(ticksAfter, ticksAtStop, 'ticks must not advance after stop()');
  });

  test('enabled: false is reflected in stats and ticks still run', () => {
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      enabled: false,
    });
    assert.equal(controller.getStats().enabled, false);
    controller.tick();
    assert.equal(controller.getStats().ticksSinceResize, 1);
  });
});
