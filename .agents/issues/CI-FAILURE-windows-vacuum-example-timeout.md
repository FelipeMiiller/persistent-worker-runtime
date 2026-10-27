# The vacuum example timed out on Node 22 / Windows in the examples gate

**Status**: ✅ **FIXED** 2026-10-27.

**Discovered**: 2026-10-27, in CI run `40533324325` (the v0.4.0 release candidate).
**Component**: `examples/durable-task-vacuum.js` + `scripts/run-examples.js`
**Symptom**: `[FAIL] durable-task-vacuum.js — timed out after 60000 ms`, in the
`Test on Node 22.x (windows-latest)` leg of the CI matrix. The other nine legs — including
`Node 24.x (windows-latest)` and `Node 26.x (windows-latest)` — ran the same example
successfully.

## Root cause

The example's workload is **fsync-bound, not CPU-bound**. `SqliteTaskQueue.enqueue` persists
each envelope in its own `BEGIN IMMEDIATE` transaction (ADR-0020), and the example enqueues
2000 tasks **twice** — once per scenario — so the workload is 4000 durable transactions.

Measured on 2026-10-27:

| Host | Workload | Wall clock |
| --- | --- | --- |
| Idle workstation, Windows, Node 24.16.0 | 2000 tasks | **2.8 s** |
| CI runner, Windows, Node 22.x, loaded (after the test and benchmark steps) | 2000 tasks | **> 60 s** — the gate's entire budget |

That is a **21× spread** between an idle host and a loaded one. The examples gate's budget is
60 s (`DEFAULT_TIMEOUT_MS` in `scripts/run-examples.js`), so the example sat exactly on the
cliff: it passed on every runner that happened to be fast, and failed on the one that was slow
enough.

**It was not a hang, and not a regression.** The example's code, `src/queue/sqlite-backend.js`
and the gate itself were unchanged by the v0.4.0 work — the same example passed on the Windows
legs of the previous CI run (`40087846047`, 2026-10-24).

## The fix

**The cliff was the workload, so the fix shrinks the workload — it does not raise the budget.**

1. `examples/durable-task-vacuum.js` grew a workload knob, `PWR_VACUUM_TASKS` (default 2000 —
   the example's own behaviour is unchanged for anyone running it directly). This mirrors the
   convention the sibling example already uses (`PWR_JSON_MB` in `parallel-json-parse.js`).
2. `scripts/run-examples.js` runs the gate with `PWR_VACUUM_TASKS=100`, with the reason
   recorded in the override table (the table requires a reason for every entry, so an
   unexplained override is distinguishable from a magic number).

Measured with the knob: **0.39 s** on the same idle workstation — a 7× reduction, which at the
observed 21× CI spread leaves the example at roughly 8 s of a 60 s budget, and still inside it
at a 100× spread.

**The budget was deliberately left at 60 s.** Raising it would have moved the cliff, not
removed it: the next runner 5× slower would fail again, and the gate would have learned
nothing. The repo has two precedents for exactly this distinction — the macOS recycling flake
(a fixed 200 ms sleep replaced by deadline-based polling) and the macOS `cpu-saturation` gate
(the two-largest-entries comparison replaced by the knee pair). Both fixed the measurement,
not the threshold.

**No coverage was traded away.** At 100 tasks the gate still exercises every path the example
documents: `enqueue`, `dequeue`, `markFailed`, `checkpointWal`, `vacuumCompleted`, and both
assertions (`failedRows > 0` without GC, `failedRows === 0` with it). The example's default of
2000 tasks — the number an agent or an operator sees when they run it — is untouched.

## Prevention

- **A gate's workload is part of the gate.** An example that costs 2.8 s on an idle host can
  cost a minute on a loaded runner; the budget must be set against the *slowest* host in the
  matrix, not the fastest one measured.
- **A workload knob in the example is cheaper than a timeout override.** The knob keeps the
  demonstration intact for a human and makes the gate's workload explicit and cheap — the
  pattern `parallel-json-parse.js` established with `PWR_JSON_MB`.
- **Prefer a budget override with a documented reason over a bare budget raise.** The override
  table requires a reason per entry precisely so "the example needs more time" is a claim
  someone has to justify, not a constant someone can bump in a hurry.
- **A per-OS failure is not automatically an OS bug.** Before attributing a timeout to the
  platform, check the other legs: the same example passed on the Windows legs of Node 24 and
  Node 26 in the very same run. The variance was in the runner's load, not in the OS.
