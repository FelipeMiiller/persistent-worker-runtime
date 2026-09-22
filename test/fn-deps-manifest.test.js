import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanFnDeps } from '../src/fn-deps-scanner.js';
import { createWorkerRuntime } from '../src/index.js';

// HARDEN-02 (ADR-0024 A2): the runtime scans serialized fn source for
// `node:*` references and ships the resolved modules to the worker as a
// `fnDeps` manifest. The worker reconstitutes the fn with each module
// captured as a bare-name closure variable, so user fns can call
// `net.createConnection(...)` directly without `await import(...)` boilerplate.
// Non-built-in deps (e.g. `lodash`) keep working via the existing
// `await import(...)` fallback path.

describe('scanFnDeps (HARDEN-02 helper)', () => {
  it('returns empty array for non-string input', () => {
    assert.deepEqual(scanFnDeps(undefined), []);
    assert.deepEqual(scanFnDeps(null), []);
    assert.deepEqual(scanFnDeps(42), []);
  });

  it('returns empty array when no node:* references exist', () => {
    assert.deepEqual(scanFnDeps('async (payload) => { return payload.x + payload.y; }'), []);
  });

  it('detects single-quoted static import "node:net"', () => {
    assert.deepEqual(scanFnDeps("import 'node:net';\nasync (p) => net.createConnection(p);"), [
      'node:net',
    ]);
  });

  it('detects double-quoted static import "node:net"', () => {
    assert.deepEqual(scanFnDeps('import "node:net"; async (p) => net.createConnection(p);'), [
      'node:net',
    ]);
  });

  it('detects require("node:net")', () => {
    assert.deepEqual(
      scanFnDeps('const net = require("node:net"); async (p) => net.createConnection(p);'),
      ['node:net'],
    );
  });

  it("detects dynamic import('node:net') (the canonical opt-in signal)", () => {
    assert.deepEqual(
      scanFnDeps(
        "async (payload) => { await import('node:net'); return net.createConnection(payload); }",
      ),
      ['node:net'],
    );
  });

  it('detects multiple distinct node:* modules and sorts alphabetically', () => {
    const src = `
      import 'node:net';
      import 'node:crypto';
      require('node:fs');
      await import('node:path');
    `;
    assert.deepEqual(scanFnDeps(src), ['node:crypto', 'node:fs', 'node:net', 'node:path']);
  });

  it('does NOT detect non-built-in modules (lodash, etc.) — they remain in user code', () => {
    const src = `
      async (payload) => {
        const _ = await import('lodash');
        const x = await import('node:net');
        return _.get(payload, 'a');
      }
    `;
    assert.deepEqual(scanFnDeps(src), ['node:net']);
  });

  it('does NOT detect bare references without explicit import (heuristic-safe)', () => {
    // The scan is conservative: bare `net.createConnection(...)` without any
    // explicit import/require is NOT detected. Users who want bare-name
    // ergonomics must add `await import('node:net')` as a signal. This
    // prevents false positives where a local `const net = {...}` would be
    // shadowed by an injected module binding.
    const src = 'async (p) => net.createConnection(p);';
    assert.deepEqual(scanFnDeps(src), []);
  });
});

describe('HARDEN-02 fnDeps manifest end-to-end', () => {
  it('dispatches a task that uses net.createConnection() directly without dynamic import boilerplate', async () => {
    // User writes:
    //   async (payload) => {
    //     await import('node:net');   // signal: scan picks this up
    //     // ...no other import needed
    //     return typeof net.createConnection === 'function' ? 'net_ok' : 'no_net';
    //   }
    //
    // Without HARDEN-02, `net` would be undefined inside the worker thread
    // (the `new Function(fnCode)` body has empty scope) and the fn would
    // throw `ReferenceError: net is not defined`. After HARDEN-02, the
    // runtime ships `node:net` via `fnDeps`, the worker imports it, and
    // captures it as the bare-name `net` BEFORE the user code runs.
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      const result = await runtime.execute({
        fn: async () => {
          await import('node:net');
          return typeof net.createConnection === 'function' ? 'net_ok' : 'no_net';
        },
      });
      assert.equal(result, 'net_ok');

      // Pool is still healthy after the task — no worker crash.
      assert.equal(runtime.stats.totalWorkers, 1);
    } finally {
      await runtime.shutdown();
    }
  });

  it('dispatches a task that uses crypto.createHash() directly without dynamic import', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      const result = await runtime.execute({
        fn: async () => {
          await import('node:crypto');
          const h = crypto.createHash('sha256');
          h.update('hello');
          return h.digest('hex');
        },
      });
      // sha256("hello") — well-known constant for the assertion.
      assert.equal(result, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    } finally {
      await runtime.shutdown();
    }
  });

  it('detects multiple node:* references and ships all of them as bare-name bindings', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      const result = await runtime.execute({
        fn: async () => {
          await import('node:net');
          await import('node:crypto');
          return {
            hasCreateConnection: typeof net.createConnection === 'function',
            hasCreateHash: typeof crypto.createHash === 'function',
          };
        },
      });
      assert.equal(result.hasCreateConnection, true);
      assert.equal(result.hasCreateHash, true);
    } finally {
      await runtime.shutdown();
    }
  });

  it('falls back to dynamic import for non-built-in modules without crashing', async () => {
    // The fn has no `node:*` imports so `fnDeps` is empty — the worker
    // captures no bare-name bindings. The user code's own `await import(...)`
    // for the non-built-in module still runs (and throws ERR_MODULE_NOT_FOUND
    // because the module is not installed in this test environment). The
    // fallback path must surface the error as a rejected task promise —
    // NOT a worker crash.
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      await assert.rejects(
        runtime.execute({
          fn: async () => {
            const mod = await import('definitely-not-installed-pkg-xyz');
            return mod;
          },
        }),
        (err) => err.code === 'ERR_MODULE_NOT_FOUND',
      );
      // Pool still healthy — no worker crash from the rejected task.
      assert.equal(runtime.stats.totalWorkers, 1);
    } finally {
      await runtime.shutdown();
    }
  });

  it('emits an empty fnDeps manifest when the fn references no node:* modules', async () => {
    // Pure-arithmetic fn — no built-in imports. The manifest is empty;
    // the worker builds an empty `__modules` map and the fn runs normally.
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      const result = await runtime.execute({
        fn: async (payload) => payload.x * 2 + payload.y,
        payload: { x: 21, y: 1 },
      });
      assert.equal(result, 43);
    } finally {
      await runtime.shutdown();
    }
  });

  it('accepts an explicit fnDeps override on the task options', async () => {
    // The caller can bypass the scan by passing `fnDeps` directly on the
    // task. Use case: opt-in to bare-name injection without changing the
    // fn source. Here we DON'T have an `await import('node:net')` in the
    // fn but we DO pass `fnDeps: ['node:net']`, so `net` ends up in scope.
    const runtime = await createWorkerRuntime({ workers: 1 });
    try {
      const result = await runtime.execute({
        fnDeps: ['node:net'],
        fn: async () => {
          return typeof net.createConnection === 'function' ? 'net_ok' : 'no_net';
        },
      });
      assert.equal(result, 'net_ok');
    } finally {
      await runtime.shutdown();
    }
  });
});
