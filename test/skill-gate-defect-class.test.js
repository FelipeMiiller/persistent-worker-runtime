/**
 * test/skill-gate-defect-class.test.js — the regression test for the defect
 * class of issue 009.
 *
 * Why this file exists: the shipped skill's outbox pattern read `p.outboxId`
 * in its completion handler, where `p` is the WORKER-SIDE payload parameter
 * of the task function — an identifier that does not exist in the scope of
 * the handler that reads it. The defect reached the published npm package,
 * and the skill gate reported the block as `OK`.
 *
 * Two independent masks hid it, and the gate has to close both:
 *
 *  1. The import mask — the block began with `import express from
 *     'express'`, and ESM resolves every static import BEFORE the module
 *     body runs. The block body never executed.
 *  2. The observation mask — the harness epilogue waited one tick (50 ms)
 *     and called `process.exit(0)`. The defect lives in a timer callback
 *     that fires at 1000 ms, so it was never observed. This mask is the
 *     load-bearing one: the defect passes the old gate even with the import
 *     mask removed.
 *
 * THE NON-VACUITY PROOF: the same fixture is run twice — once with the
 * observation window, once without it. The defect must be reported with the
 * window and MUST NOT be reported without it. A test that passes both ways
 * proves nothing; this one fails if the window stops being load-bearing.
 *
 * The fixtures belong to this suite, not to the shipped skill: a future edit
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
import { OBSERVATION_WINDOW_MS, runSkillGate } from '../scripts/validate-skill.js';

const PACKAGE_ENTRY_URL = new URL('../src/index.js', import.meta.url).href;

/** The fixtures are written to disk, so they need a scratch directory. */
const workDir = mkdtempSync(join(tmpdir(), 'pwr-skill-defect-'));

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Writes a fixture skill whose only document holds one JavaScript block.
 *
 * @param {string} name Name of the fixture directory.
 * @param {string} code The JavaScript block the fixture carries.
 * @returns {string} Absolute path of the fixture skill directory.
 */
function writeFixtureSkill(name, code) {
  const skillDir = join(workDir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, '.skill-meta.json'),
    JSON.stringify({ name, triggers: ['fixture'], files: [] }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    ['# Fixture skill', '', '```javascript', code, '```', ''].join('\n'),
    'utf8',
  );
  return skillDir;
}

/**
 * Runs the gate over a fixture, silently.
 *
 * @param {string} skillDir Absolute path of the fixture skill directory.
 * @param {number} observationWindowMs The window to give the gate. `0` is the
 *   pre-fix behaviour: the harness waits one tick and exits.
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

/**
 * The defect class of issue 009, with the timer that makes it DEFERRED.
 *
 * `p` is bound as the parameter of the task function `fn`. The completion
 * handler `onComplete` is a SIBLING of `fn` and reads `p` — an identifier
 * that does not exist in its scope. The handler runs one second later, the
 * way the shipped outbox pattern's drain runs, so the failure lands inside
 * the block's deferred work.
 *
 * @param {string} reference The identifier the handler reads.
 * @returns {string} The fixture's source code.
 */
function deferredDefect(reference) {
  return [
    '// The task function: `p` is the worker-side payload parameter.',
    'const fn = async (p) => p.email;',
    '',
    '// The completion handler: a SIBLING of `fn`. It reads `p`, which is',
    '// bound only inside `fn`.',
    'const onComplete = async () => {',
    `  console.log(${reference}.outboxId);`,
    '};',
    '',
    '// The handler runs one second later, the way the shipped outbox',
    "// pattern's drain does.",
    'setTimeout(onComplete, 1000);',
  ].join('\n');
}

describe('the issue-009 defect class', () => {
  it("flags a defect inside a block's deferred work as a fragment", async () => {
    const skillDir = writeFixtureSkill('buggy', deferredDefect('p'));

    const { outcomes } = await runFixture(skillDir);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, 'fragment');
    assert.match(outcomes[0].reason, /undefined identifier "p"/);
    assert.equal(outcomes[0].observed, true);
  });

  it('does NOT flag the same defect when the observation window is disabled', async () => {
    // THE NON-VACUITY PROOF. Without the window the harness waits one tick
    // (50 ms) and exits; the timer fires at 1000 ms, so the defect is never
    // observed and the block passes. That is the pre-fix behaviour, and the
    // difference between the two runs is what makes the window load-bearing
    // rather than an incidental change.
    const skillDir = writeFixtureSkill('buggy-window-off', deferredDefect('p'));

    const { outcomes } = await runFixture(skillDir, 0);

    assert.equal(outcomes.length, 1);
    assert.equal(
      outcomes[0].status,
      'executed',
      `the defect must NOT be reported without the observation window, but the gate said "${outcomes[0].status}" (${outcomes[0].reason})`,
    );
  });

  it('accepts the corrected pattern, with and without the window', async () => {
    // The fix of issue 009: the handler reads the OUTBOX ROW, not the
    // worker-side payload parameter.
    const skillDir = writeFixtureSkill(
      'fixed',
      deferredDefect('row').replace(
        'const onComplete = async () => {',
        'const row = { id: 7 };\nconst onComplete = async () => {',
      ),
    );

    const withWindow = await runFixture(skillDir);
    const withoutWindow = await runFixture(skillDir, 0);

    assert.equal(withWindow.outcomes[0].status, 'executed');
    assert.equal(withoutWindow.outcomes[0].status, 'executed');
  });

  it('flags the defect in the shape the shipped outbox pattern uses', async () => {
    // The real thing: a dispatched task whose completion handler reads the
    // worker-side payload parameter. The handler's rejection is not caught
    // by the runtime — it surfaces as an unhandled rejection, which takes
    // the child down and lets the classifier see it.
    const skillDir = writeFixtureSkill(
      'dispatched',
      [
        "import { createWorkerRuntime } from 'persistent-worker-runtime';",
        '',
        'const runtime = await createWorkerRuntime({ workers: 1 });',
        '',
        '// The task function: `p` is the worker-side payload parameter.',
        'const fn = async (p) => p.email;',
        '',
        'setTimeout(() => {',
        '  const handle = runtime.dispatch({',
        "    type: 'send_welcome_email',",
        "    payload: { email: 'ada@example.com', outboxId: 7 },",
        '    fn,',
        '  });',
        '  handle.onComplete(async () => {',
        '    console.log(p.outboxId);',
        '  });',
        '}, 1000);',
      ].join('\n'),
    );

    const { outcomes } = await runFixture(skillDir);

    assert.equal(outcomes[0].status, 'fragment');
    assert.match(outcomes[0].reason, /undefined identifier "p"/);
  });

  it('flags the same defect in the dispatched shape without the window', async () => {
    // The companion of the non-vacuity proof: without the window the
    // dispatched shape must NOT be reported either.
    const skillDir = writeFixtureSkill(
      'dispatched-window-off',
      [
        "import { createWorkerRuntime } from 'persistent-worker-runtime';",
        '',
        'const runtime = await createWorkerRuntime({ workers: 1 });',
        '',
        'const fn = async (p) => p.email;',
        '',
        'setTimeout(() => {',
        '  const handle = runtime.dispatch({',
        "    type: 'send_welcome_email',",
        "    payload: { email: 'ada@example.com', outboxId: 7 },",
        '    fn,',
        '  });',
        '  handle.onComplete(async () => {',
        '    console.log(p.outboxId);',
        '  });',
        '}, 1000);',
      ].join('\n'),
    );

    const { outcomes } = await runFixture(skillDir, 0);

    assert.equal(outcomes[0].status, 'executed');
  });
});
