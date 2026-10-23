/**
 * Runs a Node.js child process under a hard wall-clock budget.
 *
 * Shared by the two CI gates in this directory (`run-examples.js` and
 * `validate-skill.js`). Both need the same three guarantees:
 *
 *  1. A timeout that actually kills the child — a gate that hangs is worse
 *     than a gate that fails, because it burns the whole CI job.
 *  2. The child's stdout/stderr captured verbatim, so the gate can report
 *     *why* something failed instead of just "it failed".
 *  3. No shell. Arguments are passed as an array, so a path containing a
 *     space or a quote cannot change the meaning of the command line.
 *
 * Zero dependencies: `node:child_process` only.
 */

import { spawn } from 'node:child_process';

/**
 * @typedef {object} RunResult
 * @property {number|null} code Exit code (`null` when the child was killed).
 * @property {string|null} signal Terminating signal, when the child was killed.
 * @property {boolean} timedOut True when the wall-clock budget was exceeded.
 * @property {string} stdout Captured standard output.
 * @property {string} stderr Captured standard error.
 * @property {number} durationMs Wall-clock duration of the child.
 */

/**
 * @param {object} options
 * @param {string[]} options.args Arguments passed to `process.execPath`.
 * @param {string} [options.cwd] Working directory for the child.
 * @param {Record<string, string>} [options.env] Environment overrides.
 * @param {number} options.timeoutMs Wall-clock budget before the child is killed.
 * @param {string} [options.input] Written to the child's standard input, then closed.
 * @returns {Promise<RunResult>}
 */
export function runNode({ args, cwd, env, timeoutMs, input }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // `windowsHide` keeps the CI log free of console windows on Windows.
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    // Kill the whole process tree on timeout. `SIGKILL` maps to
    // TerminateProcess on Windows and to an uncatchable kill on POSIX, so a
    // child that ignores SIGTERM still dies.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        timedOut,
        stdout,
        stderr: `${stderr}${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr, durationMs: Date.now() - startedAt });
    });

    if (typeof input === 'string') {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}
