---
title: "Pure JavaScript & Zero Dependencies"
category: rule
summary: "Strict requirement for runtime code to be authored in vanilla JavaScript ESM with zero external dependencies."
---

# Pure JavaScript & Zero Dependencies

The runtime is built with zero external dependencies so the install footprint stays small and the code can be read top-to-bottom without chasing third-party semantics.

## Mandatory Guidelines

1. **Vanilla JavaScript Only in `src/`:**
   - All runtime files must be standard ECMAScript Modules (`.js`).
   - Never introduce compilation or transpilation steps (no TypeScript, Babel, Rollup, or Webpack in runtime paths).
2. **TypeScript Types in `index.d.ts`:**
   - Type definitions are provided exclusively via `src/index.d.ts` for IDE support.
3. **Zero External Runtime Dependencies:**
   - Only built-in Node.js modules are permitted: `node:worker_threads`, `node:async_hooks`, `node:events`, `node:perf_hooks`, `node:os`.
   - Never add npm dependencies to `"dependencies"` in `package.json`.
