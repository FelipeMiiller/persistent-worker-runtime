/**
 * test/skill-gate-node-requirement.test.js — the `// requires:` convention of
 * the skill gate (`scripts/validate-skill.js`).
 *
 * Why this file exists: the package declares `engines.node: ">=22.13.0"`, and
 * the skill ships a snippet that uses the `await using` syntax. That syntax
 * does not PARSE on Node 22.13.0, so the gate used to read it as a broken
 * snippet — a fatal syntax error — and failed on a version the package itself
 * claims to support. A snippet that needs a newer Node than the one running
 * the gate is an environment limitation, not a defect.
 *
 * The gate now honours the `// requires:` marker — the convention the sibling
 * gate (`scripts/run-examples.js`) already uses for the examples — and skips
 * such a block with a visible reason instead of failing.
 *
 * This is the first unit test of a gate script in this repository: `scripts/`
 * was only ever exercised by running it. The module has a main guard, so
 * importing it here does not trigger the gate.
 *
 * Zero dependencies on purpose (ADR-0005): `node:test` and `node:assert`
 * only.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  extractCodeBlocks,
  isNodeVersionBelow,
  parseNodeRequirement,
  parseRequiresMarker,
} from '../scripts/validate-skill.js';

const API_REFERENCE_URL = new URL(
  '../skills/persistent-worker-runtime/references/api-reference.md',
  import.meta.url,
);

// ─── 1. The marker itself ───────────────────────────────────────────────────

describe('parseRequiresMarker', () => {
  it('returns the requirement text of a marked block', () => {
    assert.equal(parseRequiresMarker('// requires: node >= 24\nconst a = 1;'), 'node >= 24');
  });

  it('returns null for a block with no marker', () => {
    assert.equal(parseRequiresMarker('const a = 1;\nawait a;'), null);
  });

  it('finds the marker on any line of the block, not only the first', () => {
    const source = ['const a = 1;', '// requires: node >= 24', 'await a;'].join('\n');
    assert.equal(parseRequiresMarker(source), 'node >= 24');
  });

  it('requires the marker to be a whole-line comment', () => {
    // A trailing comment is not the marker: the marker has to be readable
    // without parsing the block.
    assert.equal(parseRequiresMarker('const a = 1; // requires: node >= 24'), null);
  });

  it('ignores an indented marker', () => {
    // Indentation is allowed — the marker is a comment wherever it sits.
    assert.equal(parseRequiresMarker('    // requires: node >= 24'), 'node >= 24');
  });
});

// ─── 2. The Node version requirement ────────────────────────────────────────

describe('parseNodeRequirement', () => {
  it('recognizes "node >= X"', () => {
    assert.deepEqual(parseNodeRequirement('// requires: node >= 24'), { minVersion: '24' });
  });

  it('recognizes "node >= X.Y"', () => {
    assert.deepEqual(parseNodeRequirement('// requires: node >= 22.13'), { minVersion: '22.13' });
  });

  it('recognizes "node >= X.Y.Z"', () => {
    assert.deepEqual(parseNodeRequirement('// requires: node >= 22.13.0'), {
      minVersion: '22.13.0',
    });
  });

  it('tolerates whitespace around the operator', () => {
    assert.deepEqual(parseNodeRequirement('// requires: node>=24'), { minVersion: '24' });
  });

  it('does NOT recognize "node < 24"', () => {
    assert.equal(parseNodeRequirement('// requires: node < 24'), null);
  });

  it('does NOT recognize "node 24" (no comparison operator)', () => {
    assert.equal(parseNodeRequirement('// requires: node 24'), null);
  });

  it('does NOT recognize "node >= 24.1.2.3" (not a version)', () => {
    assert.equal(parseNodeRequirement('// requires: node >= 24.1.2.3'), null);
  });

  it('does NOT recognize a non-Node requirement', () => {
    assert.equal(parseNodeRequirement('// requires: a running Postgres'), null);
  });

  it('returns null when the block declares no requirement at all', () => {
    assert.equal(parseNodeRequirement('const a = 1;'), null);
  });
});

// ─── 3. The version comparison ───────────────────────────────────────────────

describe('isNodeVersionBelow', () => {
  it('reports a running Node older than the requirement', () => {
    assert.equal(isNodeVersionBelow('24', '22.13.0'), true);
  });

  it('reports the exact minimum as NOT below', () => {
    assert.equal(isNodeVersionBelow('22.13.0', '22.13.0'), false);
  });

  it('reports a running Node newer than the requirement as NOT below', () => {
    assert.equal(isNodeVersionBelow('24', '24.16.0'), false);
  });

  it('treats "24" and "24.0.0" as the same version', () => {
    assert.equal(isNodeVersionBelow('24', '24.0.0'), false);
  });

  it('compares NUMERICALLY, not lexicographically', () => {
    // The case a string comparison gets wrong: "9.0.0" sorts AFTER "24" as a
    // string, and it is older. A lexicographic gate would run a block on
    // Node 9 that requires Node 24.
    assert.equal(isNodeVersionBelow('24', '9.0.0'), true);
    assert.equal(isNodeVersionBelow('9.0.0', '24'), false);
  });

  it('compares the minor and patch parts too', () => {
    assert.equal(isNodeVersionBelow('22.13.0', '22.12.9'), true);
    assert.equal(isNodeVersionBelow('22.13.0', '22.13.1'), false);
  });

  it('refuses to run what it cannot verify', () => {
    // An unparsable version means the gate cannot prove the requirement is
    // met — the conservative answer is "below", so the block is skipped.
    assert.equal(isNodeVersionBelow('24', 'not-a-version'), true);
    assert.equal(isNodeVersionBelow('not-a-version', '24.16.0'), true);
  });
});

// ─── 4. Non-vacuity: the word "requires" alone is not a requirement ────────

describe('the marker is not detected by accident', () => {
  it('ignores an identifier named "requires"', () => {
    const source = 'const requires = 1;\nawait requires;';
    assert.equal(parseRequiresMarker(source), null);
    assert.equal(parseNodeRequirement(source), null);
  });

  it('ignores a comment that merely mentions "requires"', () => {
    const source = '// this requires node 24 to run\nconst a = 1;';
    assert.equal(parseRequiresMarker(source), null);
    assert.equal(parseNodeRequirement(source), null);
  });

  it('ignores "requires" inside a string literal', () => {
    const source = 'const a = "// requires: node >= 24";';
    assert.equal(parseRequiresMarker(source), null);
    assert.equal(parseNodeRequirement(source), null);
  });

  it('still detects the marker when it IS the whole line', () => {
    const source = '// requires: node >= 24\nconst a = 1;';
    assert.equal(parseRequiresMarker(source), 'node >= 24');
    assert.deepEqual(parseNodeRequirement(source), { minVersion: '24' });
  });
});

// ─── 5. The shipped skill carries the marker ─────────────────────────────────
//
// This is the guard on the fix itself: if the marker is dropped from the
// skill, the gate goes back to failing on Node 22.13.0, and nothing else in
// the suite would notice.

describe('the shipped skill', () => {
  const blocks = extractCodeBlocks(readFileSync(API_REFERENCE_URL, 'utf8'));

  it('declares the requirement in exactly one block', () => {
    const marked = blocks.filter((block) => parseRequiresMarker(block.code) !== null);
    assert.equal(
      marked.length,
      1,
      `expected exactly one marked block in references/api-reference.md, found ${marked.length}`,
    );
  });

  it('marks the "await using" block with "node >= 24"', () => {
    const marked = blocks.filter((block) => parseRequiresMarker(block.code) !== null);
    assert.equal(marked.length, 1);
    assert.match(marked[0].code, /await using/);
    assert.deepEqual(parseNodeRequirement(marked[0].code), { minVersion: '24' });
  });
});
