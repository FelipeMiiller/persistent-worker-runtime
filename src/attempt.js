/**
 * attempt — Go-style multi-return error handling for asynchronous work.
 *
 * The Go idiom `v, err := doSomething()` returns the error INSTEAD of
 * throwing it, so the caller decides what to do with it. JavaScript has no
 * multi-return, so the idiomatic translation is a two-element tuple:
 *
 * ```js
 * const [err, value] = await attempt(() => runtime.execute({ type: 'x' }));
 * if (err) {
 *   // Handle the error locally — no try/catch nesting.
 *   return [new Error(`Falha no worker: ${err.message}`), null];
 * }
 * ```
 *
 * This is the "Erros Multi-Retorno" half of ADR-0026: it removes the
 * `try/catch` nesting around a promise without changing WHAT the caller sees.
 *
 * Contract (ADR-0026):
 *
 *   - it NEVER throws and NEVER rejects — the error is RETURNED, not
 *     propagated;
 *   - success → `[null, value]`;
 *   - failure → `[error, undefined]`;
 *   - the ORIGINAL error object is preserved — same identity, same `cause`,
 *     same `stack`. Nothing is wrapped, so `err === thrownError` holds;
 *   - `error` is `null` on success (the analogue of Go's `nil`), never
 *     `undefined`, so `if (err)` is the only check a caller needs;
 *   - a resolved `undefined` value is NOT an error: `attempt` returns
 *     `[null, undefined]`.
 *
 * The input may be a thunk (`() => T | Promise<T>`) or a promise directly.
 * The thunk form is the faithful mapping of Go's `v, err := doSomething()`:
 * it also captures a SYNCHRONOUS throw, which a bare promise cannot — a
 * function that throws before returning a promise would otherwise escape the
 * helper.
 *
 * Zero dependencies, pure vanilla JS (ADR-0005).
 *
 * @template T
 * @param {(() => T | Promise<T>) | Promise<T>} input A thunk or a promise.
 * @returns {Promise<[null, T] | [Error, undefined]>} The result tuple.
 */
export async function attempt(input) {
  try {
    // `typeof input === 'function'` selects the thunk form. `await` covers
    // both shapes: a promise, and the promise a thunk returns.
    const value = typeof input === 'function' ? await input() : await input;
    return [null, value];
  } catch (error) {
    // The caught value is returned AS-IS. A rejection with a non-Error value
    // (`Promise.reject('boom')`) is forwarded unchanged — wrapping it would
    // lose the original value, and the ADR-0026 contract is "no wrapping".
    return [error, undefined];
  }
}
