# ADR-0005: Pure Modern JavaScript (ESM, Node.js >= 24) with Zero External Dependencies

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: language, nodejs-core, zero-dependencies, esm

## Context and Problem Statement

The ultimate goal of this project is to submit an RFC and reference implementation to the official Node.js repository (`nodejs/node`) for inclusion in the core standard library. Node.js core modules (`lib/*.js` and `lib/internal/*.js`) are authored strictly in vanilla JavaScript, with zero external dependencies and zero build/transpilation steps. How should our reference codebase be implemented to maximize alignment with Node.js core standards?

## Decision Drivers

- Must adhere directly to Node.js core development conventions.
- Must eliminate external runtime dependencies (only built-in `node:*` modules).
- Must utilize modern ECMAScript features available in Node.js 24 (top-level await, class private fields `#field`, `structuredClone`, `availableParallelism`).
- Must utilize Node.js native test runner (`node:test`) and assertions (`node:assert/strict`).

## Considered Options

- **Option 1: TypeScript with build toolchain (tsc, rollup, esbuild)**
- **Option 2: CommonJS with backward compatibility for older Node versions**
- **Option 3: Pure Modern JavaScript (ESM) targeting Node.js >= 24 with zero external dependencies**

## Decision Outcome

Chosen option: **"Option 3: Pure Modern JavaScript (ESM) targeting Node.js >= 24 with zero external dependencies"**, because it matches the exact environment, style, and structure of Node.js core internal modules. The code can be evaluated, benchmarked, and transferred directly into `lib/internal/worker/` or a new `node:worker_runtime` built-in module.

### Positive Consequences

- Zero build steps or transpile latency.
- Directly readable by Node.js TSC maintainers without translation layers.
- Fast execution and lean footprint.
- Native testing with `node --test` avoids testing framework bloat (Jest/Vitest).

### Negative Consequences

- Requires manual JSDoc annotations for IDE type hinting rather than TypeScript static compile checking.
