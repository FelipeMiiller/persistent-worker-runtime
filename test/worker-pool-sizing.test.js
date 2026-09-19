/**
 * Tests for the worker pool sizing policy (ADR-0023).
 *
 * Covers:
 *   - `resolveWorkerCount` resolution order (workers > env > auto > 1)
 *   - `WORKER_CONCURRENCY=auto` → `availableParallelism()`
 *   - `WORKER_CONCURRENCY=N` → N
 *   - Invalid env (`ten`, `0`) → warn + fall through to next tier
 *   - `concurrency: 'auto'` → `availableParallelism()` (when env is unset)
 *   - Default = 1 when nothing is configured
 *   - Explicit `options.workers` validation (positive integer only)
 *   - `resolveAdaptiveEnabled` opt-out (workers:N and concurrency:'fixed')
 *   - `isDefaultSizing` for warning gating
 *
 * Env state is captured at the suite level and restored after every
 * test so a `WORKER_CONCURRENCY` set in the developer shell cannot leak
 * into other suites (a regression observed during T6 development when
 * the `WORKER_CONCURRENCY=8` env was inherited and broke the
 * `default-sizing` test that expects `workers === 1`).
 */
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  isDefaultSizing,
  resolveAdaptiveEnabled,
  resolveWorkerCount,
  SIZING_DEFAULT_WORKERS,
  SIZING_ENV_VAR,
  SIZING_INVALID_ENV_WARNING,
} from '../src/worker-pool-sizing.js';

/**
 * Captures `process.env[envVar]` for the duration of `fn` and restores
 * the original value (including the original `undefined` state) when
 * `fn` returns. Centralized so each test stays a single readable line.
 *
 * @param {string} envVar
 * @param {string | undefined} value
 * @param {() => void} fn
 */
function withEnv(envVar, value, fn) {
  const original = Object.hasOwn(process.env, envVar) ? process.env[envVar] : undefined;
  if (value === undefined) {
    delete process.env[envVar];
  } else {
    process.env[envVar] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = original;
    }
  }
}

/**
 * Monkey-patches `process.emitWarning` for the duration of `fn`. The
 * patch records every warning message + code so the test can assert on
 * code names (insulated from message copy edits) without depending on
 * the Node test runner's internal warning handler. Same pattern as
 * `test/default-sizing.test.js` so the suites share the same idiom.
 *
 * @param {(warnings: Array<{ message: string, code: string | undefined }>) => void} fn
 */
function captureWarnings(fn) {
  const warnings = [];
  const original = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(warning, ...args) {
    const opts = args[0];
    const code = typeof opts === 'string' ? opts : opts?.code;
    warnings.push({ message: String(warning), code });
    // Intentionally do NOT forward — keeps test output clean and
    // prevents the Node test runner from converting the warning into a
    // test-report diagnostic.
  };
  try {
    fn(warnings);
  } finally {
    process.emitWarning = original;
  }
}

describe('resolveWorkerCount — explicit `options.workers`', () => {
  it('returns the explicit value when given a positive integer', () => {
    assert.equal(resolveWorkerCount({ workers: 4 }), 4);
    assert.equal(resolveWorkerCount({ workers: 1 }), 1);
    assert.equal(resolveWorkerCount({ workers: 16 }), 16);
  });

  it('throws RangeError for zero workers', () => {
    assert.throws(() => resolveWorkerCount({ workers: 0 }), RangeError);
  });

  it('throws RangeError for negative workers', () => {
    assert.throws(() => resolveWorkerCount({ workers: -1 }), RangeError);
  });

  it('throws RangeError for non-integer workers (1.5)', () => {
    assert.throws(() => resolveWorkerCount({ workers: 1.5 }), RangeError);
  });

  it('throws RangeError for NaN workers', () => {
    assert.throws(() => resolveWorkerCount({ workers: Number.NaN }), RangeError);
  });

  it('throws RangeError for Infinity workers', () => {
    assert.throws(() => resolveWorkerCount({ workers: Number.POSITIVE_INFINITY }), RangeError);
  });

  it('explicit `workers` wins over `WORKER_CONCURRENCY` env', () => {
    withEnv(SIZING_ENV_VAR, '2', () => {
      assert.equal(resolveWorkerCount({ workers: 7 }), 7);
    });
  });

  it("explicit `workers` wins over `concurrency: 'auto'`", () => {
    withEnv(SIZING_ENV_VAR, undefined, () => {
      assert.equal(resolveWorkerCount({ workers: 3, concurrency: 'auto' }), 3);
    });
  });
});

describe('resolveWorkerCount — `WORKER_CONCURRENCY` env var', () => {
  it('returns the host core count when env is `auto`', () => {
    withEnv(SIZING_ENV_VAR, 'auto', () => {
      assert.equal(resolveWorkerCount({}), availableParallelism());
    });
  });

  it('returns the parsed integer when env is a positive integer', () => {
    withEnv(SIZING_ENV_VAR, '8', () => {
      assert.equal(resolveWorkerCount({}), 8);
    });
  });

  it('parses large integer env values verbatim', () => {
    withEnv(SIZING_ENV_VAR, '128', () => {
      assert.equal(resolveWorkerCount({}), 128);
    });
  });

  it('emits a warning and falls back when env is non-numeric (`ten`)', () => {
    withEnv(SIZING_ENV_VAR, 'ten', () => {
      captureWarnings((warnings) => {
        assert.equal(resolveWorkerCount({}), SIZING_DEFAULT_WORKERS);
        const sizingWarnings = warnings.filter((w) => w.code === SIZING_INVALID_ENV_WARNING);
        assert.equal(sizingWarnings.length, 1, 'expected exactly one invalid-env warning');
        assert.match(sizingWarnings[0].message, /ten/);
        assert.match(sizingWarnings[0].message, /WORKER_CONCURRENCY/);
      });
    });
  });

  it('emits a warning and falls back when env is `0`', () => {
    withEnv(SIZING_ENV_VAR, '0', () => {
      captureWarnings((warnings) => {
        assert.equal(resolveWorkerCount({}), SIZING_DEFAULT_WORKERS);
        const sizingWarnings = warnings.filter((w) => w.code === SIZING_INVALID_ENV_WARNING);
        assert.equal(sizingWarnings.length, 1);
        assert.match(sizingWarnings[0].message, /"0"/);
      });
    });
  });

  it('emits a warning and falls back when env is empty string', () => {
    withEnv(SIZING_ENV_VAR, '', () => {
      captureWarnings((warnings) => {
        // Empty string is not 'auto' and parses to NaN → warn + fall through.
        assert.equal(resolveWorkerCount({}), SIZING_DEFAULT_WORKERS);
        assert.equal(warnings.filter((w) => w.code === SIZING_INVALID_ENV_WARNING).length, 1);
      });
    });
  });

  it("env wins over `concurrency: 'auto'` (env path runs first)", () => {
    withEnv(SIZING_ENV_VAR, '5', () => {
      assert.equal(resolveWorkerCount({ concurrency: 'auto' }), 5);
    });
  });

  it('reads env at call time, not at module load (mutating env between calls works)', () => {
    withEnv(SIZING_ENV_VAR, '3', () => {
      assert.equal(resolveWorkerCount({}), 3);
    });
    withEnv(SIZING_ENV_VAR, '11', () => {
      assert.equal(resolveWorkerCount({}), 11);
    });
  });
});

describe("resolveWorkerCount — `concurrency: 'auto'` programmatic option", () => {
  it('returns `availableParallelism()` when env is unset', () => {
    withEnv(SIZING_ENV_VAR, undefined, () => {
      assert.equal(resolveWorkerCount({ concurrency: 'auto' }), availableParallelism());
    });
  });

  it("is ignored when `concurrency` is a value other than 'auto' or 'fixed'", () => {
    // `concurrency: 'dynamic'` is a hypothetical future mode — currently
    // not defined, so it should fall through to the default. Pins the
    // contract: only the literal string 'auto' triggers auto-detection.
    withEnv(SIZING_ENV_VAR, undefined, () => {
      assert.equal(resolveWorkerCount({ concurrency: 'dynamic' }), SIZING_DEFAULT_WORKERS);
    });
  });
});

describe('resolveWorkerCount — conservative default', () => {
  it('returns 1 when no sizing hint is provided and env is unset', () => {
    withEnv(SIZING_ENV_VAR, undefined, () => {
      assert.equal(resolveWorkerCount({}), SIZING_DEFAULT_WORKERS);
      assert.equal(resolveWorkerCount(), SIZING_DEFAULT_WORKERS); // no args
    });
  });

  it('returns 1 when env is invalid and no other option is set', () => {
    withEnv(SIZING_ENV_VAR, 'garbage', () => {
      captureWarnings(() => {
        assert.equal(resolveWorkerCount({}), SIZING_DEFAULT_WORKERS);
      });
    });
  });
});

describe('resolveAdaptiveEnabled — opt-out detection', () => {
  beforeEach(() => withEnv(SIZING_ENV_VAR, undefined, () => {}));
  afterEach(() => withEnv(SIZING_ENV_VAR, undefined, () => {}));

  it('returns false when `workers` is an explicit number', () => {
    assert.equal(resolveAdaptiveEnabled({ workers: 4 }), false);
    assert.equal(resolveAdaptiveEnabled({ workers: 1 }), false);
  });

  it("returns false when `concurrency: 'fixed'` is set", () => {
    assert.equal(resolveAdaptiveEnabled({ concurrency: 'fixed' }), false);
  });

  it('returns true when neither opt-out is set', () => {
    assert.equal(resolveAdaptiveEnabled({}), true);
  });

  it("returns true when `concurrency: 'auto'` is set (auto is opt-IN to adaptive)", () => {
    assert.equal(resolveAdaptiveEnabled({ concurrency: 'auto' }), true);
  });

  it("explicit numeric `workers` wins over `concurrency: 'auto'` (workers disables adaptive)", () => {
    assert.equal(resolveAdaptiveEnabled({ workers: 3, concurrency: 'auto' }), false);
  });
});

describe('isDefaultSizing — warning gating', () => {
  beforeEach(() => withEnv(SIZING_ENV_VAR, undefined, () => {}));
  afterEach(() => withEnv(SIZING_ENV_VAR, undefined, () => {}));

  it('returns true when nothing is configured (warning may fire)', () => {
    assert.equal(isDefaultSizing({}), true);
    assert.equal(isDefaultSizing(), true); // no args
  });

  it('returns false when `workers` is explicit (no warning even on small pool)', () => {
    assert.equal(isDefaultSizing({ workers: 1 }), false);
  });

  it('returns false when env is set, even to an invalid value (env is explicit)', () => {
    withEnv(SIZING_ENV_VAR, 'garbage', () => {
      assert.equal(isDefaultSizing({}), false);
    });
  });

  it("returns false when `concurrency: 'auto'` is set (explicit opt-in)", () => {
    assert.equal(isDefaultSizing({ concurrency: 'auto' }), false);
  });
});
