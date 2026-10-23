# The shipped skill's outbox pattern references an out-of-scope variable

**Status**: 🔴 **OPEN** — a code block in the published skill throws `ReferenceError` when copied
verbatim.

**Discovered**: 2026-10-23, while implementing issue 008 (the `dispatch()` promise contract).
**Component**: `skills/persistent-worker-runtime/references/patterns.md`

## The defect

`skills/persistent-worker-runtime/references/patterns.md`, Pattern 1 (transactional outbox), the
`onComplete` / `onError` handlers reference `p.outboxId`:

```javascript
handle.onComplete(async (result) => {
  await db.outbox.update(p.outboxId, { status: 'COMPLETED', result });
});
handle.onError(async (err) => {
  await db.outbox.update(p.outboxId, { status: 'FAILED', error: err.message });
});
```

There is no `p` in scope in that snippet — the pattern's own row variable is named `row`. Copying
the block produces `ReferenceError: p is not defined` on the first completion.

This is exactly the defect class the new skill gate exists to catch, and it slipped through because
the block is classified as a **fragment** (it depends on `db` and on the surrounding loop), and
fragments are executed only syntactically, not run.

## Why it matters

The skill ships inside the npm tarball and is loaded by AI agents that treat it as authoritative.
A pattern that is copied verbatim and crashes is a pattern that reproduces the bug in someone
else's project. The surrounding prose recommends this pattern as the recommended way to implement a
transactional outbox.

## Proposed fix

Correct the variable name in the snippet (`p.outboxId` → the identifier the pattern actually
defines), and re-check the other patterns in the same file for the same mistake.

The deeper question is whether the gate should catch it: today `FRAGMENT` blocks are parsed but not
executed, so a `ReferenceError` inside a fragment is invisible. Options:

1. Fix the snippet and leave the classification as is (cheap; the defect class stays uncovered).
2. Add a static scope check to the gate: for a fragment, report identifiers that are read but never
   bound in the snippet and are not known globals — the same signal the gate already uses to
   classify "fragment of a larger program". This would have caught `p` here, at the cost of false
   positives that need an allowlist.

Option 2 is the one that generalises; option 1 is the one that fixes this instance.

## Prevention

- **A fragment that is only parsed is only half-checked.** The gate's fragment category is a
  known blind spot: syntax errors are caught, undeclared identifiers are not.
- **When a worker finds a defect outside its scope, it should file it rather than silently widen
  the scope.** This issue exists because the implementation of issue 008 stopped at the promise
  contract, which is the correct boundary.
