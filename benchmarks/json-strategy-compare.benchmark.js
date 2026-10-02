/**
 * [perf-tested] Three ways to get 10 GB of JSON records into memory.
 *
 * Follow-up to examples/parallel-json-parse.js. That example measured 1.97× on
 * 4 workers at 10 GB, and benchmarks/parse-parallelism-probe.benchmark.js
 * established WHY: JSON.parse itself parallelises near-linearly (6.6× on 8
 * workers), but the non-parse share of wall time climbs from ~12% to ~33% as
 * workers are added, because four interleaved read streams queue badly on one
 * device.
 *
 * That left the recommendation untested. This benchmark closes the loop by
 * running the SAME logical dataset (identical records, identical bytes) through
 * three architectures:
 *
 *   A. CHUNK-PARALLEL  — index record boundaries, dispatch N byte ranges across a
 *                        worker pool, JSON.parse each slice. O(file) memory.
 *   B. SEQUENTIAL     — one worker, one contiguous read, JSON.parse the whole
 *                        array. Tests whether the disk prefers fewer streams.
 *   C. NDJSON STREAM  — one object per line, readline + JSON.parse per line.
 *                        O(1) memory, no slicing, no boundary index.
 *
 * The dataset is written twice (array form and NDJSON form) from the same record
 * generator, so A/B read byte-identical record content to C. Anything that
 * differs is architecture, not data.
 *
 * Run: `node benchmarks/json-strategy-compare.benchmark.js`
 * Env: PWR_JSON_MB=10240   target size per file (default 10240)
 *      PWR_SKIP_LARGE=1    run a fast 512 MB comparison instead
 */

import { once } from 'node:events';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { rm, stat, unlink } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { createWorkerRuntime } from '../src/index.js';

const TARGET_MB = Number(process.env.PWR_JSON_MB ?? 10240);
const FAST = process.env.PWR_SKIP_LARGE === '1';
const EFFECTIVE_MB = FAST ? 512 : TARGET_MB;
const MAX_CHUNK_MB = 400; // under the ~512 MB V8 string limit
const WORKER_LADDER = [1, 2, 4];
const SCAN_CHUNK = 1 << 20;

function makeRecord(i) {
  return JSON.stringify({
    id: i,
    sku: `SKU-${(i % 99999).toString().padStart(5, '0')}`,
    name: `Product ${i} - widget ${i % 997}`,
    price: Math.round((i % 10000) / 100) / 100,
    inStock: i % 3 !== 0,
    tags: [`t${i % 17}`, `t${i % 31}`, `t${i % 7}`],
    dims: { w: i % 500, h: i % 400, d: i % 200 },
    updatedAt: new Date(1700000000000 + i * 1000).toISOString(),
    note: `record ${i} with a moderately long free-text note to pad the record out to a realistic size`,
  });
}

// ── Dataset generation ──────────────────────────────────────────────────────

/**
 * Write both formats in ONE pass, stopping when the ARRAY reaches `targetMb`,
 * so they are guaranteed to hold the same records.
 *
 * The first attempt generated each file independently to a byte target, which
 * produced 1 799 799 records in the array and 1 805 815 in the NDJSON — the
 * two files held different datasets and the comparison was meaningless (the
 * totals disagreed and the benchmark reported it). Generate both from one
 * record stream instead; the array pays only a `,\n` and two brackets.
 *
 * A second attempt called countRecordsFor() first to learn the record count,
 * which loops over every record in pure CPU before a single byte is written —
 * at 4 GB that is ~15 M JSON.stringify calls of counting, minutes of spinning
 * with both output files still at 0 bytes. Stopping on the byte target while
 * streaming avoids that entirely.
 */
async function generateBothUpTo(arrayPath, ndPath, targetMb) {
  const arr = createWriteStream(arrayPath);
  const nd = createWriteStream(ndPath);
  const target = targetMb * 1024 * 1024;
  arr.write('[\n');
  let written = 2; // '[' + '\n'
  let i = 0;
  while (written < target) {
    const rec = makeRecord(i);
    const ndLine = `${rec}\n`;
    if (!nd.write(ndLine)) await once(nd, 'drain');
    const arrLine = (i === 0 ? '' : ',\n') + rec;
    if (!arr.write(arrLine)) await once(arr, 'drain');
    written += Buffer.byteLength(arrLine);
    i++;
  }
  arr.write('\n]\n');
  arr.end();
  nd.end();
  await Promise.all([once(arr, 'finish'), once(nd, 'finish')]);
  return i;
}

// ── Array indexing (shared by A and B) ──────────────────────────────────────

/** Byte offsets of each record's opening '{' (the first `{` after a newline). */
async function indexRecords(path) {
  const offsets = [];
  const stream = createReadStream(path, { highWaterMark: SCAN_CHUNK });
  let pos = 0;
  let afterNl = true;
  for await (const buf of stream) {
    for (let k = 0; k < buf.length; k++) {
      if (buf[k] === 0x0a) afterNl = true;
      else if (afterNl && buf[k] === 0x7b) {
        offsets.push(pos + k);
        afterNl = false;
      }
    }
    pos += buf.length;
  }
  // offsets[0] is the '[' array opener, not a record — the scan starts
  // "after a newline" but the file begins mid-stream. Drop it so every entry
  // is a real record start.
  if (offsets.length > 0 && offsets[0] === 0) offsets.shift();
  return offsets;
}

async function findArrayClose(path, size) {
  const { open } = await import('node:fs/promises');
  const fh = await open(path, 'r');
  try {
    const tail = Math.min(256, size);
    const buf = Buffer.alloc(tail);
    await fh.read(buf, 0, tail, size - tail);
    for (let i = buf.length - 1; i >= 0; i--) {
      const b = buf[i];
      if (b === 0x0a || b === 0x0d || b === 0x20 || b === 0x09) continue;
      if (b === 0x5d) return size - tail + i;
      throw new Error('unexpected trailing byte');
    }
    throw new Error('no closing ]');
  } finally {
    await fh.close();
  }
}

/** Chunk count is driven by file size, never by worker count. */
function chunkCount(sizeBytes, workerCount) {
  const needed = Math.ceil(sizeBytes / (MAX_CHUNK_MB * 1024 * 1024));
  return Math.max(workerCount, Math.ceil(needed / workerCount) * workerCount);
}

function buildRanges(size, boundaries, arrayClose, workerCount) {
  const n = chunkCount(size, workerCount);
  const per = Math.max(1, Math.floor(boundaries.length / n));
  const at = (i) => boundaries[Math.min(boundaries.length - 1, i * per)];
  const ranges = [];
  for (let i = 0; i < n; i++) {
    // Every entry in `boundaries` is already a record's '{' (the array opener
    // was dropped during indexing), so no offset adjustment is needed here.
    const start = at(i);
    const end = i === n - 1 ? arrayClose : at(i + 1) - 1;
    ranges.push({ start, end: end > start ? end : start + 1 });
  }
  return ranges;
}

// ── Task fns (serialised into the worker isolate — payload only, no closure) ──

function parseSlice(payload) {
  const { start, end, filePath } = payload;
  return import('node:fs').then(
    (fs) =>
      new Promise((resolve, reject) => {
        const bufs = [];
        const s = fs.createReadStream(filePath, { start, end: end - 1 });
        s.on('data', (c) => bufs.push(c));
        s.on('error', reject);
        s.on('end', () => {
          let text = Buffer.concat(bufs).toString('utf8');
          text = text
            .replace(/^[\r\n]+/, '')
            .replace(/[\r\n]+$/, '')
            .replace(/,$/, '');
          const t0 = performance.now();
          const arr = JSON.parse(`[${text}]`);
          const ms = performance.now() - t0;
          let total = 0;
          for (const r of arr) total += r.price;
          resolve({ count: arr.length, total, ms });
        });
      }),
  );
}

// ── Variant A: chunk-parallel ───────────────────────────────────────────────

async function variantA(filePath, size, boundaries, arrayClose, workerCount) {
  const ranges = buildRanges(size, boundaries, arrayClose, workerCount);
  const runtime = await createWorkerRuntime({ workers: workerCount, concurrency: 'fixed' });
  const t0 = performance.now();
  try {
    const results = await Promise.all(
      ranges.map((r) =>
        runtime.execute({
          type: 'slice',
          payload: { ...r, filePath },
          fn: parseSlice,
          timeoutMs: 0, // HARDEN-01's 5 s default preempts a multi-hundred-MB slice
        }),
      ),
    );
    const wall = performance.now() - t0;
    return {
      wall,
      records: results.reduce((n, r) => n + r.count, 0),
      total: results.reduce((n, r) => n + r.total, 0),
      chunks: ranges.length,
    };
  } finally {
    await runtime.shutdown();
  }
}

// ── Variant B: one worker, one contiguous read ──────────────────────────────

async function variantB(filePath, arrayClose) {
  const runtime = await createWorkerRuntime({ workers: 1, concurrency: 'fixed' });
  const t0 = performance.now();
  try {
    const r = await runtime.execute({
      type: 'whole',
      payload: { start: 2, end: arrayClose, filePath },
      fn: parseSlice,
      // The whole array can exceed the V8 string limit at 10 GB, so this
      // variant is only meaningful while the file fits in one slice.
      timeoutMs: 0,
    });
    return { wall: performance.now() - t0, records: r.count, total: r.total, chunks: 1 };
  } finally {
    await runtime.shutdown();
  }
}

// ── Variant C: NDJSON streaming, O(1) memory ────────────────────────────────

async function variantC(filePath) {
  const t0 = performance.now();
  let records = 0;
  let total = 0;
  let peakHeap = 0;
  const rl = createInterface({
    input: createReadStream(filePath, { highWaterMark: 1 << 18 }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line);
    records++;
    total += o.price;
    if ((records & 0xffff) === 0) {
      const h = process.memoryUsage().heapUsed;
      if (h > peakHeap) peakHeap = h;
    }
  }
  return { wall: performance.now() - t0, records, total, peakHeap };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const dir = join(tmpdir(), 'pwr-json-strategy');
  mkdirSync(dir, { recursive: true });
  const arrayFile = join(dir, 'data.json');
  const ndjsonFile = join(dir, 'data.ndjson');

  console.log('=====================================================================');
  console.log('BENCHMARK: chunk-parallel vs sequential vs NDJSON streaming');
  console.log('=====================================================================\n');
  console.log(`  cores         : ${cpus().length}`);
  console.log(`  RAM           : ${(totalmem() / 1024 ** 3).toFixed(1)} GB`);
  console.log(`  target/file   : ${EFFECTIVE_MB} MB${FAST ? '  (PWR_SKIP_LARGE)' : ''}`);
  console.log(`  workers       : ${WORKER_LADDER.join(' / ')}\n`);

  console.log('  generating both formats from ONE record stream ...');
  let t0 = performance.now();
  const recCount = await generateBothUpTo(arrayFile, ndjsonFile, EFFECTIVE_MB);
  const gen = performance.now() - t0;
  const { size: arraySize } = await stat(arrayFile);
  const { size: ndSize } = await stat(ndjsonFile);
  console.log(
    `    ${recCount.toLocaleString()} records -> array ${(arraySize / 1024 ** 3).toFixed(2)} GB, ` +
      `ndjson ${(ndSize / 1024 ** 3).toFixed(2)} GB (${(gen / 1000).toFixed(0)}s)\n`,
  );

  console.log('  indexing record boundaries ...');
  t0 = performance.now();
  const boundaries = await indexRecords(arrayFile);
  const arrayClose = await findArrayClose(arrayFile, arraySize);
  console.log(
    `    ${boundaries.length.toLocaleString()} boundaries in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`,
  );

  const rows = [];

  // ── A ──
  console.log('  [A] chunk-parallel across a worker pool ...');
  for (const w of WORKER_LADDER) {
    const r = await variantA(arrayFile, arraySize, boundaries, arrayClose, w);
    rows.push({ variant: `A chunk-parallel x${w}`, ...r, mb: arraySize / 1024 ** 2 });
    console.log(
      `      x${w}: ${(r.wall / 1000).toFixed(2)}s  ` +
        `${(arraySize / 1024 ** 2 / (r.wall / 1000)).toFixed(0)} MB/s  ` +
        `${r.records.toLocaleString()} recs  (${r.chunks} chunks)`,
    );
  }
  console.log('');

  // ── B ──
  // Variant B is only meaningful while the WHOLE array fits in one V8 string.
  // The hard limit is 0x1fffffe8 chars (~512 MB). Gating on MAX_CHUNK_MB (400)
  // instead wrongly skipped a 512 MB file that would actually fit.
  const V8_MAX_STRING = 0x1fffffe8;
  const arrayMb = arraySize / 1024 ** 2;
  const fitsOneString = arraySize <= V8_MAX_STRING;
  console.log('  [B] single worker, one contiguous read ...');
  if (fitsOneString) {
    const r = await variantB(arrayFile, arrayClose);
    rows.push({ variant: 'B sequential x1', ...r, mb: arrayMb });
    console.log(
      `      x1: ${(r.wall / 1000).toFixed(2)}s  ` +
        `${(arrayMb / (r.wall / 1000)).toFixed(0)} MB/s  (whole file in one V8 string)`,
    );
  } else {
    console.log(
      `      SKIPPED — the array is ${arrayMb.toFixed(0)} MB, over V8's ` +
        `${(V8_MAX_STRING / 1024 ** 2).toFixed(0)} MB string limit.`,
    );
    console.log('      A whole-file parse cannot exist at this size; that limit is exactly');
    console.log('      what variant A exists to work around.');
  }
  console.log('');

  // ── C ──
  console.log('  [C] NDJSON streaming (O(1) memory, no slicing) ...');
  const c = await variantC(ndjsonFile);
  rows.push({ variant: 'C ndjson stream', ...c, mb: ndSize / 1024 ** 2 });
  const cMbs = ndSize / 1024 ** 2 / (c.wall / 1000);
  console.log(
    `      : ${(c.wall / 1000).toFixed(2)}s  ${cMbs.toFixed(0)} MB/s  ` +
      `${c.records.toLocaleString()} recs  peak heap ${(c.peakHeap / 1024 ** 2).toFixed(0)} MB`,
  );
  console.log('');

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('=====================================================================');
  console.log('=== Results ===\n');
  console.table(
    Object.fromEntries(
      rows.map((r) => [
        r.variant,
        {
          'wall (s)': (r.wall / 1000).toFixed(2),
          'MB/s': (r.mb / (r.wall / 1000)).toFixed(0),
          records: r.records.toLocaleString(),
          'sum(price)': r.total.toFixed(0),
        },
      ]),
    ),
  );

  // Correctness cross-check. If the variants disagree on either the record
  // count or the summed field, they did not process the same dataset and the
  // timings mean nothing. Both files are generated from one record stream, so
  // any disagreement here is a real bug in a variant, not a fixture mismatch.
  const counts = new Set(rows.map((r) => r.records));
  const sums = new Set(rows.map((r) => Math.round(r.total)));
  console.log('');
  if (counts.size === 1 && sums.size === 1) {
    console.log(
      `  ✓ All variants agree: ${[...counts][0].toLocaleString()} records, ` +
        `sum(price) = ${[...sums][0].toLocaleString()}.`,
    );
  } else {
    console.log(`  ✗ DISAGREEMENT — the comparison is invalid.`);
    console.log(`    record counts: ${[...counts].join(', ')}`);
    console.log(`    sum(price):   ${[...sums].join(', ')}`);
  }

  const bestA = rows
    .filter((r) => r.variant.startsWith('A'))
    .reduce((a, b) => (b.wall < a.wall ? b : a));
  const bestB = rows.find((r) => r.variant.startsWith('B'));
  const cRow = rows.find((r) => r.variant.startsWith('C'));
  console.log('');
  console.log(`  best chunk-parallel : ${bestA.variant} — ${(bestA.wall / 1000).toFixed(2)}s`);
  if (bestB) console.log(`  sequential          : ${(bestB.wall / 1000).toFixed(2)}s`);
  console.log(`  NDJSON streaming    : ${(cRow.wall / 1000).toFixed(2)}s`);
  console.log('');
  console.log(
    `  NDJSON vs best chunk-parallel: ${(cRow.wall / bestA.wall).toFixed(2)}× ` +
      `(${cRow.wall < bestA.wall ? 'NDJSON is faster' : 'chunk-parallel is faster'})`,
  );
  console.log('');

  if (!process.env.PWR_JSON_KEEP) {
    await unlink(arrayFile).catch(() => undefined);
    await unlink(ndjsonFile).catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log('--- json strategy comparison complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
