---
title: "Spec-Driven Development"
category: rule
summary: "Rule enforcing formal specification, tasks tracking, and validation artifacts in .specs/."
---

# Spec-Driven Development

Features and core enhancements must follow the Spec-Driven methodology:

1. **State Snapshot (`.specs/STATE.md`):** Keep a live snapshot of project maturity and active milestones.
2. **Requirements in EARS Notation (`.specs/features/<name>/spec.md`):** Clear, unambiguous statements (UBIQUITOUS, EVENT-DRIVEN, STATE-DRIVEN, OPTIONAL, UNWANTED).
3. **Traceable Tasks (`.specs/features/<name>/tasks.md`):** Atomic checklist linking tasks directly to requirement IDs.
4. **Empirical Validation (`.specs/features/<name>/validation.md`):** Concrete terminal output and benchmark proofs.
