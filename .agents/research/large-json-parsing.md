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

## 4. Scaling is near-linear to 4 workers on small files, disk-bound on large ones

512 MB file (disk cache warm):

| workers | wall | speedup |
| --- | --- | --- |
| 1 | 6.38 s | 1.00× |
| 2 | 3.21 s | 1.99× |
| 4 | 1.84 s | 3.46× |

**10 GB file (cold, 28-core host, 35 296 907 records):**

| workers | chunks | wall | MB/s | speedup |
| --- | --- | --- | --- | --- |
| 1 | 25 | 127.7 s | 80 | 1.00× |
| 2 | 26 | 75.4 s | 136 | 1.69× |
| 4 | 28 | 64.9 s | 158 | 1.97× |

The 10 GB run scales **1.97×, not 3.5×**. The difference is I/O: 10 GB does not fit in page cache,
so the workers spend their time waiting on the disk. Note `CPU ms` *rises* with worker count
(75 s → 94 s) — the machine is doing more total CPU work, not less, because four threads
interleave four independent read streams and thrash the device.

**Practical reading:** parallelism wins big when the data is cached or the parse dominates; on a
cold multi-GB file you are partly parallelising the disk, not the CPU, and the ceiling is the
device. Measure both — `wall` and `CPU ms` — before concluding a worker count is helping.

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
