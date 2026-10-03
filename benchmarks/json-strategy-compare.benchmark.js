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

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { rm, stat, unlink } from 'node:fs/promises';
import { cpus, freemem, tmpdir, totalmem } from 'node:os';
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

// ── RSS sampling ────────────────────────────────────────────────────────────

/**
 * Run `work` while sampling process RSS, returning its peak.
 *
 * RSS is the number that actually decides the architecture: V8 rarely returns
 * freed pages to the OS promptly, so a variant that ran earlier in the same
 * process inflates every later reading. Each variant therefore runs in its OWN
 * child process (see `runInChild`) and reports its own peak.
 */
async function withRssSampling(work, { intervalMs = 20 } = {}) {
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const r = process.memoryUsage().rss;
      if (r > peak) peak = r;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  try {
    return { result: await work(), peakRss: peak, baselineRss: baseline };
  } finally {
    sampling = false;
    await sampler;
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
  }
}

/**
 * Execute one variant in a fresh child process and return its measurements as
 * JSON. Isolation is the point: it makes each variant's peak RSS an honest
 * per-architecture number rather than a high-water mark shared with whatever
 * ran before it.
 */
function runInChild(mode, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
      env: { ...process.env, ...env, PWR_CHILD_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      errOut += c;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child ${mode} exited ${code}: ${errOut}`));
      const line = out
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .pop();
      if (!line) return reject(new Error(`child ${mode} produced no result line: ${out}${errOut}`));
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`child ${mode} bad JSON: ${line}`));
      }
    });
  });
}

// ── Child mode ──────────────────────────────────────────────────────────────

async function childMain(mode, env) {
  const { PWR_ARRAY_FILE: arrayFile, PWR_NDJSON_FILE: ndjsonFile } = env;
  const size = (await stat(arrayFile)).size;
  const boundaries = await indexRecords(arrayFile);
  const arrayClose = await findArrayClose(arrayFile, size);

  if (mode.startsWith('A')) {
    const workers = Number(mode.slice(1));
    const { result, peakRss, baselineRss } = await withRssSampling(() =>
      variantA(arrayFile, size, boundaries, arrayClose, workers),
    );
    return { ...result, peakRss, baselineRss, mb: size / 1024 ** 2 };
  }
  if (mode === 'B') {
    const { result, peakRss, baselineRss } = await withRssSampling(() =>
      variantB(arrayFile, arrayClose),
    );
    return { ...result, peakRss, baselineRss, mb: size / 1024 ** 2 };
  }
  const { result, peakRss, baselineRss } = await withRssSampling(() => variantC(ndjsonFile));
  return { ...result, peakRss, baselineRss, mb: (await stat(ndjsonFile)).size / 1024 ** 2 };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const dir = join(tmpdir(), 'pwr-json-strategy');
  mkdirSync(dir, { recursive: true });
  const arrayFile = join(dir, 'data.json');
  const ndjsonFile = join(dir, 'data.ndjson');

  // Child mode: run exactly one variant, emit a single JSON line, exit.
  if (process.env.PWR_CHILD_MODE) {
    const res = await childMain(process.env.PWR_CHILD_MODE, process.env);
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }
  console.log('=====================================================================');
  console.log('BENCHMARK: chunk-parallel vs sequential vs NDJSON streaming');
  console.log('=====================================================================\n');
  console.log(`  cores         : ${cpus().length}`);
  console.log(`  RAM           : ${(totalmem() / 1024 ** 3).toFixed(1)} GB`);
  console.log(`  target/file   : ${EFFECTIVE_MB} MB${FAST ? '  (PWR_SKIP_LARGE)' : ''}`);
  console.log(`  workers       : ${WORKER_LADDER.join(' / ')}\n`);

  console.log('  generating both formats from ONE record stream ...');
  const t0 = performance.now();
  const recCount = await generateBothUpTo(arrayFile, ndjsonFile, EFFECTIVE_MB);
  const gen = performance.now() - t0;
  const { size: arraySize } = await stat(arrayFile);
  const { size: ndSize } = await stat(ndjsonFile);
  console.log(
    `    ${recCount.toLocaleString()} records -> array ${(arraySize / 1024 ** 3).toFixed(2)} GB, ` +
      `ndjson ${(ndSize / 1024 ** 3).toFixed(2)} GB (${(gen / 1000).toFixed(0)}s)\n`,
  );

  // Indexing moved into each child process: every variant needs its own index
  // and doing it once here would only serve a value nobody reads now.
  const rows = [];
  const childEnv = { PWR_ARRAY_FILE: arrayFile, PWR_NDJSON_FILE: ndjsonFile };
  const gb = (b) => (b / 1024 ** 3).toFixed(2);

  // Every variant runs in its own child process so its peak RSS is an honest
  // per-architecture number. Running them in sequence in one process would let
  // V8's unreturned pages from an earlier variant inflate the next reading.
  console.log('  [A] chunk-parallel across a worker pool (one child process each) ...');
  for (const w of WORKER_LADDER) {
    const r = await runInChild(`A${w}`, childEnv);
    rows.push({ variant: `A chunk-parallel x${w}`, ...r });
    console.log(
      `      x${w}: ${(r.wall / 1000).toFixed(2)}s  ${(r.mb / (r.wall / 1000)).toFixed(0)} MB/s  ` +
        `${r.records.toLocaleString()} recs  ${r.chunks} chunks  peak RSS ${gb(r.peakRss)} GB ` +
        `(x${(r.peakRss / r.mb / 1024 ** 2).toFixed(1)} file size)`,
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
    const r = await runInChild('B', childEnv);
    rows.push({ variant: 'B sequential x1', ...r });
    console.log(
      `      x1: ${(r.wall / 1000).toFixed(2)}s  ${(r.mb / (r.wall / 1000)).toFixed(0)} MB/s  ` +
        `peak RSS ${gb(r.peakRss)} GB`,
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
  const c = await runInChild('C', childEnv);
  rows.push({ variant: 'C ndjson stream', ...c });
  const cMbs = c.mb / (c.wall / 1000);
  console.log(
    `      : ${(c.wall / 1000).toFixed(2)}s  ${cMbs.toFixed(0)} MB/s  ` +
      `${c.records.toLocaleString()} recs  peak RSS ${gb(c.peakRss)} GB ` +
      `(x${(c.peakRss / c.mb / 1024 ** 2).toFixed(2)} file size)`,
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
          'peak RSS': `${(r.peakRss / 1024 ** 3).toFixed(2)} GB`,
          '×file': (r.peakRss / (r.mb * 1024 ** 2)).toFixed(1),
          records: r.records.toLocaleString(),
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
  const cRow = rows.find((r) => r.variant.startsWith('C'));

  const fileGb = bestA.mb / 1024;
  const aRssGb = bestA.peakRss / 1024 ** 3;
  const cRssGb = cRow.peakRss / 1024 ** 3;
  const speedCost = cRow.wall / bestA.wall; // how much slower NDJSON is
  const memSaving = aRssGb / cRssGb; // how much less RAM NDJSON needs

  console.log('');
  console.log('  ── Decision ──\n');
  console.log('  Both options are viable; they trade time against memory.');
  console.log('  The crossover below is computed from the measurements above, not guessed.');
  console.log('');
  console.table({
    '': {
      'speed (4 GB)': `${(bestA.wall / 1000).toFixed(1)}s vs ${(cRow.wall / 1000).toFixed(1)}s`,
      'peak RSS': `${aRssGb.toFixed(2)} GB vs ${cRssGb.toFixed(2)} GB`,
      '× file size': `${(aRssGb / fileGb).toFixed(1)}× vs ${(cRssGb / fileGb).toFixed(2)}×`,
    },
  });
  console.log('');
  console.log(
    `  NDJSON costs ${speedCost.toFixed(2)}× the wall time and saves ${memSaving.toFixed(1)}× the RAM.`,
  );
  console.log('');
  console.log(
    `  For a file of size F, chunk-parallel needs about ${(aRssGb / fileGb).toFixed(1)}× F of free RAM.`,
  );
  console.log(
    `  That is affordable while  F <= freeRam / ${(aRssGb / fileGb).toFixed(1)}` +
      `  (≈ ${(freemem() / 1024 ** 3 / (aRssGb / fileGb)).toFixed(1)} GB on this host).`,
  );
  console.log('');

  const ratio = aRssGb / fileGb;
  const budget = freemem() / 1024 ** 3;
  if (budget > fileGb * ratio * 1.5) {
    console.log(
      `  → Use CHUNK-PARALLEL. ${budget.toFixed(1)} GB free comfortably covers the ` +
        `${(fileGb * ratio).toFixed(1)} GB this file needs, and it is ${speedCost.toFixed(2)}× faster.`,
    );
  } else {
    console.log(
      `  → Use NDJSON STREAMING. ${budget.toFixed(1)} GB free does not comfortably cover the ` +
        `${(fileGb * ratio).toFixed(1)} GB chunk-parallel would need for this file. ` +
        `Pay the ${speedCost.toFixed(2)}× time cost and keep ${cRssGb.toFixed(2)} GB.`,
    );
  }
  console.log('');
  console.log('  Limitations of each option (measured, not assumed):');
  console.log(
    `    chunk-parallel — needs ~${ratio.toFixed(1)}× file size in RAM; the slice size is`,
  );
  console.log('      capped by the ~512 MB V8 string limit, so a big file always means');
  console.log('      many chunks; and on a COLD file its speedup falls to ~2× because');
  console.log('      four read streams queue on one device (see parse-parallelism-probe).');
  console.log(`    NDJSON streaming — needs the data to ALREADY be one object per line, so it`);
  console.log('      cannot read an existing JSON array without a conversion pass; single');
  console.log(
    `      threaded, so no parse parallelism; and ${speedCost.toFixed(2)}× slower here because`,
  );
  console.log('      each line costs a JSON.parse call plus a stream event.');
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
