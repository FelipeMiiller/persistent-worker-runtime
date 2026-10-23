/**
 * test/types-surface.test.js — zero-dependency gate between the runtime's
 * public exports and the declarations in `src/index.d.ts`.
 *
 * Why this file exists (issue 005): `src/index.d.ts` ships to npm inside the
 * tarball and the README advertises the package as "TypeScript-Ready", but
 * nothing asserted that the declarations and the runtime agree. Four of the
 * sixteen public exports were missing from the declarations — invisible to the
 * JavaScript test suite, invisible to coverage, invisible to CI, and fatal at
 * the consumer's first `tsc` run (TS2305).
 *
 * The gate compares the two sets in BOTH directions:
 *   - every name the runtime exports must be declared (a missing declaration
 *     breaks the consumer's import);
 *   - every value-level name declared must be exported (an extra declaration
 *     breaks the consumer's import in the other direction).
 *
 * Type-only declarations (`export interface`, `export type`) are erased at
 * compile time and have no runtime counterpart, so they are excluded from the
 * comparison. Everything else in this file exists to keep that comparison
 * STABLE — the gate must not fail because of whitespace, comments, re-export
 * lists or aliases.
 *
 * Zero dependencies on purpose: ADR-0005 forbids external runtime dependencies,
 * and adding `typescript` as a devDependency is a policy decision that would
 * need its own ADR. This file uses nothing but `node:*` built-ins.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as runtime from '../src/index.js';

const DTS_SOURCE = readFileSync(new URL('../src/index.d.ts', import.meta.url), 'utf8');

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Removes comments and string literals from a declaration file.
 *
 * Why not a regex: a block comment can contain a line that starts at column 0
 * with `export class Foo {}`, which a line-anchored regex would happily read
 * as a real declaration. Stripping comments with a regex is not safe either,
 * because `//` and `/*` also occur inside string literals. This scanner keeps
 * the states (code / comment / string) explicit, which is the only way to get
 * both right.
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    // Line comment — drop everything up to (but not including) the newline.
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Block comment — drop up to and including the closing `*/`. A newline is
    // emitted so the line structure (and therefore the line-anchored regexes)
    // stays intact.
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out += '\n';
      continue;
    }

    // String literal — drop its content. Newlines are kept so the line
    // structure survives; nothing else is, because the content of a string is
    // never part of an export name.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      let literal = '';
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          literal += c + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        literal += c;
        i++;
      }
      out += literal.replace(/[^\n]/g, '');
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

// Value-level declarations — these names exist at runtime:
//   export [declare] [abstract] [async] (class|function|const|let|var|enum|namespace) NAME
// Anchored at the start of a line (leading whitespace allowed) so a mention of
// the word "export" inside a type annotation cannot be mistaken for a
// declaration. The separators are `\s` so the pattern survives a line break
// between `export` and the declaration keyword.
const VALUE_DECL_RE =
  /^[ \t]*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;

// Type-only declarations — erased at compile time, no runtime counterpart:
//   export [declare] (interface|type) NAME
// `export type { A }` is NOT matched here (a `{` follows `type`, not a name);
// it is excluded by the fact that it also does not match EXPORT_LIST_RE.
const TYPE_DECL_RE = /^[ \t]*export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm;

// Re-export lists — `export { A, B as C }` (optionally `from '...'`).
// A list declares no name of its own, it re-exports names declared elsewhere,
// so the EXPORTED name is the part after `as` (or the bare name). `export type
// { ... }` is excluded because this pattern requires `{` to follow `export` +
// whitespace directly.
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\}/gm;

/**
 * Extracts the names declared by a `.d.ts` source.
 *
 * @param {string} source
 * @returns {{ valueLevel: Set<string>, typeOnly: Set<string> }}
 */
function parseDeclaredNames(source) {
  const code = stripCommentsAndStrings(source);
  const valueLevel = new Set();
  const typeOnly = new Set();

  for (const match of code.matchAll(VALUE_DECL_RE)) {
    valueLevel.add(match[1]);
  }

  for (const match of code.matchAll(TYPE_DECL_RE)) {
    typeOnly.add(match[1]);
  }

  for (const match of code.matchAll(EXPORT_LIST_RE)) {
    for (const rawSpecifier of match[1].split(',')) {
      const specifier = rawSpecifier.trim();
      if (specifier === '') continue;

      // `export { type Foo }` — the inline `type` modifier marks a type-only
      // re-export, which has no runtime counterpart.
      if (/^type[ \t]/.test(specifier)) continue;

      // `A as B` — `A` is the local name, `B` is the exported name. The
      // exported name is the one that has to match a runtime export.
      const parts = specifier.split(/\s+as\s+/);
      const exported = parts[parts.length - 1].trim();
      if (exported === '') continue;

      // A re-export of a type-only declaration is still type-only.
      if (typeOnly.has(exported)) continue;

      valueLevel.add(exported);
    }
  }

  return { valueLevel, typeOnly };
}

// ─── The comparison ──────────────────────────────────────────────────────────

const declared = parseDeclaredNames(DTS_SOURCE);
const runtimeNames = new Set(Object.keys(runtime));

describe('Public type surface (src/index.d.ts)', () => {
  it('declares every name the runtime exports', () => {
    const missing = [...runtimeNames].filter((name) => !declared.valueLevel.has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      `src/index.d.ts is missing a declaration for: ${missing.join(', ')}. ` +
        'A TypeScript consumer cannot import those names (TS2305).',
    );
  });

  it('declares no value-level name that the runtime does not export', () => {
    const extra = [...declared.valueLevel].filter((name) => !runtimeNames.has(name)).sort();
    assert.deepEqual(
      extra,
      [],
      `src/index.d.ts declares names the runtime does not export: ${extra.join(', ')}. ` +
        'A TypeScript consumer importing them gets TS2305.',
    );
  });

  it('declares the four names that were missing from the definitions (issue 005)', () => {
    for (const name of [
      'SqliteTaskQueue',
      'TaskQueue',
      'StreamAbortedError',
      'StreamConfigError',
    ]) {
      assert.ok(runtimeNames.has(name), `src/index.js must export ${name}`);
      assert.ok(declared.valueLevel.has(name), `src/index.d.ts must declare ${name}`);
    }
  });

  it('declares StreamConfigError as a TypeError, not a WorkerRuntimeError', () => {
    // The runtime raises StreamConfigError for invalid-argument checks, so a
    // consumer branching on `err instanceof TypeError` must typecheck.
    const code = stripCommentsAndStrings(DTS_SOURCE);
    assert.match(code, /export\s+class\s+StreamConfigError\s+extends\s+TypeError\b/);
  });
});

// ─── Parser self-tests ──────────────────────────────────────────────────────
//
// The gate is only useful if it is STABLE: it must not trip on formatting.
// These cases pin the behaviour the comparison above relies on.

describe('Export-name parser', () => {
  it('ignores type-only declarations (interface and type alias)', () => {
    const { valueLevel, typeOnly } = parseDeclaredNames(
      [
        'export interface Foo { a: string }',
        'export type Bar = string;',
        'export class Baz {}',
      ].join('\n'),
    );
    assert.deepEqual([...valueLevel].sort(), ['Baz']);
    assert.deepEqual([...typeOnly].sort(), ['Bar', 'Foo']);
  });

  it('resolves re-export lists, aliases and inline type modifiers', () => {
    const { valueLevel } = parseDeclaredNames(
      [
        'export class A {}',
        'export { A, B as Bb } from "./other.js";',
        'export interface C { x: string }',
        'export { type C };',
      ].join('\n'),
    );
    assert.deepEqual([...valueLevel].sort(), ['A', 'Bb']);
  });

  it('ignores a type-only re-export list', () => {
    const { valueLevel } = parseDeclaredNames(
      ['export interface A {}', 'export type { A };'].join('\n'),
    );
    assert.deepEqual([...valueLevel].sort(), []);
  });

  it('ignores declarations that only appear inside comments', () => {
    const { valueLevel } = parseDeclaredNames(
      ['/*', 'export class Ghost {}', '*/', 'export class Real {}'].join('\n'),
    );
    assert.deepEqual([...valueLevel].sort(), ['Real']);
  });

  it('is insensitive to whitespace and line breaks', () => {
    const compact = parseDeclaredNames('export   class    Foo   {}');
    const spread = parseDeclaredNames('export\n\tclass\n\tFoo\n{}');
    assert.deepEqual([...compact.valueLevel], ['Foo']);
    assert.deepEqual([...spread.valueLevel], ['Foo']);
  });

  it('detects a name that is missing from the declarations', () => {
    // The synthetic proof of the failure mode: the runtime side has two
    // names, the declaration side only one. The diff has to report the
    // missing one — this is what turns "the gate is green" into "the gate
    // would catch a regression".
    const synthetic = parseDeclaredNames('export class Kept {}');
    const runtimeSide = new Set(['Kept', 'Dropped']);
    const missing = [...runtimeSide].filter((name) => !synthetic.valueLevel.has(name)).sort();
    assert.deepEqual(missing, ['Dropped']);
  });
});
