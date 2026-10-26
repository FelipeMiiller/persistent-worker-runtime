# The shipped skill's outbox pattern references an out-of-scope variable

**Status**: 🟡 **PARTIALLY FIXED** — the shipped snippet is corrected; the gate blind spot that let it
through is characterised below and remains an open design question.

**Discovered**: 2026-10-23, while implementing issue 008 (the `dispatch()` promise contract).
**Component**: `skills/persistent-worker-runtime/references/patterns.md`
**Snippet fixed**: 2026-10-26

## The defect

`skills/persistent-worker-runtime/references/patterns.md`, Pattern 1 (transactional outbox), the
`onComplete` / `onError` handlers referenced `p.outboxId`:

```javascript
handle.onComplete(async () => {
  await db.query("UPDATE outbox SET status='done' WHERE id=$1", [p.outboxId]);
});
handle.onError(async (err) => {
  await db.query(
    "UPDATE outbox SET status='failed', error=$2 WHERE id=$1",
    [p.outboxId, err.message]
  );
});
```

There is no `p` in scope in that snippet — `p` is the **worker-side** payload parameter of
`fn: async (p) => mailer.sendWelcome(p.email)`, and it does not exist in the main-thread scope where
the handlers are registered. The pattern's own row variable is named `row`. Copying the block
produced `ReferenceError: p is not defined` on the first completion.

## The fix

`p.outboxId` → `row.id` in both handlers. `row` is the loop variable of
`for (const row of rows)` over the `SELECT id, payload FROM outbox` result, and `row.id` is the
outbox row id — the same value the dispatch payload carries as `outboxId`. `const` in the `for` head
gives each iteration its own binding, so the handler closures capture the correct row.

Verified: `npm run skill:validate` → `skill gate PASSED`; a repo-wide grep for `p.<identifier>`
across `skills/` returns **no matches**.

## The root cause (corrected — the original claim in this file was wrong)

This file originally claimed the block "slipped past the skill gate because the block is a
**fragment**: fragments are parsed, not executed, so an undeclared identifier inside one is
invisible". That was **not** what happened, and `AGENTS.md` repeated the same claim.

The gate does **not** classify blocks statically. It **executes** each JavaScript block in an
isolated child process and classifies the outcome by the **first runtime error**
(`scripts/validate-skill.js` → `classifyBlockFailure`):

1. `ReferenceError: X is not defined` → `FRAGMENT`
2. `Cannot find package 'X'` → `EXTERNAL-DEPENDENCY`
3. anything else → `RUNTIME-ERROR`

Pattern 1 begins with `import express from 'express'`. ESM imports are resolved and evaluated
**before any of the module body runs**, so the child died at the import and was classified
`EXTERNAL-DEPENDENCY` — the block body never executed, the `setInterval` callback was never even
registered, and `p` was never evaluated. The `ReferenceError` was never produced, so it was never
classified.

The gate's own output makes this visible: Pattern 1 is listed under *external dependencies*
(`references/patterns.md:12`), while Patterns 4, 5 and 6 — which have no unresolvable import — are
listed under *fragments* (`references/patterns.md:166`, `:194`, `:230`).

**The real blind spot:** *an import failure masks every later error in the same block.* A block is
validated only as far as its first fatal error, so "the gate executed this snippet" does not mean
"the gate exercised this snippet's body".

## Why the obvious fix does not work

Option 2 of the original proposal — a static scope check reporting identifiers that are read but
never bound — would **not** have caught this instance. `p` *is* bound in the snippet: it is a
parameter of the `fn` arrow function. The defect is a **cross-scope** reference (a binding of one
function read from a sibling function's body), which a "read but never bound" check cannot see.
Detecting it requires real scope analysis, and this repository has **no JavaScript parser
dependency** (ADR-0005, zero external runtime dependencies) — Node exposes no built-in parser API.
That makes a general static scope gate a **design decision, not a patch**.

## Open question (deferred, deliberately)

Two candidate mitigations, neither taken here:

1. **Report the mask honestly.** Change the `EXTERNAL-DEPENDENCY` label to say the body was *not
   exercised* (today it reads as if only the package is missing). Cheap, zero risk, and it makes
   the blind spot legible in the gate output.
2. **Stub the external imports** so the body actually runs (a loader hook, or rewriting the import
   lines before execution). Non-trivial, and it introduces its own false positives: the stubbed
   API surface produces different errors than the real one.

Both are gate-design work with a false-positive budget to define. They are out of scope for the
snippet fix and are recorded here for a future maintainer decision.

## Prevention

- **A block that fails on its import is not validated.** "The gate executed this snippet" is not
  the same claim as "the gate exercised this snippet's body". Read the gate's classification, not
  just its exit code.
- **A worker reading a sibling scope's binding is a scope error, not a typo.** `p` reads naturally
  because `p` is the payload parameter three lines above — the eye fills in the gap. When a
  snippet mixes worker-side and main-thread identifiers, name them differently on purpose.
- **When a worker finds a defect outside its scope, it should file it rather than silently widen
  the scope.** This issue exists because the implementation of issue 008 stopped at the promise
  contract, which is the correct boundary.
- **Verify the claim before filing it.** The "fragments are parsed, not executed" explanation was
  plausible, repeated in `AGENTS.md`, and wrong. Reading `scripts/validate-skill.js` cost one
  tool call and produced the actual mechanism.
