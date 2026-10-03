# Research — usage-pattern investigations

**These scripts are NOT library benchmarks and are NOT part of `npm run benchmark:all`.**

They answer *application-architecture* questions: given a workload, which way should an
application use this library? Their results are documented conclusions, and the value of
keeping the scripts is that those conclusions stay **reproducible** on a different machine
or after the runtime changes.

## Why they live here and not in `benchmarks/`

| | `benchmarks/` | `research/` |
| --- | --- | --- |
| Measures | behaviour of `src/` | how an *application* should use the library |
| Purpose | regression gate — a PR that breaks perf fails CI | evidence behind a documented recommendation |
| Runtime | seconds | 7–20 minutes |
| Disk | no fixtures | generates 4–8 GB of temp files |
| Consumer runs it? | yes, via CI | no — the conclusion is the deliverable |

A consumer who installs `persistent-worker-runtime` never runs anything in this directory.
Keeping these next to the CI gates would imply they are part of the library's performance
contract, which they are not.

## Running them

```bash
# The strategy comparison. Default 10 GB; PWR_SKIP_LARGE does a fast 512 MB pass.
node research/json-strategy-compare.benchmark.js
PWR_SKIP_LARGE=1 node research/json-strategy-compare.benchmark.js

# The parallelism probe. PWR_SKIP_SWEEP=1 runs only the I/O section.
node research/parse-parallelism-probe.benchmark.js
PWR_SKIP_SWEEP=1 node research/parse-parallelism-probe.benchmark.js
```

Both need free disk roughly 2× the target size (two fixture files).

## What they concluded

See [`large-json-parsing.md`](../.agents/research/large-json-parsing.md) for the full write-up
with the numbers behind each claim. The short version, on a 28-core host with a cold SATA SSD:

- `JSON.parse` parallelises **near-linearly** (6.6× on 8 workers) — the parser is not the
  bottleneck.
- A large **cold** file is **disk-bound**: the non-parse share of wall time climbs from ~12%
  at 2 workers to ~33% at 8, which is what flattens the curve.
- Peak RSS scales **linearly with worker count** (2.30 → 4.14 → 7.42 GB at 1/2/4 workers on a
  4 GB file), because each worker holds its own slice plus its own parsed graph.
- NDJSON streaming beats single-worker chunk-parallel on **both** axes, and costs 2.1× the wall
  time of 4-worker chunk-parallel in exchange for ~22× less RAM.
- So the choice is a straight trade, computable: chunk-parallel needs ~1.9× the file size in
  free RAM.

### Read the "× file size" column only on files ≥ 1 GB

Peak RSS includes Node's own baseline (~0.7-0.8 GB on this host). At 128 MB the reported ratio is
~6.5× for every variant, which is just the baseline dominating — it says nothing about the
architecture. The ratio only becomes a meaningful cost signal once the file is large enough that
the working set exceeds the baseline, which is why the conclusions above are quoted from the 4 GB
run. Use `PWR_SKIP_LARGE=1` for a fast smoke test of the harness, not to read the memory ratio.

## Adding to this directory

If a script here answers a question about *using* the library rather than about the library
itself, it belongs here. If it measures `src/` and should fail CI on regression, it belongs in
`benchmarks/` and needs an entry in `package.json`'s `benchmark:all`.
