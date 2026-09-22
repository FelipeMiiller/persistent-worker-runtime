/**
 * HARDEN-02 (ADR-0024 A2): scan a serialized task fn source string for
 * `node:*` module references so the runtime can pre-resolve them and ship
 * them to the worker as a `fnDeps` manifest. The worker reconstitutes the
 * fn with the modules in scope (captured as bare-name variables), so user
 * fns can call `net.createConnection(...)` directly without dynamic import
 * boilerplate.
 *
 * Three regex families match:
 *   1. Static-style: `import 'node:xxx'` or `import "node:xxx"` (top-of-file)
 *   2. CJS-style:    `require('node:xxx')` or `require("node:xxx")`
 *   3. Dynamic:      `await import('node:xxx')` or `import("node:xxx")`
 *
 * Returns an alphabetically sorted array of unique specifiers like
 * `['node:crypto', 'node:net']`. Empty array if no matches or if the input
 * isn't a string.
 *
 * Limitation: this scan ONLY catches explicit `import`/`require` references.
 * Bare references like `net.createConnection(...)` (no prior import) are not
 * detected — users who want bare-ref ergonomics must add an explicit
 * `await import('node:net')` as a signal. This is the conservative choice:
 * scanning for bare names would risk false positives (local variable named
 * `net` shadowed by injected module binding).
 *
 * Backward compatibility: fns that already use `await import('lodash')` for
 * user-installed deps continue to work — they just don't show up in the
 * `node:*` manifest and rely on dynamic import inside the fn body.
 */

const NODE_SPECIFIER_RE =
  /\b(?:import\s+['"]|import\s*\(\s*['"]|require\s*\(\s*['"])node:([a-z][a-z0-9_/-]*)/gi;

export function scanFnDeps(fnCode) {
  if (typeof fnCode !== 'string') return [];
  const names = new Set();
  // Reset lastIndex defensively (regex is global). Cheap and idempotent.
  NODE_SPECIFIER_RE.lastIndex = 0;
  const matches = fnCode.matchAll(NODE_SPECIFIER_RE);
  for (const match of matches) {
    names.add(`node:${match[1]}`);
  }
  return Array.from(names).sort();
}
