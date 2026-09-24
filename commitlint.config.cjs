/**
 * Commitlint config — Conventional Commits (default).
 *
 * Replaces the previous `core-validate-commit` validator from Node.js core,
 * which enforced Node.js-specific rules (DCO `Signed-off-by` trailer,
 * `async_hooks`/`buffer`/`crypto`-style subsystems) that don't apply to
 * this personal project. `@commitlint/config-conventional` accepts the
 * standard Conventional Commits shape (`type(scope): subject`) used
 * throughout this repo.
 *
 * Used by `.github/workflows/commit-lint.yml` and locally via
 *   npx --yes @commitlint/cli --config commitlint.config.js
 */

module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allow up to 100 chars in subject (conventional default is 72).
    'header-max-length': [2, 'always', 100],
    // Don't enforce subject case — Conventional Commits spec is silent on
    // case. Both "feat: add thing" and "feat: Add thing" are acceptable;
    // many real-world commits use capital first letters (proper nouns,
    // acronyms, etc.).
    'subject-case': [0],
    // Allow `examples` as a custom type — used in this repo for commits
    // that update `examples/` (the embedded runnable demos). Standard
    // types + `examples` cover everything this repo actually emits.
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'examples',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
    // Scope is intentionally unrestricted (any lowercase-kebab token).
  },
};
