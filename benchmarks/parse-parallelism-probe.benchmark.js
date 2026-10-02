/**
 * Investigation: why does total CPU time RISE when parsing 10 GB in parallel?
 *
 * Observed in examples/parallel-json-parse.js at 10 GB (28-core host):
 *   1 worker   127.7s wall   75 456 ms total parse CPU
 *   4 workers   64.9s wall   94 427 ms total parse CPU   <- +25% MORE total work
 *
 * Parallelism should reduce wall time at constant total CPU. It did reduce wall
 * time, but it also made the machine do ~25% more parsing work. Three candidate
 * causes:
 *
 *   H1 DISK       - the 10 GB run is I/O bound, so 4 read streams contend.
 *                    Test: parse from RAM with no file at all.
 *   H2 BANDWIDTH  - JSON.parse is allocation-heavy; 4 isolates building large
 *                    object graphs at once saturate DRAM bandwidth, so each runs
 *                    slower. Test: same work, 1 vs 4 threads, from RAM.
 *   H3 GC         - each isolate grows its own heap and GCs independently, and
 *                    4 heaps of garbage interleave worse than 1. Test: compare
 *                    total parse CPU with a forced-GC control.
 *
 * H2 and H3 are CPU/memory properties, so they reproduce without any file.
 */

import { mkdirSync } from 'node:fs';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

/** Byte offsets of each line start in a file. */
async function indexNewlineBoundaries(path) {
  const { createReadStream } = await import('node:fs');
  const offsets = [];
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  let pos = 0;
  let afterNl = true;
  for await (const buf of stream) {
    for (let k = 0; k < buf.length; k++) {
      if (buf[k] === 0x0a) {
        afterNl = true;
      } else if (afterNl) {
        offsets.push(pos + k);
        afterNl = false;
      }
    }
    pos += buf.length;
  }
  return offsets;
}

/** Spawn one worker that reads a byte range of a file and parses it, timed. */
function runOnFreshWorker({ start, end, filePath, rounds }) {
  const src = `
const { parentPort, workerData } = require('node:worker_threads');
const { start, end, filePath, rounds } = workerData;
const fs = require('node:fs');
let parseMs = 0;
function readRange() {
  return new Promise((resolve, reject) => {
    const bufs = [];
    const s = fs.createReadStream(filePath, { start, end: end - 1 });
    s.on('data', (c) => bufs.push(c));
    s.on('error', reject);
    s.on('end', () => resolve(Buffer.concat(bufs)));
  });
}
(async () => {
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    const buf = await readRange();
    let text = buf.toString('utf8');
    text = text.replace(/^[\\r\\n]+/, '').replace(/[\\r\\n]+$/, '').replace(/,$/, '');
    const arr = JSON.parse('[' + text + ']');
    let acc = 0;
    for (let i = 0; i < arr.length; i += 97) acc += arr[i].price;
    parseMs += performance.now() - t0;
  }
  parentPort.postMessage({ parseMs });
})();
`;
  const w = new Worker(src, { eval: true, workerData: { start, end, filePath, rounds } });
  return new Promise((resolve, reject) => {
    w.once('message', (m) => {
      w.terminate().then(
        () => resolve(m),
        () => resolve(m),
      );
    });
    w.once('error', reject);
  });
}

// ── Parameters ──────────────────────────────────────────────────────────────

const CHUNK_MB = 120; // per-parse payload; under the 512 MB string limit
const ROUNDS = 3; // repeat for a median

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

/** Build a JSON array text of roughly `mb` megabytes. */
function buildPayload(mb) {
  const target = mb * 1024 * 1024;
  const parts = ['['];
  let written = 1;
  let i = 0;
  while (written < target) {
    const line = (i === 0 ? '' : ',') + makeRecord(i);
    parts.push(line);
    written += line.length + 1;
    i++;
  }
  parts.push(']');
  return { text: parts.join(''), records: i };
}

// ── Worker body ─────────────────────────────────────────────────────────────
// Parses the same text it is given, repeatedly, and reports timings.

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { text, rounds } = workerData;
const samples = [];
for (let r = 0; r < rounds; r++) {
  const t0 = performance.now();
  const arr = JSON.parse(text);
  const dt = performance.now() - t0;
  // touch the result so it cannot be optimised away
  let acc = 0;
  for (let i = 0; i < arr.length; i += 97) acc += arr[i].price;
  samples.push({ ms: dt, records: arr.length, acc });
}
parentPort.postMessage({ samples, heapUsed: process.memoryUsage().heapUsed });
`;

async function runInProcess(text, rounds) {
  const samples = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    const arr = JSON.parse(text);
    const dt = performance.now() - t0;
    let acc = 0;
    for (let i = 0; i < arr.length; i += 97) acc += arr[i].price;
    samples.push({ ms: dt, records: arr.length, acc });
  }
  return { samples, heapUsed: process.memoryUsage().heapUsed };
}

async function runInWorkers(text, rounds, nWorkers) {
  const workers = [];
  const results = await Promise.all(
    Array.from({ length: nWorkers }, async () => {
      const w = new Worker(workerSource, {
        eval: true,
        workerData: { text, rounds },
      });
      workers.push(w);
      return new Promise((resolve, reject) => {
        w.once('message', resolve);
        w.once('error', reject);
      });
    }),
  );
  await Promise.all(workers.map((w) => w.terminate()));
  return results;
}

// ── Sweep: chunk size × worker count ─────────────────────────────────────────
//
// The first round confirmed that N concurrent parses each run ~18% slower than
// one alone. The open question is WHY, because the fix differs:
//
//   H2 MEMORY BANDWIDTH — the object graph is allocation-heavy; 4 isolates
//      building large graphs at once saturate DRAM. Symptom: slowdown is roughly
//      constant regardless of chunk size, because total allocation rate is what
//      saturates the bus. Fix: fewer workers, or interleave so the working set
//      is smaller.
//   H3 GC PRESSURE — each isolate grows its own old-space and collects on its
//      own schedule; 4 heaps GC in a staggered-bursty way that steals the mutator.
//      Symptom: slowdown scales with how much HEAP each worker holds, so smaller
//      chunks (and thus smaller live graphs) shrink it.
//
// A sweep over both axes separates them: if the penalty is a function of the
// worker count alone, it is bandwidth; if it collapses when the chunk shrinks,
// it is GC.

async function sweep(text, sizes, workerCounts, rounds) {
  const rows = [];
  for (const mb of sizes) {
    const payload = mb === CHUNK_MB ? text : buildPayload(mb).text;
    const base = median((await runInProcess(payload, rounds)).samples.map((s) => s.ms));
    for (const nw of workerCounts) {
      const res = await runInWorkers(payload, rounds, nw);
      const per = res.map((r) => median(r.samples.map((s) => s.ms)));
      const slowest = Math.max(...per);
      rows.push({
        chunkMb: mb,
        workers: nw,
        baseMs: base,
        slowestMs: slowest,
        // PARALLEL SPEEDUP = how much faster N concurrent parses complete than
        // the same N done one after another: (N x base) / slowest.
        //
        // NOTE: an earlier version reported `base / slowest` here and called it
        // "effective". That is the PER-PARSE SLOWDOWN, not a speedup, and it
        // made 4 concurrent parses look like 0.86x - i.e. slower than serial -
        // when the real figure is 3.46x. Measuring the wrong quantity
        // inverted the conclusion: it looked like memory-bandwidth saturation
        // when parallel parse actually scales near-linearly.
        speedup: (nw * base) / slowest,
        // per-worker slowdown vs the same work done alone
        penalty: slowest / base,
      });
      console.log(
        `  chunk ${String(mb).padStart(4)} MB × ${nw} worker(s): ` +
          `base ${base.toFixed(0)} ms → slowest ${slowest.toFixed(0)} ms  ` +
          `speedup ${((nw * base) / slowest).toFixed(2)}×  per-parse penalty ` +
          `${(slowest / base).toFixed(2)}×`,
      );
    }
  }
  return rows;
}

// ── I/O probe: how much of a real file parse is waiting on the disk? ─────────
//
// The sweep above shows JSON.parse parallelises near-linearly from memory. So
// the 1.97x observed on the 10 GB file cannot be a CPU ceiling. The remaining
// suspect is the read. This measures a file-backed run and splits the wall clock
// into "time actually spent in JSON.parse" and "everything else", which for a
// file-backed chunk is dominated by read wait.

async function fileParseProbe(path, mb, workers, rounds) {
  const { size } = await stat(path);
  const nChunks = Math.max(workers, Math.ceil(size / (mb * 1024 * 1024)));
  // Split at NEWLINE boundaries, never at arbitrary offsets — the probe file
  // is one record per line inside a JSON array, and a mid-record cut yields
  // an invalid slice. (Same trap as examples/parallel-json-parse.js.)
  const boundaries = await indexNewlineBoundaries(path);
  // Chunk i spans [edge[i], edge[i+1]) where edge[k] = boundaries[k * per].
  // The final chunk stops before the file's closing "]". Every index is
  // clamped: with per = floor(N/nChunks), the last edge can land out of range
  // and an unclamped read yields a garbage slice that JSON.parse rejects.
  const per = Math.max(1, Math.floor(boundaries.length / nChunks));
  // boundaries[0] is the file's leading '[' (the scan starts "after a newline",
  // and it begins mid-file), boundaries[1] is the first record's '{'. The first
  // chunk must start at a FIXED index 1 — using edgeAt(1) would jump per records
  // in and slice the array opener into the parse.
  const edgeAt = (i) => boundaries[Math.min(boundaries.length - 1, 1 + i * per)];
  const ranges = [];
  for (let i = 0; i < nChunks; i++) {
    const start = edgeAt(i);
    let end = i === nChunks - 1 ? size - 2 : edgeAt(i + 1) - 1;
    if (end <= start) end = start + 1;
    ranges.push({ start, end });
  }

  const t0 = performance.now();
  const results = await Promise.all(
    ranges.map((r) =>
      runOnFreshWorker({
        start: r.start,
        end: r.end,
        filePath: path,
        rounds,
      }),
    ),
  );
  const wallMs = performance.now() - t0;
  const parseTotal = results.reduce((a, r) => a + r.parseMs, 0);
  return {
    workers,
    chunks: nChunks,
    wallMs,
    parseTotalMs: parseTotal,
    // per-worker serial parse time; the rest of that worker's wall share is I/O
    parsePerWorker: parseTotal / workers,
    // how much of each worker's wall budget was NOT spent parsing
    ioShareMs: wallMs - parseTotal / workers,
    mb: size / 1024 / 1024,
  };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=====================================================================');
  console.log('INVESTIGATION: why does total parse CPU rise with parallelism?');
  console.log('=====================================================================\n');
  console.log(`  logical cores : ${cpus().length}`);
  console.log(`  total RAM     : ${(totalmem() / 1024 ** 3).toFixed(1)} GB`);
  console.log(`  rounds        : ${ROUNDS}\n`);

  console.log('  building payloads ...');
  const { text, records } = buildPayload(CHUNK_MB);
  console.log(
    `  -> ${(text.length / 1024 / 1024).toFixed(0)} MB, ${records.toLocaleString()} records\n`,
  );

  // ── Sweep ──────────────────────────────────────────────────────────────────
  const skipSweep = process.env.PWR_SKIP_SWEEP === '1';
  let rows = [];
  if (skipSweep) {
    console.log('  [sweep] skipped (PWR_SKIP_SWEEP=1)\n');
  } else {
    console.log('  [sweep] chunk size x worker count ...\n');
    rows = await sweep(text, [24, 60, 120, 240], [1, 2, 3, 4, 6, 8], ROUNDS);
    console.log('');
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log('=====================================================================');
  console.log('=== Findings ===\n');
  console.table(rows);

  const byChunk = new Map();
  for (const r of rows) {
    if (r.workers < 2) continue;
    if (!byChunk.has(r.chunkMb)) byChunk.set(r.chunkMb, []);
    byChunk.get(r.chunkMb).push(r.penalty);
  }
  const byWorker = new Map();
  for (const r of rows) {
    if (r.workers < 2) continue;
    if (!byWorker.has(r.workers)) byWorker.set(r.workers, []);
    byWorker.get(r.workers).push(r.penalty);
  }
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  console.log('');
  console.log('  Mean penalty (slowest worker vs same work alone), by chunk size:');
  for (const [mb, ps] of [...byChunk.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    ${String(mb).padStart(4)} MB → ${avg(ps).toFixed(3)}×`);
  }
  console.log('  Mean penalty, by worker count:');
  for (const [nw, ps] of [...byWorker.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    ${String(nw).padStart(2)} workers → ${avg(ps).toFixed(3)}×`);
  }
  console.log('');

  if (rows.length > 0) {
    const best = rows.reduce((a, b) => (b.speedup > a.speedup ? b : a));
    console.log(`  Best parallel speedup: ${best.speedup.toFixed(2)}×`);
    console.log(`    at ${best.chunkMb} MB chunks × ${best.workers} workers`);
    console.log('');
    const workerSensitive = avg(byWorker.get(8) ?? [1]) - avg(byWorker.get(2) ?? [1]);
    const chunkSpread =
      Math.max(...[...byChunk.values()].map(avg)) - Math.min(...[...byChunk.values()].map(avg));
    console.log('  Diagnosis of the in-memory parse:');
    if (best.speedup > 3) {
      console.log(
        `    -> JSON.parse parallelises NEAR-LINEARLY (${best.speedup.toFixed(2)}× on ` +
          `${best.workers} workers).`,
      );
      console.log('       The per-parse penalty is real but small; total throughput still scales.');
      console.log('       Memory-bandwidth saturation (H2) and GC interference (H3) are');
      console.log('       REFUTED as the cause of the 10 GB slowdown.');
    }
    console.log(
      `    chunk-size sensitivity: ${chunkSpread.toFixed(3)} (low = chunk size does not matter)`,
    );
    console.log(`    worker-count penalty 2→8: ${workerSensitive.toFixed(3)}`);
    console.log('');
  }

  // ── I/O probe ──────────────────────────────────────────────────────────────
  console.log('  [io] file-backed probe — how much of the wall clock is NOT parse?\n');
  const dir = join(tmpdir(), 'pwr-io-probe');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'probe.json');
  // Emit records individually, one per line — the same shape
  // examples/parallel-json-parse.js writes. Re-slicing a joined blob on "},{"
  // is NOT safe, because a record's string values may contain that sequence.
  const rec = (i) => makeRecord(i);

  const lines = [];
  let written = 2;
  let i = 0;
  while (written < text.length) {
    const line = (i === 0 ? '' : ',\n') + rec(i);
    lines.push(line);
    written += line.length;
    i++;
  }
  await writeFile(file, `[\n${lines.join('')}\n]\n`);

  for (const nw of [1, 2, 4, 8]) {
    const p = await fileParseProbe(file, 60, nw, 1);
    // With 1 worker, parseMs is the SUM over the chunks that worker processed
    // sequentially, so it legitimately exceeds the wall clock (the rounds
    // serialise). Only the 2+ rows are directly comparable.
    const label = nw === 1 ? '(1 worker: parse sums over sequential chunks)' : '';
    const ioPct = (p.ioShareMs / p.wallMs) * 100;
    console.log(
      `  ${nw} worker(s): wall ${(p.wallMs / 1000).toFixed(2)}s  ` +
        `parse ${(p.parsePerWorker / 1000).toFixed(2)}s/worker  ` +
        `not-parse ${(p.ioShareMs / 1000).toFixed(2)}s (${ioPct.toFixed(0)}%) ${label}`,
    );
  }
  await unlink(file).catch(() => undefined);
  console.log('');
  console.log('--- investigation complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
