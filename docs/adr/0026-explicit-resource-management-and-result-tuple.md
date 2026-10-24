# ADR-0026: Explicit Resource Management (`Symbol.asyncDispose`) and the Go-Style Result Tuple (`attempt`)

- **Status**: Accepted
- **Date**: 2026-10-24
- **Spec**: `.specs/features/defer-and-multi-return/spec.md`
- **Tags**: lifecycle, typescript, public-api

## Context and Problem Statement

A reference document on advanced Go concurrency patterns applied to Node.js
proposes four ideas. Two of them map cleanly onto what the Persistent Worker
Runtime (PWR) already does; two are incompatible with it:

| Source section | Idea | Outcome |
| -------------- | ---- | ------- |
| §5.1 | Explicit Resource Management — `Symbol.asyncDispose` | **In scope** (this ADR) |
| §5.2 | Multi-return errors — a helper returning `(err, value)` | **In scope** (this ADR) |
| §1 | Ring buffer over `SharedArrayBuffer` | Out of scope |
| §2 | `sync.Mutex` / `sync.WaitGroup` | Out of scope |
| §3 | Channels / `select`, and a worker "daemon" blocked in `Atomics.wait()` | Out of scope |

### §5.1 — the lifecycle problem

Every consumer that creates a runtime has to remember to tear it down:

```js
const runtime = await createWorkerRuntime({ workers: 4 });
try {
  await runtime.execute({ type: 'report', fn: buildReport });
} finally {
  await runtime.shutdown(); // easy to forget; leaks worker threads on early return
}
```

The `try/finally` dance is exactly what the Explicit Resource Management
proposal removes. On Node.js >= 24 a consumer can write:

```js
{
  await using runtime = await createWorkerRuntime({ workers: 4 });
  await runtime.execute({ type: 'report', fn: buildReport });
} // runtime.shutdown() runs here — even if the block threw
```

For PWR this matters more than for an average library: a leaked runtime is a
leaked **pool of OS threads**, not a leaked file handle.

### §5.2 — the error-handling problem

Go returns the error instead of throwing it:

```go
v, err := doSomething()
if err != nil {
    return nil, fmt.Errorf("wrapped: %w", err)
}
```

JavaScript has no multi-return. The idiomatic translation is a two-element
tuple, so the caller can branch on the error **without** a `try/catch` around
every call.

### The hard constraint: the library cannot use the syntax

`package.json` declares `engines.node >= 22.13.0`. The parser of Node.js
22.13.0 does **not** understand `using` / `await using` — the syntax only
lands in Node.js >= 24. A library that ships the syntax in its own source
would fail to parse on the floor version it advertises.

Therefore:

> The library implements the **protocol** (`[Symbol.asyncDispose]()` as a
> method) and never the **syntax**. The consumer on Node.js >= 24 is the one
> who writes `await using`.

### The second hard constraint: the declaration file must not break consumers

`Symbol.asyncDispose` is only declared by TypeScript's `esnext.disposable`
lib, which is **not** part of the default `lib` set of `target: ES2022`. A
declaration file that used the symbol without pulling that lib in would break
the build of every consumer that does not opt in explicitly — in a project
that has just gained a types gate (`test/types-surface.test.js`, issue 005).

## Decision Drivers

- A leaked runtime leaks **OS threads**; the teardown must be impossible to forget.
- The library must keep parsing on Node.js 22.13.0 (the declared `engines` floor).
- The package must not gain a runtime dependency (ADR-0005).
- The declaration file must compile for a consumer with `target: ES2022` and
  **no extra configuration**.
- The feature must stay **additive**: no change to `task-handle.js`,
  `supervisor.js`, `task-queue.js` or `queue/sqlite-backend.js`.
- `test/types-surface.test.js` compares the runtime exports with the
  declaration file **in both directions** — the two must stay in parity.

## Considered Options

### For §5.1 — the disposal surface

- **Option A** — implement `[Symbol.asyncDispose]()` on `WorkerRuntime`.
- **Option B** — implement the synchronous `[Symbol.dispose]()` too.
- **Option C** — do nothing; keep the `try/finally` idiom.

### For §5.2 — the error helper

- **Option A** — export an `attempt()` helper returning `[error, value]`.
- **Option B** — export a generic `goFunc()` wrapper.
- **Option C** — do nothing; keep `try/catch`.

### For the declaration file

- **Option A** — `/// <reference lib="esnext.disposable" />` + `[Symbol.asyncDispose]()`.
- **Option B** — a locally declared `unique symbol` + `[asyncDisposeSymbol]()`.
- **Option C** — no declaration (the member stays invisible to TypeScript).

## Decision Outcome

Chosen: **Option A** for all three axes.

### §5.1 — `WorkerRuntime[Symbol.asyncDispose]()`

`src/worker-runtime.js` gains:

```js
async [Symbol.asyncDispose]() {
  await this.shutdown();
}
```

- The teardown is **exactly** `shutdown()`: the queue is drained, in-flight
  streams are aborted and every worker thread is terminated. The returned
  promise resolves only **after** the teardown completed, so the scope
  boundary is also the "workers are gone" boundary.
- It is **idempotent**: `shutdown()` is idempotent (verified — two consecutive
  calls do not throw and leave `isAlive()` at `{ok:false, reason:'shutting-down'}`),
  so disposing an already-shut-down runtime, or disposing twice, is safe.
- **No synchronous `[Symbol.dispose]`** (Option B rejected). The teardown is
  asynchronous — worker threads are terminated over the event loop — so a
  synchronous `dispose` could only fire-and-forget the shutdown, breaking the
  guarantee that "the teardown finished when the scope ended". Implementing
  only the async half is also what the Explicit Resource Management proposal
  expects of an async resource.

### §5.2 — `attempt()`

Exported from the package root (`src/index.js`), making it the 17th public
name:

```js
const [err, value] = await attempt(() => runtime.execute({ type: 'report' }));
if (err) {
  return [new Error(`Falha no worker: ${err.message}`), null];
}
```

Contract:

- it **never throws and never rejects** — the error is *returned*;
- success → `[null, value]`, failure → `[error, undefined]`;
- the **original error object** is preserved — same identity, same `cause`,
  same `stack`. Nothing is wrapped;
- `error` is `null` on success (the analogue of Go's `nil`), never
  `undefined`, so `if (err)` is the only check a caller needs;
- a resolved `undefined` value is **not** an error: the result is
  `[null, undefined]`;
- the input may be a **thunk** (`() => T | Promise<T>`) **or** a promise. The
  thunk form is the faithful mapping of Go's `v, err := doSomething()`: it
  also captures a **synchronous** throw, which a bare promise cannot.

**Why `attempt` and not `goFunc`** (Option B rejected): `goFunc` reads oddly
in a library that is not Go, and it promises a *function wrapper* when the
useful thing is a *result tuple*. `attempt` reads naturally at the call site
and matches the Go semantics that matter (error returned, not thrown).

**Why the root export and not a namespace**: the helper has no dependency on
the runtime — it works on any promise. Burying it under a namespace would
make the common case (`const [err, value] = await attempt(...)`) noisier than
the thing it replaces. The root export also keeps the helper discoverable by
the AI agents that read the shipped skill.

**Where the helper lives**: `src/attempt.js`, re-exported by `src/index.js`.
`src/index.js` is, by convention, a pure re-export barrel — putting an
implementation there would break that convention for a 15-line function. A
dedicated module keeps the helper independently unit-testable and leaves the
barrel declarative.

### The declaration file — the portability decision

**Chosen: `/// <reference lib="esnext.disposable" />`** at the top of
`src/index.d.ts`, plus the member:

```ts
[Symbol.asyncDispose](): Promise<void>;
```

The directive adds the lib to the program that consumes the file, so the
consumer needs **no** extra configuration: `target: ES2022` with the default
libs is enough.

The alternative — Option B, a locally declared `unique symbol` — was
**rejected on measured evidence**: it compiles without any lib, but the
member is then keyed by a *different* symbol than `Symbol.asyncDispose`, and
the consumer's `await using` stops type-checking. The runtime key must be the
real well-known symbol, otherwise the engine never calls the method.

#### Measured evidence

TypeScript 5.9.3, compiling the shipped `src/index.d.ts` against synthetic
consumers (the harness lives outside the repository — TypeScript is **not** a
dependency of this package):

| Variant | Consumer A — `target: ES2022`, `lib: ["ES2022"]`, `types: []` (worst case) | Consumer B — `target: ES2022`, `lib: ["ES2022"]`, `types: ["node"]` | Consumer C — `await using` |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| **A — shipped (directive + real symbol)** | **exit 0** | **exit 0** | **exit 0** |
| **B — control (directive removed)** | **exit 2** — `TS2550: Property 'asyncDispose' does not exist on type 'SymbolConstructor'` | exit 0 | exit 0 |
| **C — portable fallback (`unique symbol`)** | exit 0 | exit 0 | **exit 2** — `TS2851: The initializer of an 'await using' declaration must be either an object with a '[Symbol.asyncDispose]()' or '[Symbol.dispose]()' method…` |

Reading the matrix:

- Variant B is the **control**: it proves the directive is load-bearing, not
  decoration. Without it the declaration file breaks a consumer that does not
  opt into `esnext.disposable`.
- Variant C is the **portable** alternative: it needs no lib, but it breaks
  the very use case the feature exists for — the consumer's `await using`.
  It was therefore rejected.
- Consumers B and C hide the problem because `@types/node` itself carries
  `/// <reference lib="esnext.disposable" />` (verified in `@types/node`
  26.6.5) and because `lib: ["ESNext"]` includes the lib. Consumer A removes
  both, which is why it is the one that shows the difference.

**Known limit, accepted**: the directive requires **TypeScript >= 5.2** (the
version that introduced the `esnext.disposable` lib). Measured on TypeScript
5.1.3, the consumer gets `TS2726: Cannot find lib definition for
'esnext.disposable'` plus `TS1165`/`TS2339` on the member. The price is a
documented minimum TypeScript version instead of a broken build for the far
more common modern consumer. A global augmentation of `SymbolConstructor` was
considered and rejected: `@types/node` declares the same members, and the two
declarations conflict (`TS2717`).

**What is NOT in the repository**: the `tsc` harness above. Adding
`typescript` as a devDependency would break the zero-dependency posture of
the package (ADR-0005) for a check that only matters for the declaration
file. The in-repo guard is therefore **static**
(`test/explicit-resource-management.test.js`): it asserts that the directive
is present, that the member is declared against the real
`Symbol.asyncDispose`, and that the parallel-symbol fallback is absent — so
the portability property cannot silently regress.

## Pros and Cons of the Options

### §5.1 — Option A ✅ Chosen

- ✅ The teardown of a thread pool becomes impossible to forget.
- ✅ Zero runtime dependency; zero change to the existing modules.
- ✅ The library keeps parsing on Node.js 22.13.0 — the protocol is a plain
  method, the syntax is the consumer's choice.
- ❌ A consumer on Node.js < 24 cannot use the `await using` syntax (it can
  still call `runtime[Symbol.asyncDispose]()` by hand).

### §5.1 — Option B (synchronous `[Symbol.dispose]`)

- ❌ Rejected: the teardown is asynchronous, so a synchronous `dispose` could
  only fire-and-forget the shutdown and break the "teardown finished when the
  scope ended" guarantee.

### §5.1 — Option C (no change)

- ❌ Rejected: the `try/finally` boilerplate stays, and a forgotten
  `shutdown()` leaks OS threads.

### §5.2 — Option A (`attempt`) ✅ Chosen

- ✅ Removes the `try/catch` nesting around every awaited call.
- ✅ Keeps the original error object intact (identity, `cause`, `stack`).
- ✅ Works with any promise — it is not coupled to the runtime.

### §5.2 — Option B (`goFunc`)

- ❌ Rejected: the name promises a wrapper, the semantics that matter are the
  result tuple.

### Declaration file — Option A (reference directive) ✅ Chosen

- ✅ The consumer compiles with `target: ES2022` and no extra configuration.
- ✅ `await using` keeps working for the consumer.
- ❌ Requires TypeScript >= 5.2.

### Declaration file — Option B (portable `unique symbol`)

- ❌ Rejected: breaks the consumer's `await using` (measured: `TS2851`).

### Declaration file — Option C (no declaration)

- ❌ Rejected: the runtime and the declaration file drift apart, which the
  types-surface gate (`test/types-surface.test.js`) exists to prevent.

## Consequences

- The package gains one public export (`attempt`) and one protocol method.
- `src/index.d.ts` now requires TypeScript >= 5.2 to be consumed. The
  runtime itself is unaffected — it still runs on Node.js >= 22.13.0.
- `src/` must never contain the `using` / `await using` syntax. A static test
  enforces this (`test/explicit-resource-management.test.js`), including a
  self-test proving the scanner is not vacuous.
- The runtime exposes **17** public names.

## Out of Scope

§1 (ring buffer over `SharedArrayBuffer`), §2 (`sync.Mutex` / `sync.WaitGroup`)
and §3 (channels / `select` / a worker daemon blocked in `Atomics.wait()`) are
**not** in this ADR, and not in this feature. The reason is not that they are
unnecessary — it is that they are **incompatible with the contract the runtime
already has**:

1. **The PWR worker needs a live event loop.** It executes the user's `fn` per
   task and supports `AbortSignal` cancellation (ADR-0017), chunked streaming
   (ADR-0012), hard preemption (ADR-0011) and task timeouts. A worker parked
   in `Atomics.wait()` has **no event loop**: it receives no abort message, it
   pushes no stream chunks, it runs no preemption timer. The "daemon" would
   break four existing contracts.
2. **There is no shared memory today** — zero `SharedArrayBuffer` / `Atomics`
   in `src/`. A mutex over shared memory would protect nothing: there is no
   shared-memory race to protect.
3. **The measured bottleneck was never the copy.** In the real 10 GB JSON
   case the cost was disk + parse, not `postMessage`. The zero-copy path
   already exists and is the `transferList` (ADR-0008).
4. `Atomics.wait()` on the main thread would block the event loop — the
   source document admits it — and the whole ring-buffer design depends on
   the daemon.

## Verification

- `node --test test/explicit-resource-management.test.js` → 14/14 passing.
- `npm run validate` → exit 0 (lint + full suite + hot-path benchmark).
- `npm run skill:validate` → 0 syntax-error / 0 runtime-error.
- `node --test test/types-surface.test.js` → 10/10 passing (the runtime
  export and the declaration file are in parity, in both directions).
- TypeScript portability matrix → see "Measured evidence" above
  (TypeScript 5.9.3 and 5.1.3, run outside the repository).

## Links

- `.specs/features/defer-and-multi-return/spec.md`
- `src/worker-runtime.js` — `async [Symbol.asyncDispose]()`
- `src/attempt.js` — the `attempt()` helper
- `src/index.d.ts` — the `/// <reference lib="esnext.disposable" />` directive
- `test/explicit-resource-management.test.js`
- ADR-0005 — Pure Modern JavaScript with Zero External Dependencies
- ADR-0012 — Streaming Task Results via Async Generators
- ADR-0017 — Cooperative Cancellation via `AbortSignal`
- ADR-0025 — Fire-and-Forget `dispatch()` Promise Contract
