/**
 * test/skill-gate-observation-window.test.js — the observation contract of
 * the skill gate (`scripts/validate-skill.js`).
 *
 * Why this file exists (feature `skill-gate-coverage`, ADR-0027): the gate
 * used to wait a single tick (50 ms) and then `process.exit(0)`. A defect
 * inside work the block DEFERS — a timer callback — fired after that tick
 * and was never observed. The shipped outbox pattern carried exactly that
 * defect class (issue 009: `p.outboxId`, where `p` is the worker-side
 * payload parameter) and the gate reported it as `OK`.
 *
 * The gate now keeps the event loop open for an OBSERVATION WINDOW when the
 * block left pending timer work behind. This suite pins the two halves of
 * that contract:
 *
 *  1. The window is charged ONLY to a block with pending timer work. Every
 *     other block keeps the 50 ms fast path, so the gate's wall-clock cost
 *     does not grow for the blocks that have nothing to defer. The gate
 *     reports how many blocks paid the window, and this suite checks that
 *     number against the blocks themselves.
 *  2. The detection uses `process.getActiveResourcesInfo()`, which reports
 *     the resources that are currently keeping the event loop alive. A
 *     worker runtime shows up as a `MessagePort`, NOT as a `Timeout` — so
 *     the ten-odd skill blocks that merely create a runtime must keep the
 *     fast path. A gate that counted "any active resource" would charge
 *     the window to every block in the skill.
 *
 * The fixtures live in this suite, not in the shipped skill: a future edit
 * to the skill must not be able to make this test pass by changing what the
 * test reads.
 *
 * Zero dependencies on purpose: ADR-0005 forbids external runtime
 * dependencies. This file uses nothing but `node:*` built-ins.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  FAST_PATH_DELAY_MS,
  OBSERVATION_WINDOW_MS,
  runSkillGate,
} from '../scripts/validate-skill.js';

const PACKAGE_ENTRY_URL = new URL('../src/index.js', import.meta.url).href;

/** The fixtures are written to disk, so they need a scratch directory. */
const workDir = mkdtempSync(join(tmpdir(), 'pwr-skill-gate-'));

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Writes a fixture skill whose only document holds the given blocks.
 *
 * @param {string} name Name of the fixture directory.
 * @param {string[]} codes The JavaScript blocks the fixture carries.
 * @returns {string} Absolute path of the fixture skill directory.
 */
function writeFixtureSkill(name, codes) {
  const skillDir = join(workDir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, '.skill-meta.json'),
    JSON.stringify({ name, triggers: ['fixture'], files: [] }, null, 2),
    'utf8',
  );
  const document = ['# Fixture skill', ''];
  for (const code of codes) {
    document.push('```javascript', code, '```', '');
  }
  writeFileSync(join(skillDir, 'SKILL.md'), document.join('\n'), 'utf8');
  return skillDir;
}

/**
 * Runs the gate over a fixture, silently.
 *
 * @param {string} skillDir Absolute path of the fixture skill directory.
 * @param {number} [observationWindowMs] The window to give the gate.
 * @returns {Promise<object>} The gate's result.
 */
function runFixture(skillDir, observationWindowMs = OBSERVATION_WINDOW_MS) {
  return runSkillGate({
    skillDir,
    packageEntryUrl: PACKAGE_ENTRY_URL,
    observationWindowMs,
    log: () => {},
  });
}

describe('the skill gate observation window', () => {
  it('charges the window only to a block that left pending timer work', async () => {
    const skillDir = writeFixtureSkill('timers', [
      [
        '// A block that defers work: the timer is still pending when the',
        '// harness looks for pending timer work.',
        'setTimeout(() => {',
        "  console.log('deferred');",
        '}, 1000);',
      ].join('\n'),
      ['// A block that defers nothing.', 'const value = 1;', 'console.log(value);'].join('\n'),
    ]);

    const { outcomes, summary } = await runFixture(skillDir);

    assert.equal(outcomes.length, 2);
    const [withTimer, withoutTimer] = outcomes;

    assert.equal(withTimer.paidWindow, true, 'the block with a timer pays the window');
    assert.equal(withTimer.delayMs, OBSERVATION_WINDOW_MS);

    assert.equal(withoutTimer.paidWindow, false, 'the block without a timer keeps the fast path');
    assert.equal(withoutTimer.delayMs, FAST_PATH_DELAY_MS);

    assert.equal(summary.paidWindow, 1);
    assert.equal(summary.fastPath, 1);
  });

  it('keeps the fast path for a block that merely creates a worker runtime', async () => {
    // A worker runtime registers a `MessagePort`, not a `Timeout`. The gate
    // must not read that as deferred work, or every skill block that
    // creates a runtime would pay the observation window.
    const skillDir = writeFixtureSkill('runtime', [
      [
        "import { createWorkerRuntime } from 'persistent-worker-runtime';",
        '',
        'const runtime = await createWorkerRuntime({ workers: 1 });',
        'console.log(typeof runtime.dispatch);',
        'await runtime.shutdown();',
      ].join('\n'),
    ]);
    const { outcomes, summary } = await runFixture(skillDir);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, 'executed');
    assert.equal(outcomes[0].paidWindow, false);
    assert.equal(outcomes[0].delayMs, FAST_PATH_DELAY_MS);
    assert.equal(summary.paidWindow, 0);
    assert.equal(summary.fastPath, 1);
  });

  it("does not let the harness timer count as the block's own deferred work", async () => {
    // The harness schedules its own wait AFTER the pending-timer check. If
    // the order were reversed, the harness timer would be a pending
    // `Timeout` and every block would look like it had deferred work.
    const skillDir = writeFixtureSkill('fast-path', ['console.log("nothing deferred");']);

    const { outcomes } = await runFixture(skillDir);

    assert.equal(outcomes[0].status, 'executed');
    assert.equal(outcomes[0].delayMs, FAST_PATH_DELAY_MS);
    assert.equal(outcomes[0].paidWindow, false);
  });

  it('reports the cost of the window in its summary', async () => {
    const skillDir = writeFixtureSkill('summary', [
      ['setInterval(() => {}, 1000);', "console.log('ticking');"].join('\n'),
    ]);

    const { summary } = await runFixture(skillDir);

    assert.equal(summary.paidWindow, 1);
    assert.equal(summary.observationWindowMs, OBSERVATION_WINDOW_MS);
  });
});

// ─── What the gate did NOT observe ─────────────────────────────────────────
//
// A report is not a validation. The gate has to say which blocks it actually
// looked at, because a block that died on an unresolvable import reports
// just as loudly as a block that ran — and a defect inside the former is
// invisible to the gate.

describe('the skill gate report of the blocks it did not observe', () => {
  it('says that an external-dependency block never ran its body', async () => {
    const skillDir = writeFixtureSkill('external', [
      [
        "import express from 'express';",
        '',
        'const app = express();',
        'console.log(typeof app);',
      ].join('\n'),
    ]);

    const { outcomes, summary } = await runFixture(skillDir);

    assert.equal(outcomes[0].status, 'external-dependency');
    assert.match(outcomes[0].reason, /body was NOT executed/);
    assert.match(outcomes[0].reason, /invisible to the gate/);

    assert.equal(outcomes[0].observed, false);
    assert.equal(summary.notObserved, 1);
    assert.equal(summary.notObservedByStatus['external-dependency'], 1);
    assert.equal(summary.observed, 0);
  });

  it('counts the blocks it did not observe and says why', async () => {
    const skillDir = writeFixtureSkill('not-observed', [
      ["import express from 'express';", "console.log('never runs');"].join('\n'),
      ['const value = 1;', 'console.log(value);'].join('\n'),
    ]);

    const { summary } = await runFixture(skillDir);

    // One block ran, one never did.
    assert.equal(summary.observed, 1);
    assert.equal(summary.notObserved, 1);
    assert.deepEqual(summary.notObservedByStatus, { 'external-dependency': 1 });
  });

  it('does not claim a block never ran when its body did run', async () => {
    // A dynamic import fails INSIDE the body: the body ran, and the gate
    // cannot validate the code after the failure. The report must not claim
    // the opposite — that would be a lie in the other direction.
    const skillDir = writeFixtureSkill('dynamic-import', [
      [
        "const { join } = await import('node:path');",
        "console.log(join('a', 'b'));",
        "await import('definitely-not-installed');",
      ].join('\n'),
    ]);

    const { outcomes, summary } = await runFixture(skillDir);

    assert.equal(outcomes[0].status, 'external-dependency');
    assert.doesNotMatch(outcomes[0].reason, /body was NOT executed/);
    assert.match(outcomes[0].reason, /body ran up to the failure/);
    assert.equal(outcomes[0].observed, true);
    assert.equal(summary.notObserved, 0);
  });
});
