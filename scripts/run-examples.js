/**
 * CI gate: runs every example script under `examples/`.
 *
 * The 20 example scripts are the primary API documentation for this
 * package. Until now they were executed by hand, occasionally — which is
 * how `examples/durable-task-vacuum.js` shipped broken (a
 * `ReferenceError: DatabaseSync is not defined` that was only caught by
 * reconciling the docs against the filesystem by hand).
 *
 * This runner closes that gap:
 *
 *  - every example runs in an isolated child process, so one example cannot
 *    corrupt the state of the next;
 *  - each example gets a wall-clock budget; a hung example is killed and
 *    fails the gate instead of burning the CI job;
 *  - an example that needs an external service or an argument declares it
 *    with a `// requires:` marker and is skipped with a visible message —
 *    never silently;
 *  - the child runs with its working directory OUTSIDE the repository, so
 *    an example that writes a file (a SQLite database, a JSON dump) cannot
 *    leave debris in the working tree.
 *
 * Exit code: 0 when every example either passed or was explicitly skipped,
 * 1 when at least one example failed or timed out.
 *
 * Usage: `npm run examples`
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runNode } from './lib/spawn.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES_DIR = join(REPO_ROOT, 'examples');

/** Wall-clock budget for a single example. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Per-example overrides.
 *
 * `env` values are merged into the child's environment. `timeoutMs` replaces
 * the default budget. Every entry needs a `reason` — an unexplained override
 * is indistinguishable from a magic number.
 */
const EXAMPLE_OVERRIDES = {
  'parallel-json-parse.js': {
    // The example's own default is a 1 GB target file (`PWR_JSON_MB=1024`).
    // That is a benchmark workload, not a documentation smoke test: it
    // writes a gigabyte to disk and takes minutes. The example exposes the
    // knob precisely so a fast run is possible, and every code path it
    // documents (byte-range chunking, the V8 string limit, worker fan-out)
    // is exercised at 64 MB too.
    env: { PWR_JSON_MB: '64' },
    timeoutMs: 120_000,
    reason: 'default target is a 1 GB file; the gate runs a 64 MB target via PWR_JSON_MB',
  },
};

/**
 * Matches a `// requires:` marker: a whole-line comment that names the
 * external dependency (service, credential or argument) the example needs.
 */
const REQUIRES_MARKER = /^\s*\/\/\s*requires:\s*(.+?)\s*$/;

/**
 * @param {string} source
 * @returns {string|null} the requirement declared by the example, if any.
 */
export function parseRequiresMarker(source) {
  for (const line of source.split(/\r?\n/)) {
    const match = REQUIRES_MARKER.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * @returns {string[]} absolute paths of the example scripts, sorted.
 */
export function discoverExamples() {
  return readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => join(EXAMPLES_DIR, name));
}

async function main() {
  const examples = discoverExamples();

  if (examples.length === 0) {
    console.error('examples gate: no example scripts found in examples/');
    process.exit(1);
  }

  // The runner lives in `scripts/`, never in `examples/`, so it cannot be
  // discovered as an example to run. The guard below is a belt-and-braces
  // check for the case where somebody copies this file into `examples/`.
  const runnerBasename = fileURLToPath(import.meta.url)
    .split(/[\\/]/)
    .pop();
  if (examples.some((file) => file.endsWith(`/${runnerBasename}`))) {
    console.error(
      `examples gate: refusing to run — the runner itself (${runnerBasename}) was found in examples/`,
    );
    process.exit(1);
  }

  // Working directory for the children: a scratch directory OUTSIDE the
  // repository. Every example resolves its own imports relative to its own
  // file, so the working directory is irrelevant to module resolution — but
  // it is the landing zone for any relative-path write, and we want that
  // landing zone to be somewhere disposable.
  const workDir = mkdtempSync(join(tmpdir(), 'pwr-examples-'));

  const results = [];
  console.log(`examples gate — ${examples.length} example(s) from examples/\n`);

  for (const file of examples) {
    const name = file.split(/[\\/]/).pop();
    const source = readFileSync(file, 'utf8');

    const requirement = parseRequiresMarker(source);
    if (requirement) {
      results.push({ name, status: 'skipped', detail: `requires: ${requirement}`, durationMs: 0 });
      console.log(`[SKIP] ${name} — requires: ${requirement}`);
      continue;
    }

    const override = EXAMPLE_OVERRIDES[name] || {};
    const timeoutMs = override.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const result = await runNode({
      args: [file],
      cwd: workDir,
      env: override.env,
      timeoutMs,
    });
    const durationMs = Date.now() - startedAt;

    if (result.timedOut) {
      results.push({
        name,
        status: 'failed',
        detail: `timed out after ${timeoutMs} ms`,
        durationMs,
      });
      console.log(`[FAIL] ${name} — timed out after ${timeoutMs} ms`);
      continue;
    }

    if (result.code !== 0) {
      const detail = firstMeaningfulLine(result.stderr) || `exit code ${result.code}`;
      results.push({ name, status: 'failed', detail, durationMs });
      console.log(`[FAIL] ${name} — ${detail}`);
      continue;
    }

    results.push({ name, status: 'ok', detail: '', durationMs });
    console.log(`[ OK ] ${name} (${durationMs} ms)`);
  }

  rmSync(workDir, { recursive: true, force: true });

  const ok = results.filter((r) => r.status === 'ok');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'failed');

  console.log('\n=== examples gate summary ===');
  console.log(
    `total: ${results.length} | ok: ${ok.length} | skipped: ${skipped.length} | failed: ${failed.length}`,
  );
  for (const r of skipped) console.log(`  skipped: ${r.name} — ${r.detail}`);
  for (const r of failed) console.log(`  failed:  ${r.name} — ${r.detail}`);

  if (failed.length > 0) {
    console.error(`\nexamples gate FAILED — ${failed.length} example(s) did not pass.`);
    process.exit(1);
  }
  console.log('\nexamples gate PASSED.');
}

/**
 * Picks the most informative line out of a child's stderr: the first line
 * that actually looks like an error message rather than a stack frame.
 */
function firstMeaningfulLine(stderr) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLine = lines.find((line) => /^[A-Za-z]*(Error|Exception)\b/.test(line));
  return errorLine || lines[0] || '';
}

// Only run the CLI when this file is the process entry point — the module
// is imported by the test suite, which must not trigger the gate.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('examples gate crashed:', err);
    process.exit(1);
  });
}
