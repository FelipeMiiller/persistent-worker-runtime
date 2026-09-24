# Examples Inventory — current state

This file is the **source of truth** for which examples exist in `examples/*.js` and what header tag each one carries. Update when adding, removing, or re-tagging an example.

Last verified: 2026-09-24.

## Inventory

| File | Tag | Metric | Last updated | Notes |
| --- | --- | --- | --- | --- |
| `adaptive-concurrency.js` | `[perf-tested]` | totalMs for 50-task CPU burst (auto vs fixed) | 2026-09-24 | Part 1 = telemetry shape; Part 2 = load burst perf |
| `broadcast-cache-invalidation.js` | `[perf-tested]` | cold vs warm avgLatencyMs per read | 2026-09-24 | 5 phases; cumulative saving printed in take-away |
| `cancel-on-disconnect.js` | `[perf-tested]` | wall-clock for 5 s task (cancel @100 ms vs run-to-completion) | 2026-09-24 | Scenario C = pre-aborted sync reject |
| `durable-task-queue.js` | `[perf-tested]` | tasksPreserved (memory=0, sqlite=N) across simulated crash | 2026-09-24 | 200/200 preserved with SQLite, 0/200 with memory |
| `durable-task-priority.js` | `[perf-tested]` | recoveredSize + firstPriorityDequeued + affinityMatchesFirst after restart | 2026-09-24 | 10/10 preserved with priority + affinity intact |
| `durable-task-vacuum.js` | `[perf-tested]` | failedRowsPending (no-GC=2000, with-GC=0) + checkpointWalMs | 2026-09-24 | Queue-only (no workers); failed rows are GC-eligible |
| `event-target-pattern.js` | `[perf-tested]` | cleanup wall-clock + apiCalls (1 vs N) | 2026-09-24 | LISTENER_COUNT capped at 10 (Node EventTarget hard limit) |
| `express-outbox-email.js` | `[perf-tested]` | httpDurationMs (dispatch vs sequential) | 2026-09-23 | 76× speedup measured |
| `image-resizer-batch.js` | `[perf-tested]` | setInterval tick count during burst | 2026-09-24 | 27× more ticks with workers |
| `persistent-ai-model.js` | `[perf-tested]` | totalMs for 10 queries (L1 cache vs rebuild) | 2026-09-23 | Model size = 5 000 entries (inlined into both fns) |
| `priority-routing.js` | `[perf-tested]` | firstInteractiveIdx (priority=10 vs priority=0) | 2026-09-23 | 30 slots earlier with priority |
| `streaming-csv-export.js` | `[perf-tested]` | rowsWritten, throughput (rows/sec), backpressure events | 2026-09-22 | Pre-existing — had metric before rule was added |
| `streaming-llm.js` | `[perf-tested]` | TTFT, total time, event counts | 2026-09-22 | Pre-existing — had metric before rule was added |
| `worker-recycling.js` | `[perf-tested]` | per-cycle overhead (recycling latency, not throughput win) | 2026-09-24 | Event-driven wait replaces polling waitFor |
| `zero-copy-image.js` | `[perf-tested]` | elapsedMs (transfer vs copy) + sender byteLength | 2026-09-23 | 3.07× speedup measured at 31.64 MB |

**Coverage:** 15/15 examples tagged `[perf-tested]` (with measurable metric). 0 `[correctness]`, 0 `[api-surface]`.

## Re-tagging history

| Date | File | Old tag | New tag | Reason |
| --- | --- | --- | --- | --- |
| 2026-09-24 | `adaptive-concurrency.js` | `[correctness]` | `[perf-tested]` | Added Part 2 (load burst) — adaptive grew 1→28, fixed stuck at 1 (23× speedup) |
| 2026-09-24 | `broadcast-cache-invalidation.js` | `[correctness]` | `[perf-tested]` | Added cold/warm timing + cumulative saving (2.69× per hit, 25 ms saved) |
| 2026-09-24 | `cancel-on-disconnect.js` | `[correctness]` | `[perf-tested]` | Added cancel-vs-run-to-completion timing (~9800 ms worker time saved) |
| 2026-09-24 | `event-target-pattern.js` | `[api-surface]` | `[perf-tested]` | Added Part 2 (cleanup API surface, 1 vs 10 calls) |
| 2026-09-24 | `image-resizer-batch.js` | `[correctness]` | `[perf-tested]` | Added EL responsiveness metric (27× more ticks) |
| 2026-09-24 | `worker-recycling.js` | `[api-surface]` | `[perf-tested]` | Added per-cycle overhead (263 ms avg/ciclo) + event-driven wait |
| 2026-09-23 | `priority-routing.js` | `[correctness]` | `[perf-tested]` | Added vs-no-priority baseline + 50 ms slow batch tasks |
| 2026-09-23 | `express-outbox-email.js` | `[correctness]` | `[perf-tested]` | Added vs-sequential baseline (76× speedup) |
| 2026-09-23 | `persistent-ai-model.js` | `[correctness]` | `[perf-tested]` | Added vs-ephemeral baseline (1.48× speedup) |
| 2026-09-23 | `zero-copy-image.js` | `[correctness]` | `[perf-tested]` | Added vs-copy baseline (3.07× speedup) |

## Verification commands

```bash
# Confirm 15 examples exist
ls examples/*.js | wc -l

# Confirm each has a header tag in the first JSDoc line
for f in examples/*.js; do
  head -2 "$f" | grep -oE '\[(perf-tested|correctness|api-surface)\]' || echo "MISSING: $f"
done

# Confirm all run successfully
for f in examples/*.js; do
  node "$f" > /dev/null 2>&1 || echo "FAILED: $f"
done
```

Expected: 15 lines, 15 tag matches, 0 failures.
