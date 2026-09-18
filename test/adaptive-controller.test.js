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
 * T3 coverage:
 *   - `DebounceCounter` consecutive-tick accumulation
 *   - Direction-flip reset to 1
 *   - Threshold fire (default 5 and custom)
 *   - No double-fire after threshold (post-fire reset)
 *   - `'noop'` breaks an active streak
 *   - `reset()` / `value()` / `onFire()` lifecycle
 *   - Validation (threshold bounds, direction enum, listener type)
 *
 * T4 coverage:
 *   - `spawnWorker()` invokes the injected `spawnIdleWorker` callback
 *     and fires the listener with `reason: 'grow'`
 *   - `retireLowestLoadWorker()` invokes the injected
 *     `retireLowestLoadWorker` callback and fires with
 *     `reason: 'shrink'`
 *   - `worker:retiring` runtime event emitted on successful retire
 *     with `{ workerId, reason: 'drain' }`
 *   - Stats fields mutate correctly on resize (`effectiveWorkers`,
 *     `ticksSinceResize`, `lastResizeReason`, `lastResizeAt`)
 *   - Graceful no-op on missing callback / throwing callback /
 *     non-string return
 *   - `ResizeEvent` shape includes `signals` (current EWMA snapshot
 *     or `null` before any tick)
 *
 * T5+ coverage (decision matrix, WorkerRuntime integration, telemetry
 * block on `runtime.stats`, integration tests) lands in subsequent
 * suites.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createAdaptiveController,
  DebounceCounter,
  Ewma,
  SignalMonitor,
} from '../src/adaptive-controller.js';

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

describe('DebounceCounter', () => {
  test('default threshold is 5; value() is 0 before any note()', () => {
    const debounce = new DebounceCounter();
    assert.equal(debounce.value(), 0);
  });

  test('first note() sets the counter to 1 regardless of direction', () => {
    const debounce = new DebounceCounter();
    debounce.note('grow');
    assert.equal(debounce.value(), 1);
  });

  test('consecutive notes in the same direction increment the counter', () => {
    const debounce = new DebounceCounter();
    debounce.note('grow');
    assert.equal(debounce.value(), 1);
    debounce.note('grow');
    assert.equal(debounce.value(), 2);
    debounce.note('grow');
    assert.equal(debounce.value(), 3);
    debounce.note('grow');
    assert.equal(debounce.value(), 4);
  });

  test('does not fire before the threshold is reached', () => {
    const debounce = new DebounceCounter();
    let fires = 0;
    debounce.onFire(() => fires++);
    for (let i = 0; i < 4; i++) debounce.note('grow');
    assert.equal(fires, 0);
    assert.equal(debounce.value(), 4);
  });

  test('fires exactly once on the 5th consecutive note() in the same direction', () => {
    const debounce = new DebounceCounter();
    /** @type {{ reason: string, at: number }[]} */
    const events = [];
    debounce.onFire((e) => events.push(e));
    for (let i = 0; i < 5; i++) debounce.note('shrink');
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'shrink');
    assert.equal(typeof events[0].at, 'number');
    assert.ok(events[0].at > 0);
  });

  test('no double-fire: count resets to 0 after fire; next same-direction note() starts at 1', () => {
    const debounce = new DebounceCounter();
    let fires = 0;
    debounce.onFire(() => fires++);
    for (let i = 0; i < 5; i++) debounce.note('grow'); // fire #1
    assert.equal(fires, 1);
    assert.equal(debounce.value(), 0);
    // Continuing in the same direction must NOT fire on the next 5 ticks —
    // it starts a fresh window at 1.
    for (let i = 0; i < 4; i++) debounce.note('grow');
    assert.equal(fires, 1);
    assert.equal(debounce.value(), 4);
    debounce.note('grow'); // 5th of the new window
    assert.equal(fires, 2);
    assert.equal(debounce.value(), 0);
  });

  test('direction flip resets the counter to 1 (not 0)', () => {
    const debounce = new DebounceCounter();
    debounce.note('grow');
    debounce.note('grow');
    debounce.note('grow');
    assert.equal(debounce.value(), 3);
    debounce.note('shrink');
    assert.equal(debounce.value(), 1);
  });

  test('a single noop tick breaks an active streak', () => {
    const debounce = new DebounceCounter();
    let fires = 0;
    debounce.onFire(() => fires++);
    debounce.note('grow');
    debounce.note('grow');
    debounce.note('grow');
    debounce.note('grow'); // 4 grow ticks — would fire on the 5th
    debounce.note('noop'); // breaks streak — counts as flip, count resets to 1
    assert.equal(debounce.value(), 1);
    // Resuming grow starts fresh: the very first grow after noop is
    // itself a flip (noop → grow), so it resets to 1, not 5. Four more
    // grow ticks bring the counter back up to 4 — NOT 5, which proves
    // the noop actually broke the streak.
    debounce.note('grow'); // flip noop → grow, count = 1
    debounce.note('grow'); // 2
    debounce.note('grow'); // 3
    debounce.note('grow'); // 4
    assert.equal(debounce.value(), 4);
    assert.equal(fires, 0, 'noop must reset the streak — no premature fire');
    debounce.note('grow'); // 5th of the new window
    assert.equal(fires, 1);
  });

  test('noop can build its own streak (noop → noop → noop fires on the 5th)', () => {
    const debounce = new DebounceCounter();
    let fires = 0;
    debounce.onFire(() => fires++);
    for (let i = 0; i < 5; i++) debounce.note('noop');
    assert.equal(fires, 1);
  });

  test('reset() clears both the counter and the current direction', () => {
    const debounce = new DebounceCounter();
    debounce.note('grow');
    debounce.note('grow');
    debounce.note('grow');
    assert.equal(debounce.value(), 3);
    debounce.reset();
    assert.equal(debounce.value(), 0);
    // After reset, the next note() (any direction) starts a fresh streak
    // at 1 — not picking up where the old streak left off.
    debounce.note('grow');
    assert.equal(debounce.value(), 1);
  });

  test('onFire() returns an idempotent unsubscribe function', () => {
    const debounce = new DebounceCounter();
    let fires = 0;
    const unsubscribe = debounce.onFire(() => fires++);
    for (let i = 0; i < 5; i++) debounce.note('grow');
    assert.equal(fires, 1);
    const removed = unsubscribe();
    assert.equal(removed, true);
    const removedAgain = unsubscribe();
    assert.equal(removedAgain, false);
    for (let i = 0; i < 5; i++) debounce.note('grow');
    assert.equal(fires, 1, 'listener must not fire after unsubscribe');
  });

  test('multiple listeners all fire in registration order', () => {
    const debounce = new DebounceCounter();
    /** @type {string[]} */
    const order = [];
    debounce.onFire(() => order.push('first'));
    debounce.onFire(() => order.push('second'));
    debounce.onFire(() => order.push('third'));
    for (let i = 0; i < 5; i++) debounce.note('grow');
    assert.deepEqual(order, ['first', 'second', 'third']);
  });

  test('custom threshold fires at the configured tick count', () => {
    const debounce = new DebounceCounter(2);
    let fires = 0;
    debounce.onFire(() => fires++);
    debounce.note('grow');
    assert.equal(fires, 0);
    debounce.note('grow');
    assert.equal(fires, 1);
    assert.equal(debounce.value(), 0);
  });

  test('threshold = 1 fires immediately on the first note()', () => {
    const debounce = new DebounceCounter(1);
    let fires = 0;
    debounce.onFire(() => fires++);
    debounce.note('grow');
    assert.equal(fires, 1);
    assert.equal(debounce.value(), 0);
  });

  test('rejects non-finite threshold', () => {
    assert.throws(() => new DebounceCounter(Number.NaN), TypeError);
    assert.throws(() => new DebounceCounter(Number.POSITIVE_INFINITY), TypeError);
    assert.throws(() => new DebounceCounter('5'), TypeError);
    assert.throws(() => new DebounceCounter(null), TypeError);
  });

  test('rejects threshold outside [1, Infinity)', () => {
    assert.throws(() => new DebounceCounter(0), RangeError);
    assert.throws(() => new DebounceCounter(-1), RangeError);
    assert.throws(() => new DebounceCounter(0.5), RangeError, /integer/);
  });

  test('rejects unknown direction in note()', () => {
    const debounce = new DebounceCounter();
    assert.throws(() => debounce.note('unknown'), TypeError);
    assert.throws(() => debounce.note(''), TypeError);
    assert.throws(() => debounce.note(null), TypeError);
    assert.throws(() => debounce.note(undefined), TypeError);
    assert.throws(() => debounce.note(42), TypeError);
  });

  test('rejects non-function listener in onFire()', () => {
    const debounce = new DebounceCounter();
    assert.throws(() => debounce.onFire(null), TypeError);
    assert.throws(() => debounce.onFire('not-a-fn'), TypeError);
    assert.throws(() => debounce.onFire(42), TypeError);
    assert.throws(() => debounce.onFire({}), TypeError);
  });
});

describe('createAdaptiveController — T4 resize actions', () => {
  test('spawnWorker() calls spawnIdleWorker callback and increments effectiveWorkers', async () => {
    let spawnCalls = 0;
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => {
        spawnCalls++;
        return `w-${spawnCalls}`;
      },
    });
    assert.equal(controller.getStats().effectiveWorkers, 1);
    const ok = await controller.spawnWorker();
    assert.equal(ok, true);
    assert.equal(spawnCalls, 1);
    assert.equal(controller.getStats().effectiveWorkers, 2);
  });

  test('spawnWorker() fires onResize listener with reason=grow + signals snapshot', async () => {
    /** @type {Array<import('../src/adaptive-controller.js').ResizeEvent>} */
    const events = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
    });
    controller.onResize((e) => events.push(e));
    await controller.spawnWorker();
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'grow');
    assert.equal(events[0].effectiveWorkers, 2);
    assert.equal(typeof events[0].at, 'number');
    assert.ok(events[0].at > 0);
    // No ticks yet → signals must be null on the resize event.
    assert.equal(events[0].signals.elu, null);
    assert.equal(events[0].signals.latencyP99Ms, null);
  });

  test('spawnWorker() reflects EWMA values in ResizeEvent.signals after ticks', async () => {
    /** @type {Array<import('../src/adaptive-controller.js').ResizeEvent>} */
    const events = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
    });
    controller.onResize((e) => events.push(e));
    // 3 ticks → both EWMAs have numeric values.
    controller.tick();
    controller.tick();
    controller.tick();
    await controller.spawnWorker();
    assert.equal(typeof events[0].signals.elu, 'number');
    assert.equal(typeof events[0].signals.latencyP99Ms, 'number');
  });

  test('spawnWorker() is a graceful no-op when no spawnIdleWorker callback', async () => {
    /** @type {Array<unknown>} */
    const events = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
    });
    controller.onResize((e) => events.push(e));
    const ok = await controller.spawnWorker();
    assert.equal(ok, false);
    assert.equal(events.length, 0);
    assert.equal(controller.getStats().effectiveWorkers, 1);
  });

  test('spawnWorker() returns false on callback rejection (no state change, no event)', async () => {
    /** @type {Array<unknown>} */
    const events = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => {
        throw new Error('spawn failed');
      },
    });
    controller.onResize((e) => events.push(e));
    const ok = await controller.spawnWorker();
    assert.equal(ok, false);
    assert.equal(events.length, 0);
    assert.equal(controller.getStats().effectiveWorkers, 1);
  });

  test('spawnWorker() returns false when callback resolves to null/empty/non-string', async () => {
    /** @type {Array<unknown>} */
    const events = [];
    for (const badReturn of [null, undefined, '', 42, {}, []]) {
      const controller = createAdaptiveController({
        minWorkers: 1,
        maxWorkers: 4,
        spawnIdleWorker: async () => /** @type {any} */ (badReturn),
      });
      controller.onResize((e) => events.push(e));
      const ok = await controller.spawnWorker();
      assert.equal(ok, false, `badReturn=${JSON.stringify(badReturn)} should yield false`);
      assert.equal(controller.getStats().effectiveWorkers, 1);
    }
    assert.equal(events.length, 0);
  });

  test('retireLowestLoadWorker() calls retire callback and fires with reason=shrink', async () => {
    /** @type {Array<import('../src/adaptive-controller.js').ResizeEvent>} */
    const events = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
      retireLowestLoadWorker: async () => 'w-1',
    });
    controller.onResize((e) => events.push(e));
    // Grow to 3 first so the retire is meaningful.
    await controller.spawnWorker();
    await controller.spawnWorker();
    assert.equal(controller.getStats().effectiveWorkers, 3);
    events.length = 0; // discard grow events

    const ok = await controller.retireLowestLoadWorker();
    assert.equal(ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'shrink');
    assert.equal(events[0].effectiveWorkers, 2);
  });

  test('retireLowestLoadWorker() emits worker:retiring with { workerId, reason: drain } BEFORE shrink', async () => {
    /** @type {Array<{ event: string, payload: any, workersAtEmit: number }>} */
    const emitted = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
      retireLowestLoadWorker: async () => 'w-1',
      events: {
        emit: (event, payload) =>
          emitted.push({
            event,
            payload,
            workersAtEmit: controller.getStats().effectiveWorkers,
          }),
      },
    });
    /** @type {Array<{ reason: string, effectiveWorkers: number }>} */
    const resize = [];
    controller.onResize((e) =>
      resize.push({ reason: e.reason, effectiveWorkers: e.effectiveWorkers }),
    );

    await controller.spawnWorker(); // 2 workers
    await controller.spawnWorker(); // 3 workers
    emitted.length = 0;
    resize.length = 0;

    await controller.retireLowestLoadWorker();
    // worker:retiring fired with the pre-retire worker count (3),
    // proving the event lands BEFORE effectiveWorkers is decremented.
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'worker:retiring');
    assert.deepEqual(emitted[0].payload, { workerId: 'w-1', reason: 'drain' });
    assert.equal(emitted[0].workersAtEmit, 3);
    // Resize event lands AFTER with the post-retire count.
    assert.equal(resize.length, 1);
    assert.equal(resize[0].reason, 'shrink');
    assert.equal(resize[0].effectiveWorkers, 2);
  });

  test('retireLowestLoadWorker() does NOT emit worker:retiring when callback returns null', async () => {
    /** @type {Array<unknown>} */
    const emitted = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      retireLowestLoadWorker: async () => null,
      events: { emit: (event) => emitted.push(event) },
    });
    /** @type {Array<unknown>} */
    const events = [];
    controller.onResize((e) => events.push(e));
    const ok = await controller.retireLowestLoadWorker();
    assert.equal(ok, false);
    assert.equal(emitted.length, 0, 'worker:retiring must not fire on no-op retire');
    assert.equal(events.length, 0);
    assert.equal(controller.getStats().effectiveWorkers, 1);
  });

  test('retireLowestLoadWorker() is a graceful no-op when no retire callback', async () => {
    /** @type {Array<unknown>} */
    const events = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
    });
    controller.onResize((e) => events.push(e));
    const ok = await controller.retireLowestLoadWorker();
    assert.equal(ok, false);
    assert.equal(events.length, 0);
    assert.equal(controller.getStats().effectiveWorkers, 1);
  });

  test('retireLowestLoadWorker() returns false on callback rejection (no state change, no event)', async () => {
    /** @type {Array<unknown>} */
    const emitted = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      retireLowestLoadWorker: async () => {
        throw new Error('drain timeout');
      },
      events: { emit: (event) => emitted.push(event) },
    });
    /** @type {Array<unknown>} */
    const events = [];
    controller.onResize((e) => events.push(e));
    const ok = await controller.retireLowestLoadWorker();
    assert.equal(ok, false);
    assert.equal(emitted.length, 0);
    assert.equal(events.length, 0);
    assert.equal(controller.getStats().effectiveWorkers, 1);
  });

  test('worker:retiring emission is silently skipped when no events emitter configured', async () => {
    // No `events` option — the controller must not crash.
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
      retireLowestLoadWorker: async () => 'w-1',
    });
    await controller.spawnWorker();
    const ok = await controller.retireLowestLoadWorker();
    assert.equal(ok, true);
    assert.equal(controller.getStats().effectiveWorkers, 1);
  });

  test('resize stats fields (effectiveWorkers, ticksSinceResize, lastResizeReason, lastResizeAt) all update', async () => {
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
      retireLowestLoadWorker: async () => 'w-1',
    });
    controller.tick();
    controller.tick();
    controller.tick();
    assert.equal(controller.getStats().effectiveWorkers, 1);
    assert.equal(controller.getStats().ticksSinceResize, 3);
    assert.equal(controller.getStats().lastResizeReason, null);
    assert.equal(controller.getStats().lastResizeAt, null);

    await controller.spawnWorker();
    assert.equal(controller.getStats().effectiveWorkers, 2);
    assert.equal(
      controller.getStats().ticksSinceResize,
      0,
      'ticksSinceResize resets to 0 after resize',
    );
    assert.equal(controller.getStats().lastResizeReason, 'grow');
    assert.ok(
      typeof controller.getStats().lastResizeAt === 'number' &&
        controller.getStats().lastResizeAt > 0,
    );

    controller.tick();
    controller.tick();
    assert.equal(controller.getStats().ticksSinceResize, 2);

    await controller.retireLowestLoadWorker();
    assert.equal(controller.getStats().effectiveWorkers, 1);
    assert.equal(controller.getStats().ticksSinceResize, 0);
    assert.equal(controller.getStats().lastResizeReason, 'shrink');
  });

  test('multiple resize listeners all fire in registration order (snapshot semantics)', async () => {
    /** @type {string[]} */
    const order = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
    });
    controller.onResize(() => order.push('first'));
    controller.onResize(() => order.push('second'));
    controller.onResize(() => order.push('third'));
    await controller.spawnWorker();
    assert.deepEqual(order, ['first', 'second', 'third']);
  });

  test('multiple sequential resizes fire listeners each time with fresh stats', async () => {
    /** @type {Array<import('../src/adaptive-controller.js').ResizeEvent>} */
    const events = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
      retireLowestLoadWorker: async () => 'w-1',
    });
    controller.onResize((e) => events.push(e));

    await controller.spawnWorker(); // 1 → 2
    await controller.spawnWorker(); // 2 → 3
    await controller.spawnWorker(); // 3 → 4
    await controller.retireLowestLoadWorker(); // 4 → 3
    await controller.retireLowestLoadWorker(); // 3 → 2

    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((e) => [e.reason, e.effectiveWorkers]),
      [
        ['grow', 2],
        ['grow', 3],
        ['grow', 4],
        ['shrink', 3],
        ['shrink', 2],
      ],
    );
  });
});

describe('createAdaptiveController — T1-T4 hardening (failure modes + contract guarantees)', () => {
  test('Ewma.value() returns null before any update()', () => {
    const e = new Ewma(0.3);
    assert.equal(e.value(), null);
  });

  test('start() is idempotent — calling it twice does not arm two timers', async () => {
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      samplingCadenceMs: 20,
    });
    controller.start();
    controller.start(); // second call must be a no-op, not double-armed
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.stop();
    // 100ms / 20ms cadence ≈ 5 ticks; if start() had armed two
    // timers we'd see 10. Allow generous upper bound for jitter.
    const ticks = controller.getStats().ticksSinceResize;
    assert.ok(ticks >= 2 && ticks <= 8, `expected 2-8 ticks, got ${ticks}`);
  });

  test('stop() before start() is a safe no-op (no crash, no leftover state)', () => {
    const controller = createAdaptiveController({ minWorkers: 1, maxWorkers: 4 });
    assert.doesNotThrow(() => controller.stop());
    // After stop()-without-start, start() still works.
    controller.start();
    assert.doesNotThrow(() => controller.stop());
  });

  test('a throwing onResize listener prevents subsequent listeners from firing (documents current contract)', async () => {
    /** @type {string[]} */
    const order = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
    });
    controller.onResize(() => {
      order.push('first');
      throw new Error('boom');
    });
    controller.onResize(() => order.push('second'));
    controller.onResize(() => order.push('third'));

    // spawnWorker is async — the listener throw becomes a Promise
    // rejection. There is no try/catch in fireResize today, so the
    // rejection propagates out and subsequent listeners do not fire.
    // This is the documented contract — T5 may add isolation if it
    // becomes a real issue (see `completion-checklist.md` notes).
    await assert.rejects(controller.spawnWorker(), /boom/);
    assert.deepEqual(order, ['first']);
  });

  test('enabled: false + spawnWorker() STILL fires the resize event (T4 does not gate on enabled)', async () => {
    /** @type {Array<unknown>} */
    const events = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      enabled: false,
      spawnIdleWorker: async () => 'w-1',
    });
    controller.onResize((e) => events.push(e));
    const ok = await controller.spawnWorker();
    assert.equal(ok, true);
    assert.equal(events.length, 1, 'T4 does not gate spawnWorker on enabled — T6 will fix');
  });

  test('enabled: false + retireLowestLoadWorker() STILL fires worker:retiring + shrink (T4 contract)', async () => {
    /** @type {Array<{ event: string, payload: any }>} */
    const emitted = [];
    /** @type {Array<import('../src/adaptive-controller.js').ResizeEvent>} */
    const events = [];
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      enabled: false,
      spawnIdleWorker: async () => 'w-1',
      retireLowestLoadWorker: async () => 'w-1',
      events: { emit: (event, payload) => emitted.push({ event, payload }) },
    });
    controller.onResize((e) => events.push(e));
    await controller.spawnWorker(); // fires grow resize
    const ok = await controller.retireLowestLoadWorker();
    assert.equal(ok, true);
    assert.equal(emitted.length, 1, 'exactly one worker:retiring event from the retire');
    assert.deepEqual(emitted[0].payload, { workerId: 'w-1', reason: 'drain' });
    assert.equal(events.length, 2, 'one grow + one shrink resize event');
    assert.equal(events[0].reason, 'grow');
    assert.equal(events[1].reason, 'shrink');
  });

  test('spawnWorker() DOES NOT enforce maxWorkers (caller/T5 must gate)', async () => {
    let spawnCalls = 0;
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 2,
      spawnIdleWorker: async () => {
        spawnCalls++;
        return `w-${spawnCalls}`;
      },
    });
    await controller.spawnWorker(); // 1 → 2 (at max)
    await controller.spawnWorker(); // 2 → 3 (OVER max — controller allows it)
    await controller.spawnWorker(); // 3 → 4
    assert.equal(controller.getStats().effectiveWorkers, 4);
    assert.equal(spawnCalls, 3);
  });

  test('retireLowestLoadWorker() DOES NOT enforce minWorkers (caller/T5 must gate)', async () => {
    const controller = createAdaptiveController({
      minWorkers: 2,
      maxWorkers: 4,
      retireLowestLoadWorker: async () => 'w-1',
    });
    // 2 → 1 (at min)
    await controller.retireLowestLoadWorker();
    // 1 → 0 (UNDER min — controller allows it)
    await controller.retireLowestLoadWorker();
    await controller.retireLowestLoadWorker();
    assert.equal(controller.getStats().effectiveWorkers, -1);
  });

  test('concurrent spawnWorker() calls all complete and effectiveWorkers reflects the final state', async () => {
    let spawnCalls = 0;
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => {
        spawnCalls++;
        // Simulate I/O latency so concurrent calls actually race.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return `w-${spawnCalls}`;
      },
    });
    const results = await Promise.all([
      controller.spawnWorker(),
      controller.spawnWorker(),
      controller.spawnWorker(),
    ]);
    assert.deepEqual(results, [true, true, true]);
    assert.equal(spawnCalls, 3);
    assert.equal(controller.getStats().effectiveWorkers, 4);
  });

  test('onResize listener reading stats during fire sees the POST-resize snapshot', async () => {
    /** @type {AdaptiveStats | undefined} */
    let snapshot;
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
    });
    controller.onResize(() => {
      snapshot = controller.getStats();
    });
    controller.tick();
    await controller.spawnWorker();
    // Inside fireResize, ticksSinceResize is reset to 0 BEFORE firing.
    assert.ok(snapshot);
    assert.equal(/** @type {AdaptiveStats} */ (snapshot).effectiveWorkers, 2);
    assert.equal(/** @type {AdaptiveStats} */ (snapshot).ticksSinceResize, 0);
    assert.equal(/** @type {AdaptiveStats} */ (snapshot).lastResizeReason, 'grow');
  });

  test('ticksSinceResume after a grow stays at 0 across multiple subsequent ticks', async () => {
    const controller = createAdaptiveController({
      minWorkers: 1,
      maxWorkers: 4,
      spawnIdleWorker: async () => 'w-1',
    });
    await controller.spawnWorker();
    assert.equal(controller.getStats().ticksSinceResize, 0);
    controller.tick();
    controller.tick();
    controller.tick();
    assert.equal(controller.getStats().ticksSinceResize, 3);
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
    // 150ms / 20ms cadence ≈ 7 expected ticks. We assert `>= 2` (not a
    // tight upper bound) because the real assertion under test is
    // "the timer is firing" — the upper bound is not informative and
    // becomes flaky under CPU contention from sibling tests in the
    // full validate run. The dedicated timing assertion lives in
    // `benchmarks/adaptive-concurrency.benchmark.js` Phase D (T10).
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.stop();
    const ticks = controller.getStats().ticksSinceResize;
    assert.ok(ticks >= 2, `expected at least 2 ticks, got ${ticks}`);
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
