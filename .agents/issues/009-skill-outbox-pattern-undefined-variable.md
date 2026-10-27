# The shipped skill's outbox pattern references an out-of-scope variable

**Status**: ✅ **FIXED** (2026-10-27) — both halves are closed: the shipped snippet is corrected, and
the skill gate now observes the defect class that let it through (ADR-0027).

**Discovered**: 2026-10-23, while implementing issue 008 (the `dispatch()` promise contract).
**Component**: `skills/persistent-worker-runtime/references/patterns.md`
**Snippet fixed**: 2026-10-26
**Gate coverage closed**: 2026-10-27

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

## The second mask: the observation window (closed 2026-10-27)

The import mask was only the FIRST of two independent masks. The second one was the harness
itself: its epilogue waited **one tick (50 ms)** and then called `process.exit(0)`. The outbox
pattern's drain runs on a **1000 ms** timer, so even with the import removed, the defect fired
after the harness had already exited — invisible to the gate.

Measured on 2026-10-26 with three fixtures carrying the exact defect:

| Fixture | Gate before | Gate with a 2500 ms observation window |
| ------- | ----------- | --------------------------------------- |
| Buggy, no external import | `[OK]` — **the defect passed** | `[FRAGMENT]` — undefined identifier `"p"` |
| Fixed (`row.id`), no external import | `[OK]` | `[OK]` |
| Buggy, with `import express` | `[EXTERNAL-DEPENDENCY]` | `[EXTERNAL-DEPENDENCY]` |

The first row is the one that matters: **fixing only the import mask would have been a vacuously
green fix.** The defect passes the old gate even when the import mask is removed.

ADR-0027 closes both masks:

- the harness now keeps the event loop open for a **bounded observation window** (2500 ms) when the
  block left pending timer work behind, and keeps the 50 ms fast path when it did not;
- the gate now says, per block and in the summary, whether it **observed** the body. The
  `EXTERNAL-DEPENDENCY` reason states that the body was NOT executed and that a defect inside it is
  invisible to the gate.

The shipped outbox pattern was also **split** so the gate can execute it: a dependency-free **core**
(the drain loop, which is where the defect lived) and the external **wiring** (Express, Postgres),
which the gate syntax-checks and reports honestly as not executed.

## Why the obvious fix does not work

Option 2 of the original proposal — a static scope check reporting identifiers that are read but
never bound — would **not** have caught this instance. `p` *is* bound in the snippet: it is a
parameter of the `fn` arrow function. The defect is a **cross-scope** reference (a binding of one
function read from a sibling function's body), which a "read but never bound" check cannot see.
Detecting it requires real scope analysis, and this repository has **no JavaScript parser
dependency** (ADR-0005, zero external runtime dependencies) — Node exposes no built-in parser API.
That makes a general static scope gate a **design decision, not a patch**.

## The open question (resolved 2026-10-27)

Two candidate mitigations were deferred when this issue was filed. Both are now settled by
ADR-0027:

1. **Report the mask honestly.** Done. The `EXTERNAL-DEPENDENCY` label says the body was not
   executed, and the summary counts the blocks the gate did not observe and says why.
2. **Stub the external imports** so the body actually runs. Rejected — a permissive stub cannot
   produce the data shape a pattern needs (a `db.query()` that resolves one row), so the defect
   stays behind the stub's own failure, and the stub manufactures findings of its own. The shape
   belongs to the snippet, not to the harness.

The gate now observes the defect class by **execution** instead, which needs no stub and no parser.

## Prevention

- **A block that fails on its import is not validated.** "The gate executed this snippet" is not
  the same claim as "the gate exercised this snippet's body". Read the gate's classification, not
  just its exit code.
- **A block the gate did not run is a block the gate did not validate.** The gate now says so
  itself: the summary counts the blocks it observed against the blocks it did not, and lists the
  not-observed ones with their reason. A skip must never read as a validation.
- **A worker reading a sibling scope's binding is a scope error, not a typo.** `p` reads naturally
  because `p` is the payload parameter three lines above — the eye fills in the gap. When a
  snippet mixes worker-side and main-thread identifiers, name them differently on purpose.
- **When a worker finds a defect outside its scope, it should file it rather than silently widen
  the scope.** This issue exists because the implementation of issue 008 stopped at the promise
  contract, which is the correct boundary.
- **Verify the claim before filing it.** The "fragments are parsed, not executed" explanation was
  plausible, repeated in `AGENTS.md`, and wrong. Reading `scripts/validate-skill.js` cost one
  tool call and produced the actual mechanism.
