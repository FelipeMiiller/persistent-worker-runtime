# ADR-0005: Pure Modern JavaScript (ESM, Node.js >= 24) with Zero External Dependencies

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: language, zero-dependencies, esm

## Context and Problem Statement

The runtime operates inside a single Node.js process and is consumed by other Node.js code. The author wants the smallest possible install footprint, zero supply-chain surface, and the ability to read the codebase top-to-bottom without chasing third-party semantics. Node.js itself ships standard-library modules (`lib/*.js` and `lib/internal/*.js`) authored in vanilla JavaScript with zero external dependencies and zero build steps — that style is also the best fit for a concurrency primitive that lives next to the Event Loop. How should the reference codebase be implemented to maximize readability, longevity, and alignment with the platform it runs on?

## Decision Drivers

- Must eliminate external runtime dependencies (only built-in `node:*` modules).
- Must leverage modern ECMAScript features available in Node.js 24 (top-level await, class private fields `#field`, `structuredClone`, `availableParallelism`).
- Must use Node.js native test runner (`node:test`) and assertions (`node:assert/strict`) — no external test framework.
- Must keep the published tarball small and free of native add-on compilation.

## Considered Options

- **Option 1: TypeScript with build toolchain (tsc, rollup, esbuild)**
- **Option 2: CommonJS with backward compatibility for older Node versions**
- **Option 3: Pure Modern JavaScript (ESM) targeting Node.js >= 24 with zero external dependencies**

## Decision Outcome

Chosen option: **"Option 3: Pure Modern JavaScript (ESM) targeting Node.js >= 24 with zero external dependencies"**, because it matches the runtime's own conventions, removes transpile and build-tool overhead, and keeps the dependency tree empty. The codebase can be read and benchmarked as-is by anyone with a recent Node.js install.

### Positive Consequences

- Zero build steps or transpile latency.
- Fast execution and lean footprint.
- Native testing with `node --test` avoids testing framework bloat (Jest/Vitest).
- Easy to audit — no hidden build artifacts or generated code paths.

### Negative Consequences

- Requires manual JSDoc annotations for IDE type hinting rather than TypeScript static compile checking.
