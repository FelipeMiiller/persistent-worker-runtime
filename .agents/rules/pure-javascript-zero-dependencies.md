---
title: "Pure JavaScript & Zero Dependencies"
category: rule
summary: "Strict requirement for runtime code to be authored in vanilla JavaScript ESM with zero external dependencies for Node.js Core alignment."
---

# Pure JavaScript & Zero Dependencies

The primary target of this project is inclusion in **Node.js Core (`nodejs/node`)**.

## Mandatory Guidelines

1. **Vanilla JavaScript Only in `src/`:**
   - All runtime files must be standard ECMAScript Modules (`.js`).
   - Never introduce compilation or transpilation steps (no TypeScript, Babel, Rollup, or Webpack in runtime paths).
2. **TypeScript Types in `index.d.ts`:**
   - Type definitions are provided exclusively via `src/index.d.ts` for IDE support.
3. **Zero External Runtime Dependencies:**
   - Only built-in Node.js modules are permitted: `node:worker_threads`, `node:async_hooks`, `node:events`, `node:perf_hooks`, `node:os`.
   - Never add npm dependencies to `"dependencies"` in `package.json`.
