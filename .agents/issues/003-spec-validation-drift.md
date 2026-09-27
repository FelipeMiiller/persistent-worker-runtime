# Spec validation drift: `spec.md` files were never run through `validate_spec.py`

**Status**: ✅ **FIXED** (2026-09-27) — all 13 features now validate 0 errors on both `validate_spec.py` and `validate_tasks.py`.

**Discovered**: 2026-09-27 during a full sweep of `.specs/features/*/`.
**Component**: `.specs/` (gitignored local planning state — the fix is local by design; this file is the tracked record).

## Symptom

The `durable-queue` and `health-probes` specs were reported as "both validated" after the
v0.3.0 session on 2026-09-24. They had in fact only been run through
`validate_tasks.py`, not `validate_spec.py`. A full sweep found **9 errors** across 3 spec files
that had never been checked against the spec-side closure gate.

| File | `validate_spec.py` before | after |
| --- | --- | --- |
| `.specs/features/durable-queue/spec.md` | 2 errors (missing `## User Stories`, `## Requirement Traceability`) | 0 errors, 0 warnings |
| `.specs/features/health-probes/spec.md` | 2 errors (same two sections) | 0 errors, 0 warnings |
| `.specs/features/persistent-worker-runtime/spec.md` | 5 errors (missing `## Problem Statement`, `## Out of Scope`, `## Assumptions & Open Questions`, `## User Stories`, `## Requirement Traceability`) | 0 errors, 0 warnings |

Total across all 13 features after the fix: **0 errors** on both validators. The remaining
warnings are all legitimate `Where: names multiple files` granularity smells, plus four
`AC has SHALL but no recognizable EARS lead keyword` advisories on the older specs.

## Root cause

1. **The two validators cover different artifacts.** `validate_tasks.py` checks
   `tasks.md` (sections, `Tests`/`Gate` fields, diagram↔definition parity). `validate_spec.py`
   checks `spec.md` (the five required template sections, EARS-shaped acceptance criteria,
   assumptions-table cells, requirement-ID format). Running one does not imply the other, and
   "0 errors on tasks.md" was reported as if it covered the whole feature.
2. **`persistent-worker-runtime/spec.md` predates the template entirely.** It shipped with only
   `## 1. Overview` + `## 2. Functional Requirements` (EARS). It was never migrated, and nothing
   had flagged it because nobody ran the spec-side gate across the whole `.specs/features/` tree.

## Resolution (2026-09-27)

### 1. `durable-queue/spec.md` — added two sections

- `## User Stories` — four stories (P1 durable enqueue + restart survival, P2 lease-based atomic
  claim, P3 orphan reclaim + retry budget, P4 operational surface), each with an EARS-shaped
  `Acceptance Criteria` list and an `Independent Test`.
- `## Requirement Traceability` — `DB-01`..`DB-10`, matching the IDs already used by
  `completion-checklist.md` and the task/ADR/test references in the rest of the spec.

### 2. `health-probes/spec.md` — added two sections

- `## User Stories` — three stories (P1 liveness, P2 readiness, P3 probe cost +
  transport-agnostic contract), criteria derived from the existing `reason` vocabulary tables in
  `## Architecture`.
- `## Requirement Traceability` — `HP-01`..`HP-10`, matching `completion-checklist.md` and the
  existing `Test Coverage Matrix` row-for-row.

### 3. `persistent-worker-runtime/spec.md` — added all five sections

- `## Problem Statement`, `## Out of Scope`, `## Assumptions & Open Questions` — derived from
  ADR-0005, ADR-0018, ADR-0020, ADR-0023, `AGENTS.md`, and `docs/operations/disaster-recovery.md`.
- `## User Stories` — seven stories (P1 event-loop freedom, P2 warm L1 state, P3 safe background
  dispatch, P4 bounded backpressure, P5 crash containment, P6 real cancellation, P7 zero-copy
  transfer), one per EARS class already present in §2.
- `## Requirement Traceability` — `PWR-01`..`PWR-14` with a `Source REQ` column preserving the
  original `REQ-<CLASS>-<NNN>` IDs verbatim.

**Requirement ID scheme note (worth remembering):** `validate_spec.py` enforces
`ID_RE = ^[A-Z][A-Z0-9]*-\d+$` — exactly one hyphen. The project's original EARS IDs
(`REQ-UBI-001`) have two, so they cannot be used directly as traceability IDs. The fix keeps §2
untouched and normalizes only the traceability column, with a `Source REQ` column preserving
the original strings. **Do not "fix" §2 by rewriting the REQ IDs** — they are referenced from
ADR-0024, the task files, and the tests.

**No functional requirement was added, removed, or reworded** in any of the three files. The new
sections are traceability and decision framing around requirements that already existed.

## Prevention

When closing out a feature, run **both** validators over the whole tree, not just the feature
being worked on:

```bash
Get-ChildItem -Recurse -Filter spec.md .specs\features | ForEach-Object {
  py .agents/skills/tlc-spec-driven/scripts/validate_spec.py $_.FullName
  py .agents/skills/tlc-spec-driven/scripts/validate_tasks.py $_.FullName.Replace('spec.md','tasks.md')
}
```

`AGENTS.md` cites this issue file from the "Tracked Issues & Known Drift" table. If a future
session reports "spec validated", treat that as ambiguous until both commands have been run.
