# Large JSON parsing with worker_threads — design notes (2026-10-02)

**Context.** Built `examples/parallel-json-parse.js` for this repo after researching how large
JSON is actually handled. Findings below are the non-obvious ones.

## 1. V8 will not let you hold a >512 MB JSON string

```
> RangeError: Cannot create a string longer than 0x1fffffe8 characters
```

`0x1fffffe8` = 536 870 888 chars ≈ **512 MB**. So `JSON.parse(readFileSync(file, 'utf8'))` on a
1–10 GB file does not get slow — it **fails**.

**The limit is `Buffer.toString()`, not `JSON.parse`.** This is the part that is easy to get
wrong. In the 10 GB run the failure surfaced as:

```
Error [ERR_STRING_TOO_LONG]: Cannot create a string longer than 0x1fffffe8 characters
  at Buffer.toString (node:buffer:937:14)
```

inside the worker, while converting the concatenated chunk to UTF-8 — *before* `JSON.parse` was
ever reached. So:

- Chunking is **mandatory even with a single worker**. It is not a way to spread work.
- **Chunk count must be derived from file size, not from worker count.** This is the mistake
  that cost the most iterations: a first attempt used `chunks = workers × CHUNKS_PER_WORKER` with
  a fixed 8, which is fine at 512 MB (1 worker → 64 MB slices) and fatal at 10 GB (1 worker →
  1.25 GB slices, `ERR_STRING_TOO_LONG` again). The correct form is:

  ```js
  const MAX_CHUNK_MB = 400;                      // under the ~512 MB string limit
  function chunkCountFor(sizeBytes, workerCount) {
    const needed = Math.ceil(sizeBytes / (MAX_CHUNK_MB * 1024 * 1024));
    // round up to a multiple of workerCount so slices spread evenly over the pool
    return Math.max(workerCount, Math.ceil(needed / workerCount) * workerCount);
  }
  ```

  10 GB / 400 MB = 25 slices minimum; with 4 workers that rounds to 28 (~366 MB each), with 1
  worker to 25 (~411 MB each). Both fit.
- Peak memory is governed by **chunk size**, and chunk size by the string limit — *not* by the
  number of workers. Adding workers does not let you make slices bigger.

## 1b. Reading a slice without loading the whole slice

`fs.createReadStream(path, { start, end })` is a Web/Node stream and only materialises the slice.
Its `end` is **inclusive**, and it still accumulates the entire slice in memory before
`toString` — so the slice itself must stay under the string limit. A 32-chunk fan-out over 10 GB
peaks at ~320 MB per worker, which is fine; a 1-chunk fan-out peaks at 10 GB and dies.

Peak memory is therefore governed by **chunk size**, and chunk size by the string limit, not by
the number of workers.

## 2. The parsed object graph is 2–5× the text size, and the clone doubles it

A record's parsed representation is typically 2–5× its JSON text. `RETURN-ALL` additionally
structured-clones the graph across the thread boundary, so peak is roughly **2× the graph on each
side**. For 10 GB text that is 40–100 GB of live objects.

The example now *refuses* the `RETURN-ALL` case when `freemem()` cannot cover it, instead of
OOM-crashing. That refusal is the finding, not a limitation.

## 3. Returning summaries instead of data is worth ~4× (measured)

128 MB file, 4 workers:

| shape | wall | MB/s | speedup vs 1 |
| --- | --- | --- | --- |
| SUMMARY-ONLY (counts/sums) | 0.49 s | 259 | 3.25× |
| RETURN-ALL (full arrays) | 1.95 s | 66 | 1.88× |

**3.95× tax** purely for moving data that the consumer did not need in full. If you only need
counts, sums, or filtered records, do the reduction *inside* the worker.

## 4. The 10 GB slowdown is I/O, not CPU — and the CPU never was the problem

At 10 GB the example reported 1.97× on 4 workers, and *total parse CPU rose* from 75 s to 94 s.
That looks like a CPU ceiling, so the obvious suspects were memory bandwidth (H2) and GC
interference between isolates (H3). **Both are wrong.** See
`benchmarks/parse-parallelism-probe.benchmark.js`.

### The harness lied first

The first version of the probe reported `base / slowest` as "effective" and printed:

```
chunk 120 MB × 4 worker(s): base 774 ms → slowest 896 ms  effective 0.86×
=> H2/H3 CONFIRMED: running parses concurrently makes each one measurably SLOWER
```

0.86× means "four concurrent parses finish slower than one alone" — which cannot be true of a
throughput comparison and pointed straight at a nonexistent bandwidth wall. The metric was
per-parse *slowdown*, not speedup. The correct form is:

```js
speedup = (workerCount * baseMs) / slowestMs
```

Re-derived from the same data:

| chunk | 2 workers | 4 workers | 6 workers | 8 workers |
| --- | --- | --- | --- | --- |
| 24 MB | 1.85× | 3.74× | — | 6.11× |
| 60 MB | 2.05× | 3.85× | — | 6.26× |
| 120 MB | 1.87× | 3.46× | 5.29× | 6.14× |
| 240 MB | 1.89× | 3.76× | 4.82× | 6.19× |

**`JSON.parse` parallelises near-linearly: 6.64× on 8 workers**, and chunk size is irrelevant
(sensitivity 0.084 across a 10× size range). H2 and H3 are refuted.

### What the probe actually shows

Same file, read-backed instead of memory-backed, splitting wall time into parse vs everything
else:

| workers | wall | parse/worker | not-parse | I/O share |
| --- | --- | --- | --- | --- |
| 1 | 0.73 s | — | — | ~6% |
| 2 | 0.71 s | 0.62 s | 0.09 s | 12% |
| 4 | 0.45 s | 0.36 s | 0.10 s | 21% |
| 8 | 0.32 s | 0.21 s | 0.11 s | 34% |

Parse time falls roughly linearly with worker count. The **non-parse share climbs from ~6% to
~34%** as workers are added — that is the disk queueing, and it is what flattens the curve on a
10 GB cold file. The total-CPU rise in the original 10 GB run is the same phenomenon seen from the
other side: more workers spend proportionally more of their time blocked in the I/O path, so the
"CPU ms" summed across workers is no longer a clean measure of parse work.

### The conclusion that matters

**Do not tune worker count against a cold multi-GB file.** You will optimise for the disk, not the
CPU, and read a disappointing number that says nothing about the parser. The knobs that actually
move it:

1. **Fewer, larger sequential reads.** The queue depth is the bottleneck, not the parser. A single
   sequential reader on this machine sustains far more MB/s than four interleaved readers.
2. **Warm the page cache** when the file fits in RAM, or place it on a faster device. The
   difference between the warm 512 MB run (3.46×) and the cold 10 GB run (1.97×) is almost entirely
   this.
3. **Only then add workers**, and re-measure both `wall` and `CPU ms`.

If the file does not fit in RAM, the honest architecture is not "N workers parsing chunks" but
**NDJSON + a streaming pipeline**, which keeps a sequential read pattern and O(1) memory instead of
materialising 2–5× the file size as objects.

## 4b. …but the NDJSON recommendation is WRONG (measured, refuted)

The sentence above was a claim inherited from prior reading and never tested here.
`benchmarks/json-strategy-compare.benchmark.js` runs the SAME records — both files are generated
from one record stream, so they hold byte-identical record content — through three shapes. At
4 GB (14 277 885 records, every variant cross-checked on both count and `sum(price)`):

| variant | wall | MB/s | peak heap |
| --- | --- | --- | --- |
| A chunk-parallel ×1 | 43.2 s | 95 | — |
| A chunk-parallel ×2 | 25.6 s | 160 | — |
| **A chunk-parallel ×4** | **18.0 s** | **227** | — |
| C NDJSON streaming | 36.6 s | 111 | 229 MB |

**NDJSON streaming is 2.03× SLOWER than 4-way chunk-parallel** at 4 GB, and was 2.94× slower at
512 MB. The gap narrows as the file grows (per-record overhead amortises against fewer, larger
`JSON.parse` calls plus amortised I/O), but chunk-parallel wins at every size tested.

Why the folklore is wrong: `readline` yields one line at a time, and each line costs a
`JSON.parse` call plus a stream event. At 14 M records that per-record overhead is large.
NDJSON's genuine win is **memory** — 229 MB peak versus a chunk-parallel run that must hold a
~400 MB slice plus its parsed graph — not speed. It is the right answer when RAM is the binding
constraint, and the wrong answer when you have memory to spare.

Also note that "parse the whole file in one `JSON.parse`" is not an available option above
~512 MB. That is exactly the limit variant A exists to work around.

## 4b. The 5-second default task timeout is shorter than a large chunk

HARDEN-01 defaults `timeoutMs` to **5000 ms**. A 10 GB file split 4 ways gives 2.5 GB chunks,
which take ~30 s to read and parse — the watchdog preempts them:

```
TaskTimeoutError: Task task_..._1 exceeded execution timeout of 5000ms
```

Batch jobs must pass `timeoutMs: 0` explicitly. The default protects request handlers, which is
right, but a bulk parse is not a request. Note this is a *silent* correctness trap: the same
example at 512 MB failed with the default and passed with `timeoutMs: 0`.

## 5. Two bugs that cost the most time — both are boundary arithmetic

**a. `createReadStream`'s `end` is INCLUSIVE.** A chunk that should end at byte 25782 must pass
`end: 25781`, and the last chunk must stop before the file's `]`. An earlier version passed the
split offset straight through and handed the array terminator to a worker.

**b. The trailing comma is the real trap.** Records are written `{...},\n`. A chunk that ends at
the *next* record's `{` includes the separating `,`, so `JSON.parse('[...},]')` fails with
`Unexpected token ']'`. Fix by normalising the slice, not by fixing the arithmetic:

```js
text = text
  .replace(/^[\r\n]+/, '')
  .replace(/[\r\n]+$/, '')
  .replace(/,$/, '');   // ← this is the one that actually mattered
```

## 6. Never split JSON at an arbitrary byte offset

Both halves become invalid documents. The generator therefore writes one record per line inside
the top-level array (valid JSON — whitespace between array elements is legal), and a scan pass
records the byte offset of each `{` that follows a newline. For a file you did not generate you
would run the same scan; it costs ~0.3 s per 128 MB, i.e. under 1% of a 10 GB parse.

## Apply when

- Any payload above ~100 MB where `JSON.parse` shows up in a CPU profile.
- Deciding between "stream it" and "parallelise it". For files you control, **NDJSON + worker
  pool** beats both: O(1) memory per record and trivially chunkable.
- Reviewing any code that slices a file into chunks and re-parses each slice.
