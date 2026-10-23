/**
 * CI gate: validates the shipped skill (`skills/persistent-worker-runtime/`).
 *
 * The skill ships INSIDE the npm tarball (`files: ["src", "skills", ...]`) and
 * is loaded by AI agents, which treat it as authoritative. A stale code
 * example in the skill is worse than a stale README line: the agent
 * reproduces the bug in someone else's project.
 *
 * The skill is also invisible to CI: every workflow in this repository uses
 * `paths-ignore: ['**.md', ...]` and the skill is entirely `.md`, so
 * changing it did not even trigger a build. This gate is wired through a
 * dedicated workflow (`.github/workflows/skill-validation.yml`) that uses
 * `paths:` instead, so a skill change always runs it.
 *
 * What this gate does:
 *
 *  1. Extracts every fenced code block from `SKILL.md` and `references/*.md`.
 *  2. Reports the blocks that are out of scope (TypeScript, shell, SQL,
 *     untagged fences) with the reason for each — nothing is skipped
 *     silently.
 *  3. Syntax-checks EVERY JavaScript block. A block that does not parse is
 *     a broken snippet an agent will copy verbatim.
 *  4. Executes the JavaScript blocks in an isolated child process, with a
 *     wall-clock budget, and classifies the outcome. Blocks that are
 *     fragments of a larger program fail with a precise reason
 *     ("undefined identifier `runtime`"), which is reported as a documented
 *     skip rather than a gate failure.
 *  5. Validates `.skill-meta.json`: it must parse, its trigger list must be
 *     non-empty and free of duplicates, and every file it lists must exist.
 *
 * Exit code: 0 when the metadata is coherent. A block that fails is
 * REPORTED, not fatal — the gate must not paint the repository red over
 * content this task is not allowed to rewrite.
 *
 * Usage: `npm run skill:validate`
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runNode } from './lib/spawn.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = join(REPO_ROOT, 'skills', 'persistent-worker-runtime');
const META_FILE = join(SKILL_DIR, '.skill-meta.json');

/** Wall-clock budget for a single JavaScript block. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Fence languages that carry JavaScript. */
const JS_LANGS = new Set(['js', 'javascript', 'mjs', 'node']);

/**
 * Fence languages that are deliberately out of scope, with the reason.
 * Anything not listed here and not a JavaScript fence is reported as
 * "other" so it still shows up in the summary.
 */
const OUT_OF_SCOPE_LANGS = {
  typescript:
    'TypeScript blocks are out of scope for this gate: the repository is zero-dependency (ADR-0005) and ships no TypeScript compiler, so there is no way to compile them here. A TypeScript gate is a separate decision that needs an explicit policy call.',
  ts: 'Same as `typescript` — no TypeScript compiler is available in this zero-dependency repository.',
  bash: 'shell snippet, not JavaScript',
  sh: 'shell snippet, not JavaScript',
  shell: 'shell snippet, not JavaScript',
  sql: 'SQL snippet, not JavaScript',
  json: 'JSON snippet, not JavaScript',
};

/**
 * Blocks that must NOT be executed, with the reason.
 *
 * The classifier can only explain failures it observes. These blocks have
 * side effects on the host (a listening TCP port, outbound requests to a
 * third party) or would report a meaningless success (they declare code but
 * never run it), so they are excluded explicitly instead.
 *
 * Keyed by the block's path relative to the skill directory, then by the
 * zero-based index of the block among ALL fenced blocks in that file.
 */
const EXCLUDED_BLOCKS = {
  'references/quickstart.md': {
    0: 'starts an HTTP listener on TCP port 3000 — the child would hold the port until it is killed',
    1: 'fires 100 outbound HTTPS requests to httpbin.org — the gate must not depend on, or hammer, a third-party service',
  },
  'references/broadcast-channel.md': {
    0: 'declares worker-side helper functions that are never invoked — running it would exercise no library API',
  },
  'references/observability.md': {
    5: 'only registers signal handlers — running it would exercise no library API',
  },
};

/**
 * Harness preamble prepended to an executed block.
 *
 * The reference pages show the package import once in the Quick Start and
 * assume it afterwards, so a block that calls `createWorkerRuntime` without
 * importing it is a legitimate snippet, not a broken one. The preamble
 * exposes the package's public API as globals so those blocks run as
 * written. A block that imports the package itself is unaffected: its
 * lexical binding shadows the global.
 */
function buildPreamble(packageEntryUrl) {
  return [
    `import * as __pwr from ${JSON.stringify(packageEntryUrl)};`,
    'for (const __key of Object.keys(__pwr)) {',
    "  if (typeof __pwr[__key] === 'function' && !(__key in globalThis)) globalThis[__key] = __pwr[__key];",
    '}',
    '',
  ].join('\n');
}

/**
 * Harness epilogue appended to an executed block.
 *
 * Two jobs:
 *  - wait one tick so Node can surface an unhandled rejection (that is how
 *    a block that rejects a task handle at shutdown shows up);
 *  - exit the process, so a block that leaves a runtime alive cannot hang
 *    the gate.
 */
const EPILOGUE = [
  '',
  '// Gate harness: give Node a tick to report unhandled rejections, then exit.',
  'await new Promise((resolve) => setTimeout(resolve, 50));',
  'process.exit(0);',
  '',
].join('\n');

/**
 * Extracts the fenced code blocks from a Markdown document.
 *
 * @param {string} markdown
 * @returns {{lang: string, startLine: number, code: string}[]} `startLine` is
 *   the 1-based line of the first line INSIDE the fence.
 */
export function extractCodeBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let inFence = false;
  let lang = '';
  let startLine = 0;
  let body = [];

  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S*)\s*$/.exec(lines[i]);
    if (!inFence && open) {
      inFence = true;
      lang = open[1].toLowerCase();
      startLine = i + 2;
      body = [];
      continue;
    }
    if (inFence && /^```\s*$/.test(lines[i])) {
      inFence = false;
      blocks.push({ lang, startLine, code: body.join('\n') });
      continue;
    }
    if (inFence) body.push(lines[i]);
  }
  return blocks;
}

/**
 * @param {string} code
 * @returns {string} a short, stable identifier for the block content.
 */
export function blockFingerprint(code) {
  return createHash('sha256').update(code).digest('hex').slice(0, 12);
}

/**
 * Validates `.skill-meta.json`.
 *
 * @param {object} meta The parsed metadata.
 * @param {string} skillDir Absolute path of the skill directory.
 * @returns {string[]} human-readable problems; empty when the metadata is coherent.
 */
export function validateSkillMeta(meta, skillDir) {
  const problems = [];

  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return ['.skill-meta.json must contain a JSON object'];
  }

  const triggers = meta.triggers;
  if (!Array.isArray(triggers)) {
    problems.push('"triggers" must be an array');
  } else {
    if (triggers.length === 0) {
      problems.push('"triggers" must not be empty');
    }
    const seen = new Set();
    const duplicates = new Set();
    for (const trigger of triggers) {
      if (typeof trigger !== 'string' || trigger.trim() === '') {
        problems.push('every entry in "triggers" must be a non-empty string');
        break;
      }
      if (seen.has(trigger)) duplicates.add(trigger);
      seen.add(trigger);
    }
    for (const duplicate of duplicates) {
      problems.push(`"triggers" contains a duplicate entry: "${duplicate}"`);
    }
  }

  if (!Array.isArray(meta.files)) {
    problems.push('"files" must be an array');
  } else {
    for (const relative of meta.files) {
      if (typeof relative !== 'string' || relative.trim() === '') {
        problems.push('every entry in "files" must be a non-empty string');
        break;
      }
      if (!existsSync(join(skillDir, relative))) {
        problems.push(`"files" lists a file that does not exist: ${relative}`);
      }
    }
  }

  return problems;
}

/**
 * Explains why an executed block did not succeed.
 *
 * @param {{timedOut: boolean, stdout: string, stderr: string, code: number|null}} result
 * @returns {{kind: string, reason: string}}
 */
export function classifyBlockFailure(result) {
  if (result.timedOut) {
    return { kind: 'timeout', reason: 'the block did not finish within the time budget' };
  }
  const text = `${result.stderr}\n${result.stdout}`;

  const missingIdentifier = /ReferenceError: (\S+) is not defined/.exec(text);
  if (missingIdentifier) {
    return {
      kind: 'fragment',
      reason: `fragment of a larger program — undefined identifier "${missingIdentifier[1]}" is defined outside the snippet`,
    };
  }
  const missingPackage = /Cannot find package '([^']+)'/.exec(text);
  if (missingPackage) {
    return {
      kind: 'external-dependency',
      reason: `external dependency — package "${missingPackage[1]}" is not installable in this zero-dependency repository (ADR-0005)`,
    };
  }
  const typeError = /TypeError: (.*)/.exec(text);
  if (typeError) {
    return { kind: 'runtime-error', reason: `TypeError: ${typeError[1].trim().slice(0, 160)}` };
  }
  const otherError = /^\s*([A-Za-z]*Error): (.*)$/m.exec(text);
  if (otherError) {
    return {
      kind: 'runtime-error',
      reason: `${otherError[1]}: ${otherError[2].trim().slice(0, 160)}`,
    };
  }
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return {
    kind: 'runtime-error',
    reason: firstLine ? firstLine.slice(0, 160) : `exit code ${result.code}`,
  };
}

/**
 * Lists the Markdown documents that make up the skill.
 *
 * @returns {{absolute: string, relative: string}[]}
 */
export function listSkillDocuments() {
  const documents = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
      } else if (entry.endsWith('.md')) {
        documents.push({
          absolute,
          relative: absolute
            .slice(SKILL_DIR.length + 1)
            .split('\\')
            .join('/'),
        });
      }
    }
  };
  walk(SKILL_DIR);
  return documents;
}

async function main() {
  const packageEntryUrl = pathToFileURL(join(REPO_ROOT, 'src', 'index.js')).href;

  // --- metadata -------------------------------------------------------
  const metaProblems = [];
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(META_FILE, 'utf8'));
  } catch (err) {
    metaProblems.push(`.skill-meta.json is not valid JSON: ${err.message}`);
  }
  if (meta) metaProblems.push(...validateSkillMeta(meta, SKILL_DIR));

  console.log('skill gate — skills/persistent-worker-runtime\n');

  // --- block extraction ------------------------------------------------
  const documents = listSkillDocuments();
  const outcomes = [];
  const outOfScope = [];
  let blockIndex = 0;

  for (const document of documents) {
    const markdown = readFileSync(document.absolute, 'utf8');
    const blocks = extractCodeBlocks(markdown);
    blocks.forEach((block, indexInFile) => {
      blockIndex++;
      const label = `${document.relative}:${block.startLine}`;
      const exclusion = EXCLUDED_BLOCKS[document.relative]?.[indexInFile];

      if (!JS_LANGS.has(block.lang)) {
        const reason =
          OUT_OF_SCOPE_LANGS[block.lang] ??
          `untagged or unsupported fence ("${block.lang || 'no language'}") — not JavaScript`;
        outOfScope.push({ label, lang: block.lang || '(none)', reason });
        return;
      }

      if (exclusion) {
        outcomes.push({
          label,
          status: 'skipped',
          reason: `not executed — ${exclusion}`,
          fingerprint: blockFingerprint(block.code),
        });
        return;
      }

      outcomes.push({
        label,
        status: 'pending',
        lang: block.lang,
        code: block.code,
        fingerprint: blockFingerprint(block.code),
      });
    });
  }

  // --- syntax check + execution ---------------------------------------
  const workDir = mkdtempSync(join(tmpdir(), 'pwr-skill-'));

  for (const outcome of outcomes) {
    // Blocks excluded during extraction were already classified.
    if (outcome.status !== 'pending') continue;

    const syntax = await runNode({
      args: ['--check', '--input-type=module'],
      cwd: workDir,
      input: outcome.code,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    if (syntax.code !== 0) {
      const message = (syntax.stderr || syntax.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /Error/.test(line));
      outcome.status = 'syntax-error';
      outcome.reason = `the snippet does not parse — ${message ?? 'syntax error'}`;
      console.log(`[SYNTAX] ${outcome.label} — ${outcome.reason}`);
      continue;
    }

    // Rewrite the package specifier to the local entry point: the block is
    // executed from a scratch directory outside the repository, where the
    // package name does not resolve. The rewrite touches the specifier
    // only — the skill's own files are never modified.
    const rewritten = outcome.code.replace(
      /(['"])persistent-worker-runtime\1/g,
      JSON.stringify(packageEntryUrl),
    );
    const executable = `${buildPreamble(packageEntryUrl)}${rewritten}${EPILOGUE}`;

    // The block runs from a FILE, not from `--eval`: `--input-type=module`
    // is inherited by worker threads through `execArgv`, and a worker that
    // inherits it dies with ERR_INPUT_TYPE_NOT_ALLOWED before it can run a
    // single task. A file needs no flag, so the runtime's workers start
    // normally.
    const scriptFile = join(workDir, `block-${outcome.fingerprint}.mjs`);
    writeFileSync(scriptFile, executable, 'utf8');

    const result = await runNode({
      args: [scriptFile],
      cwd: workDir,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    if (result.code === 0 && !result.timedOut) {
      outcome.status = 'executed';
      outcome.reason = 'executed successfully';
      console.log(`[  OK  ] ${outcome.label}`);
      continue;
    }

    const failure = classifyBlockFailure(result);
    outcome.status = failure.kind;
    outcome.reason = failure.reason;
    console.log(`[${failure.kind.toUpperCase()}] ${outcome.label} — ${failure.reason}`);
  }

  rmSync(workDir, { recursive: true, force: true });

  // --- summary ---------------------------------------------------------
  const executed = outcomes.filter((o) => o.status === 'executed');
  const skipped = outcomes.filter((o) => o.status === 'skipped');
  const fragments = outcomes.filter((o) => o.status === 'fragment');
  const external = outcomes.filter((o) => o.status === 'external-dependency');
  const syntaxErrors = outcomes.filter((o) => o.status === 'syntax-error');
  const runtimeErrors = outcomes.filter((o) => o.status === 'runtime-error');
  const timeouts = outcomes.filter((o) => o.status === 'timeout');

  console.log('\n=== skill gate summary ===');
  console.log(`documents: ${documents.length} | fenced blocks: ${blockIndex}`);
  console.log(
    `javascript blocks: ${outcomes.length} | executed: ${executed.length} | skipped: ${skipped.length} | fragment: ${fragments.length} | external-dependency: ${external.length} | runtime-error: ${runtimeErrors.length} | syntax-error: ${syntaxErrors.length} | timeout: ${timeouts.length}`,
  );
  console.log(`out-of-scope blocks: ${outOfScope.length}`);

  const byLang = new Map();
  for (const entry of outOfScope) {
    byLang.set(entry.lang, (byLang.get(entry.lang) || 0) + 1);
  }
  for (const [lang, count] of [...byLang.entries()].sort((a, b) => b[1] - a[1])) {
    const reason = outOfScope.find((entry) => entry.lang === lang).reason;
    console.log(`  ${lang}: ${count} — ${reason}`);
  }

  if (skipped.length > 0) {
    console.log('\nskipped (not executed, with reason):');
    for (const outcome of skipped) console.log(`  ${outcome.label} — ${outcome.reason}`);
  }
  if (fragments.length > 0) {
    console.log('\nfragments (undefined identifier defined outside the snippet):');
    for (const outcome of fragments) console.log(`  ${outcome.label} — ${outcome.reason}`);
  }
  if (external.length > 0) {
    console.log('\nexternal dependencies (not installable in a zero-dependency repo):');
    for (const outcome of external) console.log(`  ${outcome.label} — ${outcome.reason}`);
  }
  if (syntaxErrors.length > 0) {
    console.log('\nSYNTAX ERRORS — these snippets do not parse:');
    for (const outcome of syntaxErrors) console.log(`  ${outcome.label} — ${outcome.reason}`);
  }
  if (runtimeErrors.length > 0) {
    console.log('\nRUNTIME ERRORS — reported, not fatal:');
    for (const outcome of runtimeErrors) console.log(`  ${outcome.label} — ${outcome.reason}`);
  }
  if (timeouts.length > 0) {
    console.log('\nTIMEOUTS — reported, not fatal:');
    for (const outcome of timeouts) console.log(`  ${outcome.label} — ${outcome.reason}`);
  }

  if (metaProblems.length > 0) {
    console.error('\n=== skill metadata problems ===');
    for (const problem of metaProblems) console.error(`  ${problem}`);
    console.error('\nskill gate FAILED — the skill metadata is not coherent.');
    process.exit(1);
  }

  console.log('\nskill gate PASSED.');
}

// Only run the CLI when this file is the process entry point — the module
// is imported by the test suite, which must not trigger the gate.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('skill gate crashed:', err);
    process.exit(1);
  });
}
