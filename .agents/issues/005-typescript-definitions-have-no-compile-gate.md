# `src/index.d.ts` ships to npm with no compile gate — and has already drifted from the runtime

**Status**: 🔴 **OPEN** — the definitions are unvalidated, **and 4 of the 16 public runtime exports are
missing from them today**.

**Discovered**: 2026-10-23, during a state audit of `develop` (HEAD `1ed718d`).
**Component**: `src/index.d.ts` (33.7 kB, ~900 lines), `package.json`, `.github/workflows/*`

## Evidence

`src/index.d.ts` is part of the published tarball (`files: ["src", "skills", "README.md", "LICENSE"]`)
and the README advertises the package with a *TypeScript-Ready* badge:

```
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](src/index.d.ts)
```

A repo-wide search for type-checking tooling returns **zero** hits outside prose:

```
typescript | tsc | dtslint | tsd | checkJs | @ts-expect-error
```

The only matches are: the README badge, `.npmignore`'s comment *"TypeScript build artifacts (if ever
added)"*, ADR-0005's prose, and `skills/.../references/api-reference.md` (which contains TypeScript
**examples** for consumers, also never compiled).

## Confirmed drift (measured, not hypothetical)

Diffing the runtime's public exports against the names declared in `src/index.d.ts`:

```
exports runtime       : 16
nomes declarados .d.ts: 24
AUSENTES no .d.ts (4): SqliteTaskQueue, StreamAbortedError, StreamConfigError, TaskQueue
```

All 16 runtime exports, for reference:

```
QueueOverflowError, SqliteTaskQueue, Stream, StreamAbortedError, StreamConfigError,
Supervisor, TaskAbortedError, TaskHandle, TaskQueue, TaskQueueTimeoutError,
TaskTimeoutError, WorkerCrashError, WorkerHandle, WorkerRuntime, WorkerRuntimeError,
createWorkerRuntime
```

So a TypeScript consumer writing the **documented** API gets a compile error today:

```ts
import { SqliteTaskQueue } from 'persistent-worker-runtime';
// TS2305: Module '"persistent-worker-runtime"' has no exported member 'SqliteTaskQueue'.
```

Why this is the worst combination: `SqliteTaskQueue` is a headline feature — it is in the README
feature table, it is ADR-0020, and the shipped skill's `references/api-reference.md` documents it
with `node:sqlite`. The runtime feature works, the documentation tells TypeScript users to use it,
and the type layer **denies** it. The same applies to `TaskQueue` (the in-memory queue, exported
since v0.1) and to the two streaming error classes `StreamConfigError` / `StreamAbortedError` —
`catch (e) { if (e instanceof StreamAbortedError) ... }` does not typecheck either.

Note the shape of the failure: it is invisible in JavaScript, invisible to the 622-test suite
(which is JavaScript), invisible to the 94.39% line coverage, and invisible to CI — and it lands on
the user at their first `tsc` run.

Consequences that are currently invisible:

1. A syntax error, a wrong overload, or a type that references a non-existent export ships to npm
   and only surfaces when a consumer's `tsc` fails — i.e. in the user's build, not in this repo's CI.
2. The definitions can drift from the runtime without any signal. `src/index.js` exports 16 public
   names; nothing asserts that `index.d.ts` declares them, or that it declares nothing extra.
3. The TypeScript examples embedded in the shipped skill (`references/api-reference.md`, ~15 code
   blocks) are never compiled either, so they can rot against the real API.

## Why it is not already gated

ADR-0005 (`docs/adr/0005-native-javascript-esm-with-zero-external-dependencies.md`) rules out
TypeScript **in runtime paths** — no compilation or transpilation step ships to consumers. That
decision is about the *runtime*, not about a development-time check of a hand-written `.d.ts`.
`.agents/rules/pure-javascript-zero-dependencies.md` phrases the rule as "no TypeScript ... **in
runtime paths**", which leaves room for a dev-only gate. But adding `typescript` as a devDependency
is a policy decision that deserves an explicit note rather than a silent addition, and it would grow
`npm ci` on every CI leg.

## Proposed options (pick one, in order of cost)

**Option 0 — fix the drift (not a gate; a bug fix).**
Declare the 4 missing names in `src/index.d.ts`: `SqliteTaskQueue`, `TaskQueue`, `StreamConfigError`
and `StreamAbortedError`. This is the part with immediate user-visible value and it is *not* a
policy question — it is the type layer catching up with an API the README already advertises.
It should land before (or with) whatever gate is chosen, otherwise the gate goes green over a
still-broken surface.

**Option A — zero-dependency surface gate (recommended next).**
Assert, in a `node:test` file, that every name exported by `src/index.js` is declared in
`src/index.d.ts`, and vice versa. No new dependency; catches the drift that actually breaks
consumers (a missing or extra public export). Does not catch a malformed type body.

A prototype of this check was written during discovery and produced the diff quoted above — it is
roughly 40 lines, imports `src/index.js`, parses the declared names out of `src/index.d.ts` with two
regexes, and compares the two sets.

**Option B — dev-only `tsc --noEmit`.**
Add `typescript` as a devDependency and a `tsconfig.json` with `skipLibCheck: true`, plus a
`test/types/` fixture that imports the public surface and exercises the documented signatures.
Add a CI step (not a matrix leg) that runs it. Catches malformed declarations and real type errors
in the shipped examples. Requires amending ADR-0005 (or a new ADR) to state that the rule applies to
runtime paths only.

**Option C — both.** A is cheap and always-on; B is the one that actually proves the `.d.ts`
compiles.

## Prevention

- **A published type definition is a shipped artifact.** It needs the same "does it actually work"
  question that `examples/` and `benchmarks/` already get.
- **A badge is a claim.** "TypeScript-Ready" should be backed by something that compiles the
  declarations, not only by a file that exists.
