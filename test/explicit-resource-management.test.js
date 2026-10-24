/**
 * ADR-0026 — Explicit Resource Management (`Symbol.asyncDispose`) and the
 * Go-style multi-return helper (`attempt`).
 *
 * The library implements the Explicit Resource Management PROTOCOL; it never
 * uses the `using` / `await using` SYNTAX. `package.json` declares
 * `engines.node >= 22.13.0` and the parser of that version does not
 * understand the syntax — a consumer on Node.js >= 24 is the one who writes
 * `await using`. The static test at the bottom of this file enforces that
 * boundary.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attempt, createWorkerRuntime, WorkerRuntime } from '../src/index.js';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const DTS_FILE = fileURLToPath(new URL('../src/index.d.ts', import.meta.url));

/**
 * Removes comments, string literals and regex literals from a source file, so
 * the keyword scan below cannot be fooled by prose ("…using the configured
 * band…") nor by a quoted snippet.
 *
 * The regex-literal branch is what keeps `src/fn-deps-scanner.js` — whose
 * pattern contains `['"]` — from swallowing the rest of the file.
 */
function stripNonCode(source) {
  // A `/` starts a regex literal only where a regex can legally begin. After
  // an identifier, `)` or `]` it is a division operator instead.
  const REGEX_PRECEDERS = new Set([
    '',
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '+',
    '-',
    '*',
    '%',
    '<',
    '>',
    '~',
    '^',
  ]);

  let out = '';
  let last = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      last = ' ';
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      last = ' ';
      continue;
    }

    if (ch === '/' && REGEX_PRECEDERS.has(last)) {
      i++;
      let inCharClass = false;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '[') inCharClass = true;
        else if (c === ']') inCharClass = false;
        else if (c === '/' && !inCharClass) {
          i++;
          break;
        } else if (c === '\n') break;
        i++;
      }
      out += ' ';
      last = ' ';
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) last = ch;
    i++;
  }

  return out;
}

/** A `using` / `await using` DECLARATION — not the word "using" in prose. */
const USING_DECLARATION_RE = /\b(?:await\s+)?using\s+[A-Za-z_$][\w$]*\s*=/g;

function listJsFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

describe('ADR-0026 — Explicit Resource Management protocol', () => {
  it('exposes runtime[Symbol.asyncDispose] as a function', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });

    assert.equal(typeof runtime[Symbol.asyncDispose], 'function');
    assert.equal(
      runtime[Symbol.asyncDispose],
      WorkerRuntime.prototype[Symbol.asyncDispose],
      'the method must be inherited from the prototype, not an own instance property',
    );

    await runtime.shutdown();
  });

  it('dispose terminates the runtime: the probes report ok:false and the worker threads are gone', async () => {
    const runtime = await createWorkerRuntime({ workers: 2 });

    // Warm the pool so there is something to tear down.
    await runtime.execute({ type: 'warmup', fn: () => 'ok' });
    assert.equal(runtime.getWorkers().length, 2);
    assert.equal(runtime.isAlive().ok, true);

    await runtime[Symbol.asyncDispose]();

    assert.equal(runtime.isAlive().ok, false);
    assert.equal(runtime.isReady().ok, false);
    assert.deepEqual(runtime.getWorkers(), [], 'every worker thread must be terminated');
    assert.equal(runtime.stats.totalWorkers, 0);
  });

  it('dispose after an explicit shutdown does not throw (idempotent)', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });
    await runtime.execute({ type: 'warmup', fn: () => 'ok' });

    await runtime.shutdown();
    await assert.doesNotReject(() => runtime[Symbol.asyncDispose]());

    assert.equal(runtime.isAlive().ok, false);
    assert.deepEqual(runtime.getWorkers(), []);
  });

  it('dispose called twice does not throw (idempotent)', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });

    await assert.doesNotReject(() => runtime[Symbol.asyncDispose]());
    await assert.doesNotReject(() => runtime[Symbol.asyncDispose]());

    assert.equal(runtime.isAlive().ok, false);
    assert.deepEqual(runtime.getWorkers(), []);
  });

  it('uses the real Symbol.asyncDispose key, not a parallel symbol', async () => {
    const runtime = await createWorkerRuntime({ workers: 1 });

    // The protocol looks the method up by the WELL-KNOWN symbol. A parallel
    // symbol would silently never be called by `await using`.
    assert.ok(
      Symbol.asyncDispose in runtime,
      'Symbol.asyncDispose must be an own/inherited key of the runtime instance',
    );
    assert.ok(
      Object.getOwnPropertySymbols(WorkerRuntime.prototype).includes(Symbol.asyncDispose),
      'the prototype must own the Symbol.asyncDispose key',
    );
    assert.equal(
      runtime[Symbol.asyncDispose],
      WorkerRuntime.prototype[Symbol.asyncDispose],
      'the instance must resolve the real Symbol.asyncDispose key',
    );

    await runtime.shutdown();
  });

  it('satisfies the AsyncDisposable protocol end to end', async (t) => {
    if (typeof AsyncDisposableStack !== 'function') {
      t.skip('AsyncDisposableStack is not available on this Node.js version');
      return;
    }

    const runtime = await createWorkerRuntime({ workers: 1 });
    await runtime.execute({ type: 'warmup', fn: () => 'ok' });

    // The exact call the `await using` syntax performs, driven by the engine.
    const stack = new AsyncDisposableStack();
    stack.use(runtime);
    await stack.disposeAsync();

    assert.equal(runtime.isAlive().ok, false);
    assert.deepEqual(runtime.getWorkers(), []);
  });
});

describe('ADR-0026 — attempt() result tuple', () => {
  it('returns [null, value] for a resolving thunk, preserving the value reference', async () => {
    const value = { payload: 42 };

    const [error, result] = await attempt(() => value);

    assert.equal(error, null);
    assert.equal(result, value, 'the value must be the SAME reference, not a copy');
  });

  it('returns [err, undefined] for a synchronously throwing thunk, without propagating', async () => {
    const thrown = new Error('sync boom');

    const [error, result] = await attempt(() => {
      throw thrown;
    });

    assert.equal(error, thrown);
    assert.equal(result, undefined);
  });

  it('returns [err, undefined] for a rejecting promise, without propagating', async () => {
    const thrown = new Error('async boom');

    const [error, result] = await attempt(Promise.reject(thrown));

    assert.equal(error, thrown);
    assert.equal(result, undefined);
  });

  it('preserves the identity of the original error (no wrapping)', async () => {
    const thrown = new Error('original', { cause: 'the-cause' });

    const [error] = await attempt(() => Promise.reject(thrown));

    assert.equal(error, thrown, 'the error object must be the very same instance');
    assert.equal(error.cause, 'the-cause', 'the original cause must survive');
    assert.equal(error.stack, thrown.stack, 'the original stack must survive');
    assert.equal(error.message, 'original');
  });

  it('works with a direct promise (not a thunk)', async () => {
    const [error, result] = await attempt(Promise.resolve('direct'));

    assert.equal(error, null);
    assert.equal(result, 'direct');
  });

  it('returns [null, undefined] for a resolved undefined value', async () => {
    const [error, result] = await attempt(() => undefined);

    assert.equal(error, null, 'a resolved undefined is NOT an error');
    assert.equal(result, undefined);
  });
});

describe('ADR-0026 — static guards', () => {
  it('never uses the using / await using syntax in src/', () => {
    // Prove the scanner is not vacuous before trusting its verdict.
    const positive = stripNonCode('const x = 1;\nawait using handle = make();\n');
    assert.match(
      positive,
      USING_DECLARATION_RE,
      'the scanner MUST detect a real `await using` declaration',
    );

    // …and that prose does not trip it.
    const negative = stripNonCode('// using the configured band\nconst usingNote = 1;\n');
    assert.doesNotMatch(
      negative,
      USING_DECLARATION_RE,
      'the scanner MUST NOT report the word "using" in prose',
    );

    const files = listJsFiles(SRC_DIR);
    assert.ok(files.length > 0, 'the scanner MUST have files to scan');

    const offenders = [];
    for (const file of files) {
      const code = stripNonCode(readFileSync(file, 'utf8'));
      const matches = code.match(USING_DECLARATION_RE);
      if (matches) offenders.push(`${relative(SRC_DIR, file)}: ${matches.join(', ')}`);
    }

    assert.deepEqual(
      offenders,
      [],
      'src/ must implement the protocol, never the syntax — engines.node is >= 22.13.0',
    );
  });

  it('declares the asyncDispose member against the real symbol and pulls in the disposable lib', () => {
    const dts = readFileSync(DTS_FILE, 'utf8');

    // `Symbol.asyncDispose` only exists in TypeScript's `esnext.disposable`
    // lib, which is NOT part of the default lib set of `target: ES2022`.
    // Without this directive a consumer that does not opt in explicitly gets
    // TS2550 ("Property 'asyncDispose' does not exist on type
    // 'SymbolConstructor'") and the package breaks their build.
    assert.match(
      dts,
      /^\/\/\/ <reference lib="esnext\.disposable" \/>$/m,
      'src/index.d.ts MUST pull the esnext.disposable lib into the consumer program',
    );

    // The member MUST be keyed by the real well-known symbol, otherwise the
    // consumer's `await using` never calls it.
    assert.match(
      dts,
      /\[Symbol\.asyncDispose\]\(\): Promise<void>;/,
      'src/index.d.ts MUST declare [Symbol.asyncDispose](): Promise<void>',
    );

    // The portable fallback (a locally declared `unique symbol`) would
    // compile without the lib but break the consumer's `await using` with
    // TS2851 — it must never be used in place of the real symbol.
    assert.doesNotMatch(
      dts,
      /declare const asyncDisposeSymbol/,
      'a parallel symbol must not replace the real Symbol.asyncDispose',
    );
  });
});
