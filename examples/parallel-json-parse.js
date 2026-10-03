/**
 * [perf-tested] Example: parallel JSON parsing of a ~1 GB file.
 *
 * This is the real CPU-bound workload the library exists for, and it turns
 * out to have a hard constraint that dictates the whole architecture.
 *
 * â”€â”€ The constraint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * V8 refuses to create a JS string longer than 0x1fffffe8 chars (~512 MB):
 *
 *   > RangeError: Cannot create a string longer than 0x1fffffe8 characters
 *
 * So `JSON.parse(readFileSync(file, 'utf8'))` on a 1 GB file does not get
 * slow — it *fails*. Any correct design for a file this size MUST read byte
 * ranges and parse them as separate JSON documents. This example demonstrates
 * that failure first, so the rest of the design is justified rather than
 * assumed.
 *
 * â”€â”€ The second constraint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Returning the parsed data to the main thread is more expensive than parsing
 * it. Structured clone of a dense object graph costs roughly 7–20 ms per MB
 * (vs ~0.7 ms/MB for a flat Float32Array) — per-node bookkeeping, not bytes.
 * For 1 GB of parsed objects that is seconds of pure copying, paid on BOTH
 * sides, and it happens on the main thread.
 *
 * Hence the two worker shapes compared below:
 *   SUMMARY-ONLY — each worker parses its range and returns counts/sums.
 *                  Almost nothing crosses the thread boundary.
 *   RETURN-ALL   — each worker returns its fully parsed array back.
 *                  The realistic-looking choice, and the slow one.
 *
 * â”€â”€ Why chunks split at record boundaries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Splitting JSON at an arbitrary byte offset yields two invalid documents. The
 * generator therefore writes one record per line inside the top-level array
 * (valid JSON — whitespace between array elements is legal), so a chunk
 * boundary can always land on a line start. The index below finds those
 * offsets by scanning; for a file you did not generate you would run the same
 * scan.
 *
 * â”€â”€ What it measures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * For 1 / 2 / 4 workers: wall time, throughput (MB/s), speedup vs. 1 worker,
 * and peak RSS. The interesting numbers are the speedup curve (how close to
 * linear it gets) and the SUMMARY-ONLY vs RETURN-ALL gap.
 *
 * Run: `node examples/parallel-json-parse.js`
 * Env:   PWR_JSON_MB=1024   target size in MB (default 1024)
 *        PWR_JSON_KEEP=1    keep the generated file instead of deleting it
 *
 * NOTE: `fn` is re-evaluated inside the worker isolate
 * (src/worker-thread-entry.js builds it with `new Function`), so a task fn
 * cannot close over module-scope values — everything arrives via `payload`,
 * and node builtins are pulled with `await import(...)`.
 */

import { once } from 'node:events';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';
import { cpus, freemem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerRuntime } from '../src/index.js';

// === Configuration ===

const TARGET_MB = Number(process.env.PWR_JSON_MB ?? 1024);
const WORKER_LADDER = [1, 2, 4]; // never more than 4 by default
/** Hard cap: V8 refuses a string over 0x1fffffe8 chars (~512 MB). Stay well under. */
const MAX_CHUNK_MB = 400;
const SCAN_CHUNK = 1 << 20; // 1 MB while indexing

/**
 * How many slices the file must be cut into.
 *
 * This is driven by FILE SIZE, not by worker count — the string limit applies
 * to a single slice no matter how many workers exist. A 10 GB file therefore
 * needs at least 25 slices even with one worker; 1 worker × 8 fixed chunks
 * would produce 1.25 GB slices and die in `Buffer.toString`.
 *
 * Chunk count is always a multiple of the worker count so the slices spread
 * evenly across the pool.
 */
function chunkCountFor(sizeBytes, workerCount) {
  const needed = Math.ceil(sizeBytes / (MAX_CHUNK_MB * 1024 * 1024));
  return Math.max(workerCount, Math.ceil(needed / workerCount) * workerCount);
}

// === File generation ===

/** One realistic-ish record. Flat-ish, mixed types — like an API payload. */
function makeRecord(i) {
  return JSON.stringify({
    id: i,
    sku: `SKU-${(i % 99999).toString().padStart(5, '0')}`,
    name: `Product ${i} — widget ${i % 997}`,
    price: Math.round((i % 10000) / 100) / 100,
    inStock: i % 3 !== 0,
    tags: [`t${i % 17}`, `t${i % 31}`, `t${i % 7}`],
    dims: { w: i % 500, h: i % 400, d: i % 200 },
    updatedAt: new Date(1700000000000 + i * 1000).toISOString(),
    note: `record ${i} with a moderately long free-text note to pad the record out to a realistic size`,
  });
}

/**
 * Write a JSON array to disk without ever holding it in memory.
 * One record per line, so chunk boundaries can land on line starts.
 */
async function generate(path, targetMb) {
  const out = createWriteStream(path);
  const target = targetMb * 1024 * 1024;
  let written = 2; // '[' + '\n'
  let i = 0;

  out.write('[\n');
  while (written < target) {
    const line = (i === 0 ? '' : ',\n') + makeRecord(i);
    if (!out.write(line)) await once(out, 'drain');
    written += Buffer.byteLength(line);
    i++;
  }
  out.write('\n]\n');
  out.end();
  await once(out, 'finish');
  const { size } = await stat(path);
  return { records: i, bytes: size };
}

/**
 * Scan the file once to find line-start offsets — the only safe places to
 * split. Returns byte offsets of each record's opening `{`.
 *
 * The generated file looks like:
 *
 *     [\n{rec0},\n{rec1},\n...\n{recN}\n]\n
 *
 * A record therefore starts at the first `{` that follows a newline. The final
 * newline (before `]`) has no `{` after it, so it contributes no offset — which
 * is what keeps the array terminator from being handed to a worker.
 */
async function indexBoundaries(path) {
  const offsets = [];
  const stream = createReadStream(path, { highWaterMark: SCAN_CHUNK });
  let filePos = 0;
  let afterNewline = true;

  for await (const buf of stream) {
    for (let k = 0; k < buf.length; k++) {
      const byte = buf[k];
      if (byte === 0x0a) {
        afterNewline = true;
      } else if (afterNewline && byte === 0x7b /* { */) {
        offsets.push(filePos + k);
        afterNewline = false;
      }
    }
    filePos += buf.length;
  }
  return offsets;
}

/**
 * Byte offset of the array's closing `]`, found by scanning the tail.
 *
 * The generated trailer is `"}\n]\n"`. The closing bracket is the last
 * non-whitespace byte in the file, so scan backwards and skip `\n`/`\r`/space
 * until we hit `]`. (Scanning for the first `]` backwards can land on a `]`
 * inside a record's string value.)
 */
async function findArrayClose(path, sizeBytes) {
  const fh = await open(path, 'r');
  try {
    const tailLen = Math.min(256, sizeBytes);
    const buf = Buffer.alloc(tailLen);
    await fh.read(buf, 0, tailLen, sizeBytes - tailLen);
    for (let i = buf.length - 1; i >= 0; i--) {
      const b = buf[i];
      if (b === 0x0a || b === 0x0d || b === 0x20 || b === 0x09) continue;
      if (b === 0x5d) return sizeBytes - tailLen + i;
      throw new Error(`unexpected trailing byte 0x${b.toString(16)}, expected ']'`);
    }
    throw new Error('could not locate closing ] in generated file');
  } finally {
    await fh.close();
  }
}

/**
 * Pick ~`nChunks` roughly even split points from the boundary index.
 *
 * IMPORTANT: a chunk must stay under the V8 string limit (~512 MB) even when
 * there is only ONE worker. `Buffer.concat(chunks).toString('utf8')` inside the
 * worker hits `ERR_STRING_TOO_LONG` on a 10 GB slice, so chunking is a
 * correctness requirement dictated by the string limit, not a way to spread
 * work. nChunks here is therefore `workers × CHUNKS_PER_WORKER`, chosen so
 * each slice is roughly TARGET_MB / nChunks.
 */
function pickSplits(offsets, nChunks) {
  if (nChunks <= 1) return [];
  const per = Math.floor(offsets.length / nChunks);
  const splits = [];
  for (let c = 1; c < nChunks; c++) splits.push(offsets[c * per]);
  return splits;
}

/**
 * Rough in-heap cost of holding the whole parsed dataset at once.
 *
 * A JSON record's parsed object graph is typically 2-5x its text size, and
 * `RETURN-ALL` additionally structured-clones it across the thread boundary,
 * so peak is roughly 2x the graph on each side. For a 10 GB file that is
 * 40-100 GB of live objects — more than any machine here has. Rather than
 * OOM-crashing the process, the example refuses the case and says why.
 */
function estimateReturnAllFeasible(sizeBytes) {
  const textMb = sizeBytes / 1024 / 1024;
  const highGraphMb = textMb * 5;
  const freeMb = freemem() / 1024 / 1024;
  // Even the optimistic end must fit well inside free RAM, leaving room for
  // V8 overhead, the string itself, and the rest of the process.
  const neededMb = highGraphMb * 2;
  return { feasible: neededMb < freeMb * 0.5, neededMb, freeMb, textMb };
}

// === Worker task fn (self-contained: re-evaluated in the worker isolate) ===

function parseRange(payload) {
  const { start, end, filePath, returnAll } = payload;
  return import('node:fs').then((fs) => {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const s = fs.createReadStream(filePath, { start, end: end - 1 });
      s.on('data', (c) => chunks.push(c));
      s.on('error', reject);
      s.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf8');
        // Normalise the slice into a bare record run. A record is written as
        // "{...},\n", so a chunk boundary that lands on the NEXT record's '{'
        // leaves a trailing "," on the previous chunk — and `JSON.parse`
        // rejects "Unexpected token ']'". Stripping leading/trailing
        // separators here is far more robust than trying to make the byte
        // arithmetic in the splitter land on a "clean" byte.
        text = text
          .replace(/^[\r\n]+/, '')
          .replace(/[\r\n]+$/, '')
          .replace(/,$/, '');
        const t0 = performance.now();
        const arr = JSON.parse(`[${text}]`);
        const parseMs = performance.now() - t0;
        let total = 0;
        for (const r of arr) total += r.price;
        const summary = {
          count: arr.length,
          total,
          parseMs,
          bytes: end - start,
        };
        resolve(returnAll ? { ...summary, data: arr } : summary);
      });
    });
  });
}

// === Scenarios ===

function peakRssMb() {
  return process.memoryUsage().rss / 1024 / 1024;
}

async function runWithWorkers(workerCount, filePath, sizeBytes, boundaries, arrayClose, returnAll) {
  // A slice must stay under the V8 string limit regardless of worker count, so
  // the chunk count comes from the file size, not from the pool size.
  const nChunks = chunkCountFor(sizeBytes, workerCount);
  const splits = pickSplits(boundaries, nChunks);
  const edges = [0, ...splits, sizeBytes];

  const ranges = [];
  for (let i = 0; i < edges.length - 1; i++) {
    // Every chunk starts at a record's opening '{'. The first one skips the
    // file's "[\n" opener.
    const start = i === 0 ? edges[0] + 2 : edges[i];
    // Every chunk ends where the next one begins, minus the separator. A
    // record is written as "{...},\n", so a chunk that ends at the NEXT
    // record's '{' would capture the trailing "," and fail JSON.parse. The
    // last chunk instead stops at the file's closing ']'.
    const end = i === edges.length - 2 ? arrayClose : edges[i + 1] - 1;
    ranges.push({ start, end });
  }

  const runtime = await createWorkerRuntime({ workers: workerCount, concurrency: 'fixed' });
  const before = peakRssMb();
  const t0 = performance.now();
  try {
    const results = await Promise.all(
      ranges.map((r) =>
        runtime.execute({
          type: 'json-chunk',
          payload: { ...r, filePath, returnAll },
          fn: parseRange,
          // HARDEN-01 defaults timeoutMs to 5000 ms, which a multi-GB chunk
          // blows through immediately (10 GB / 4 workers = 2.5 GB each). Pass
          // 0 explicitly to opt out of preemption - this is a bounded batch
          // job, not a request that should be killed mid-parse.
          timeoutMs: 0,
        }),
      ),
    );
    const wallMs = performance.now() - t0;
    const records = results.reduce((n, r) => n + r.count, 0);
    const cpuMs = results.reduce((n, r) => n + r.parseMs, 0);
    return {
      workerCount,
      chunks: ranges.length,
      wallMs,
      cpuMs,
      records,
      mbps: sizeBytes / 1024 / 1024 / (wallMs / 1000),
      rssDeltaMb: peakRssMb() - before,
    };
  } finally {
    await runtime.shutdown();
  }
}

/**
 * The V8 string limit, reported without allocating one.
 *
 * An earlier version actually tried to build the string, which OOM-crashed the
 * process (exit 134) before the benchmark even started — the heap died trying
 * to hold the very buffer we were only trying to prove too large. The limit is
 * a compile-time constant of the engine, so asserting on it is the honest
 * way to report it; the empirical proof is that a single-chunk parse of a
 * >512 MB file fails, which is what scenario [1] below relies on.
 */
const V8_MAX_STRING_CHARS = 0x1fffffe8; // 536 870 888 → ~512 MB

// === Main ===

async function main() {
  const dir = join(tmpdir(), 'pwr-json-parse');
  const file = join(dir, 'big.json');
  await fsp.mkdir(dir, { recursive: true });

  console.log('=====================================================================');
  console.log('BENCHMARK: parallel JSON parse of a ~1 GB file');
  console.log('=====================================================================\n');
  console.log(`  Host cores : ${cpus().length}`);
  console.log(`  Target     : ${TARGET_MB} MB`);
  console.log(`  Workers    : ${WORKER_LADDER.join(' / ')} (capped at 4)\n`);

  console.log('  [0] V8 string limit — the constraint that forces chunking ...');
  console.log(
    `      Cannot create a string longer than 0x1fffffe8 characters ` +
      `(~${(V8_MAX_STRING_CHARS / 1024 / 1024).toFixed(0)} MB).`,
  );
  console.log('      => readFileSync(file,"utf8") + JSON.parse CANNOT handle a file this size.\n');

  console.log('  [1] generating the file (streamed, never held in memory) ...');
  const genT0 = performance.now();
  const { records, bytes } = await generate(file, TARGET_MB);
  const genMs = performance.now() - genT0;
  console.log(
    `      ${(bytes / 1024 / 1024).toFixed(1)} MB, ${records.toLocaleString()} records, ` +
      `${(genMs / 1000).toFixed(1)}s\n`,
  );

  console.log('  [2] indexing record boundaries (safe split points) ...');
  const idxT0 = performance.now();
  const boundaries = await indexBoundaries(file);
  const { size: actualSize } = await stat(file);
  const arrayClose = await findArrayClose(file, actualSize);
  console.log(
    `      ${boundaries.length.toLocaleString()} boundaries in ` +
      `${((performance.now() - idxT0) / 1000).toFixed(1)}s; ` +
      `file ${actualSize.toLocaleString()} B, ']' at ${arrayClose.toLocaleString()}`,
  );
  if (arrayClose >= actualSize) {
    throw new Error(`arrayClose ${arrayClose} out of range for ${actualSize} byte file`);
  }
  console.log('');

  console.log('  [3] SUMMARY-ONLY workers (return counts, not data) ...');
  const summary = [];
  for (const w of WORKER_LADDER) {
    const r = await runWithWorkers(w, file, bytes, boundaries, arrayClose, false);
    summary.push(r);
    console.log(
      `      workers=${w}  wall ${(r.wallMs / 1000).toFixed(2)}s  ` +
        `${r.mbps.toFixed(0)} MB/s  ${r.records.toLocaleString()} recs`,
    );
  }
  console.log('');

  console.log('  [4] RETURN-ALL workers (return the parsed array to the main thread) ...');
  const all = [];
  const feas = estimateReturnAllFeasible(bytes);
  if (!feas.feasible) {
    console.log(
      `      SKIPPED — would need ~${(feas.neededMb / 1024).toFixed(0)} GB of live objects ` +
        `(${feas.textMb.toFixed(0)} MB text × 2-5× graph × 2 for the clone), ` +
        `but only ${(feas.freeMb / 1024).toFixed(1)} GB of RAM is free.`,
    );
    console.log('      This is the point, not a limitation: at this size you MUST reduce in the');
    console.log('      worker, because the data physically cannot be returned.\n');
  } else {
    for (const w of WORKER_LADDER) {
      const r = await runWithWorkers(w, file, bytes, boundaries, arrayClose, true);
      all.push(r);
      console.log(
        `      workers=${w}  wall ${(r.wallMs / 1000).toFixed(2)}s  ` +
          `${r.mbps.toFixed(0)} MB/s  ${r.records.toLocaleString()} recs`,
      );
    }
  }
  console.log('');

  // === Report ===
  const baseSummary = summary[0];
  const baseAll = all[0];
  console.log('=====================================================================');
  console.log('=== Results ===\n');
  console.log('  SUMMARY-ONLY (worker returns counts/sums, not the data):');
  console.table(
    Object.fromEntries(
      summary.map((r) => [
        `${r.workerCount} worker(s)`,
        {
          'wall (s)': (r.wallMs / 1000).toFixed(2),
          'MB/s': r.mbps.toFixed(0),
          speedup: `${(baseSummary.wallMs / r.wallMs).toFixed(2)}×`,
          'CPU ms': r.cpuMs.toFixed(0),
        },
      ]),
    ),
  );
  if (all.length > 0) {
    console.log('  RETURN-ALL (worker returns the full parsed array):');
    console.table(
      Object.fromEntries(
        all.map((r) => [
          `${r.workerCount} worker(s)`,
          {
            'wall (s)': (r.wallMs / 1000).toFixed(2),
            'MB/s': r.mbps.toFixed(0),
            speedup: `${(baseAll.wallMs / r.wallMs).toFixed(2)}×`,
            'CPU ms': r.cpuMs.toFixed(0),
          },
        ]),
      ),
    );
  } else {
    console.log('  RETURN-ALL: skipped (insufficient RAM — see the note above).');
  }

  const bestSummary = summary[summary.length - 1];
  console.log('');
  console.log(
    `  V8 string limit          : ${(V8_MAX_STRING_CHARS / 1024 / 1024).toFixed(0)} MB (hard)`,
  );
  console.log(
    `  Parse speedup 1→${bestSummary.workerCount}       : ` +
      `${(baseSummary.wallMs / bestSummary.wallMs).toFixed(2)}×`,
  );
  if (all.length > 0) {
    const bestAll = all[all.length - 1];
    const taxFactor = bestAll.wallMs / bestSummary.wallMs;
    console.log(
      `  Transfer tax (RETURN-ALL) : ${taxFactor.toFixed(2)}× slower than SUMMARY-ONLY ` +
        `at the same worker count`,
    );
  }
  console.log('');

  // ── How to read the speedup number ─────────────────────────────────────────
  // A sub-linear speedup here is NOT a limitation of the worker pool.
  // research/parse-parallelism-probe.benchmark.js shows JSON.parse itself
  // parallelises near-linearly (6.6× on 8 workers, in memory, no disk). The
  // ceiling on a large cold file is the disk: the same probe shows the
  // non-parse share of wall time climbing from ~12% at 2 workers to ~33% at 8.
  // More workers interleave more read streams, which queues worse on one device.
  //
  // So: do NOT tune the worker count against a cold multi-GB file. Prefer fewer
  // larger sequential reads, warm the page cache or use a faster device, and add
  // workers only after. See .agents/research/large-json-parsing.md.
  console.log('  Reading the speedup column:');
  console.log('    A sub-linear number on a large COLD file is the disk, not the pool.');
  console.log('    Parse alone scales ~6.6× on 8 workers; the gap is I/O queueing.');
  console.log('    Warm the page cache (or use NDJSON — see the strategy benchmark)');
  console.log('    before concluding the pool is underperforming.');

  const keep = process.env.PWR_JSON_KEEP === '1';
  if (!keep) {
    await unlink(file).catch(() => undefined /* best-effort cleanup */);
  } else {
    console.log(`  File kept at: ${file}`);
  }
  await fsp
    .rm(dir, { recursive: true, force: true })
    .catch(() => undefined /* best-effort cleanup */);
  console.log('\n--- parallel JSON parse example complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
