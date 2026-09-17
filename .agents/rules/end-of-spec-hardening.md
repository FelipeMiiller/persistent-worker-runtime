---
title: "End-of-Spec Hardening Ritual"
category: rule
summary: "Mandatory post-implementation ritual for every spec task or ADR. Benchmarks, comprehensive tests, pipeline analysis — fix every error before declaring done."
---

# End-of-Spec Hardening Ritual

Every spec task (per `tlc-spec-driven`) and every ADR implementation must pass this **hardening ritual** before the work is declared complete and committed. "Tests pass" is the floor, not the ceiling — this rule raises the bar to "tests pass AND benchmarks run clean AND edge cases are covered AND the CI pipeline reports zero warnings."

The rule exists because shipping partial work — work that passed locally but failed elsewhere, work without memory benchmarks, work without predictive edge-case coverage — has bitten this project before. The cost of catching a CI flake or an OOM on a 28-core host after merge is far higher than catching it before push.

## When this rule applies

This rule fires on every one of these:

1. After every atomic commit per `tlc-spec-driven` Execute phase (the `verify` step inside that flow).
2. After any ADR implementation lands (the ADR's "Acceptance" section is not enough on its own).
3. Before opening a pull request.
4. After a benchmark or example has been added to `benchmarks/` or `examples/`.

## The ritual — eight steps, in order

Do not skip a step. Do not re-order. Each step's output feeds the next.

### 1. Re-read the spec / ADR acceptance criteria

Confirm every `STREAM-XX`, `REQ-XXX`, or ADR §Acceptance item is observably tested. If a criteria says "MUST emit event X" there must be a test that asserts the event is emitted. If the criteria says "MUST throw Y" there must be a test that asserts Y. **No silent coverage gaps.**

### 2. Add predictive edge-case tests

Before merging, enumerate the failure modes a hostile reviewer would point out:

- Boundary values (zero, one, max, just-over-max).
- Lifecycle edge cases (abort during await, shutdown mid-stream, worker crash mid-task).
- Cross-platform oddities (CRLF/LF, line endings, missing BOM).
- Resource exhaustion (queue full, memory pressure, worker at maxTasksPerWorker).
- Concurrency races (two consumers iterating the same stream, multiple abort signals).
- Error semantics — every error path: does it propagate, surface, get swallowed, get re-thrown?

For each edge case, either add a test or explicitly justify its absence in the spec's `completion-checklist.md`. The justification must be specific (e.g., "out of scope — handled in T5") not vague ("we'll get to it later").

### 3. Run the full pipeline

```bash
npm run validate
```

This runs `lint && test`. Every file in `src/`, `test/`, `examples/`, `benchmarks/` is linted. Every test file passes. **A failing lint or test blocks the commit** — do not pass `--no-verify` to the husky hook, do not commit with `git commit --no-verify`, do not annotate the failure and move on.

If `lint:fix` rewrites a file in a way that changes semantics, stop and review the diff manually.

### 4. Run the benchmarks

```bash
npm run benchmark:all
```

Every existing benchmark must complete without crashing. New features ship with their own benchmark(s) in `benchmarks/` (see step 5). If a benchmark regresses > 20% versus its previous run, treat it as a bug.

### 5. Memory footprint is always characterized

Any feature that allocates long-lived buffers, holds V8 isolates, or manages backpressure MUST have a memory benchmark. **Memory is the single highest-risk vector for this project** (per ADR-0019). For new features, add a benchmark under `benchmarks/` that:

- Measures RSS before, during, and after the feature runs.
- Measures per-stream queue size, per-worker heap, per-chunk allocation cost.
- Compares baseline (`workers: 1`) against explicit-N (`workers: N`) for the same workload.
- Asserts no monotonic increase over time when the workload is steady-state.

### 6. Cross-platform / CI analysis

After the local pipeline passes, examine the CI configuration in `.github/workflows/ci.yml`. Confirm:

- The CI matrix covers the same OS the local pipeline runs on (Ubuntu + macOS + Windows per `.github/workflows/ci.yml`).
- Any OS-specific assumptions (line endings, file paths, native API availability) are guarded by a `process.platform` branch or a test that runs on the relevant OS.

If a CI failure was reported (in commit messages, PR comments, or `git log` grep for "CI flake"), create a regression test that reproduces the failure and tag it with the original commit hash in the test comment.

### 7. Pipeline-zero-warning pass

Run:

```bash
npm run validate
```

one more time and read the full output. There must be:

- Zero failing tests.
- Zero skipped tests (unless explicitly documented in the spec).
- Zero TODO-style `console.warn` / `process.emitWarning` other than the documented ones (e.g. `PersistentWorkerRuntimeDefaultSizing`).
- Zero biome warnings (any warning that survives `lint:fix` is a real warning).
- Zero unhandled-promise warnings.
- Zero uncaught-exception warnings.

If any of these fires, fix the source. **Don't silence warnings** — silence is a lie that comes back as a CI flake.

### 8. Update the spec's `completion-checklist.md`

Every spec gets a `completion-checklist.md` file (see below). It records:

- The 5–8 critical edge cases that the spec promises to handle, each with a `[x]` once a test exists.
- The benchmark files shipped with the spec.
- The command(s) to reproduce the validation locally.
- A "Lessons" section that captures any non-obvious debugging done during hardening (e.g., "T2 emitted zero chunks because `new Function()` strips AsyncGeneratorFunction identity — fix: regex fallback in `isGeneratorFunction`").

This file is the **handoff document for the next chat**. Update it before declaring the work done.

## How to respond to errors found mid-ritual

If any step surfaces an error:

1. **Stop the ritual.** Do not push, do not mark the spec task complete, do not open a PR.
2. **Reproduce minimally.** Write a one-test reproduction in `test/` that captures the failure. If you can't reproduce in a unit test, capture the exact command output and the env (Node version, OS, available parallelism).
3. **Fix the source.** Edit `src/` until the new reproduction test passes AND every existing test still passes.
4. **Decide on ADR scope.** Only escalate to a new ADR if the fix introduces a non-obvious design choice that future readers will need to understand. **Routine bug fixes do not need an ADR** — the commit message is the documentation. An ADR is for "we changed the shape of the protocol because of X", not for "we fixed a typo".
5. **Re-run the entire ritual from step 1.** A fix in step 4 can surface a regression in step 1's coverage map. Don't trust a green later step if an earlier step was incomplete.

## Quick checklist (paste into the spec's `completion-checklist.md`)

```markdown
## Completion checklist

- [ ] All spec / ADR acceptance criteria are tested (step 1).
- [ ] Predictive edge-case tests added with hostile-reviewer mindset (step 2).
- [ ] `npm run validate` is green: lint + tests, zero warnings (steps 3 + 7).
- [ ] `npm run benchmark:all` runs without crashing (step 4).
- [ ] Memory benchmark exists if the feature allocates long-lived state (step 5).
- [ ] Cross-platform / CI considerations reviewed (step 6).
- [ ] `completion-checklist.md` is updated (step 8).

## Lessons
<non-obvious debugging notes from this spec's hardening>
```

## Anti-patterns (these mean you skipped the ritual)

- A green test count with `tests skipped` greater than zero and no documented reason.
- A feature without a `completion-checklist.md` file.
- A new public API with zero benchmarks.
- A bug fix merged as a one-liner with the body "fix typo" — the underlying issue was almost always a deeper design problem, and the one-liner did not address it.
- An ADR's "Acceptance" section that maps to zero tests.
- A benchmark that runs but produces no useful number (always passes, never asserted).
- A comment in the form "TODO: handle edge case X" left in `src/`.

The rule that overrides all other rules: **if a test exists that proves a feature works, and a benchmark exists that proves the feature doesn't regress, and an edge-case test exists that proves the feature doesn't break under stress, then the feature is done. If any of these is missing, the feature is not done, regardless of how green the local pipeline is.**