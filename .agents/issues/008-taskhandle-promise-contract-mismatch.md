# `TaskHandle.promise` is documented as internally `.catch()`-handled — and it is not

**Status**: 🔴 **OPEN** — a documented contract does not hold. Needs a decision: change the code or
change the contract (the second touches an accepted ADR).

**Discovered**: 2026-10-23, during the audit of the Node 26 / execution-gate work
(issue 004 and issue 006), surfaced by the D3 failure of the skill gate.
**Component**: `src/worker-runtime.js`, `src/task-handle.js`, `docs/adr/0018-*.md`,
`skills/persistent-worker-runtime/references/observability.md`

## The claim

`src/worker-runtime.js:942-943` — the `dispatch()` JSDoc:

> - `.promise` (already `.catch()`-handled internally by the handle, so
>   unhandled-rejection warnings do not fire on legitimate cleanup)

and `src/worker-runtime.js:924`:

> with `onComplete` / `onError` and an internally-captured `.promise.catch()`.

`docs/adr/0018-fire-and-forget-hazard-with-execute-and-post-shutdown-flakes.md` (§Architectural
Mechanics, L122-124) makes the same claim and **builds the accepted decision on it**:

> - If you intentionally want fire-and-forget semantics, use `dispatch()` ...
>   `.promise` (which has `.catch()` attached internally by the handle).

ADR-0018 chose **Option 3** (L62): *"Document the hazard + harden the existing API surface"* — no
runtime change — and states at L74 that *"the hazard is already eliminated by `dispatch()` existing"*.
Both halves of that reasoning assume the internal catch exists.

## The reality

1. `src/task-handle.js` contains **zero** `.catch(` occurrences. The promise is created at
   `src/task-handle.js:115` and returned to the caller untouched:

   ```js
   this.promise = new Promise((resolve, reject) => {
     this._resolve = resolve;
     this._reject = reject;
   });
   ```

2. The only `.catch()` in `dispatch()` is on the **enqueue** promise, not on the handle's promise
   (`src/worker-runtime.js:995-1002`):

   ```js
   this.#queue.enqueue(task).then(() => { this.#scheduleNext(); })
                 .catch((_err) => { /* Handled via task.reject() inside queue */ });
   ```

3. The same file **contradicts itself** 30 lines earlier, in `execute()`'s JSDoc
   (`src/worker-runtime.js:912-914`):

   > **Important**: the returned Promise MUST be awaited, `.then()`/`.catch()`-handled, ... without
   > `await` (or without attaching `.catch()`) leaves the worker vulnerable

## Why it is not academic

The failure is observable and it kills the user's process. The new skill gate caught it on its
first run (`references/quickstart.md:129`, the D3 defect):

- a `dispatch()`ed task is still queued when `shutdown()` runs;
- `runtime.shutdown()` calls `this.#queue.destroy(new WorkerRuntimeError('Runtime is shutting down'))`
  (`src/worker-runtime.js:1327`), and `queue.destroy()` **rejects** every queued task
  (`src/task-queue.js`: `task.reject(reason)` for each waiter and each queued task);
- the rejected `handle.promise` has no handler → **unhandled rejection → the process exits 1**.

A user who follows the shipped documentation ("safe, no unhandled-rejection warnings") and calls
`shutdown()` gets a crashed process. The documentation does not merely fail to warn — it actively
promises the opposite of the truth, and following it breaks the app.

The skill's own recommended outbox pattern does not save you either: `onError` registers a
**callback**, but it does not mark the promise as handled
(`skills/persistent-worker-runtime/references/observability.md:58-64`).

## The two options (this is the decision)

### Option A — implement the internal catch (restore the ADR's premise)

Attach a no-op handler to the handle's promise inside `dispatch()` (or in `TaskHandle`), so
fire-and-forget is genuinely safe, exactly as the JSDoc and ADR-0018 already describe.

- **Pro**: makes the implementation match the published contract; no user code changes; the ADR's
  reasoning ("the hazard is already eliminated by `dispatch()`") becomes true.
- **Con**: it is a **behaviour change** on a documented API — rejections that currently surface as
  unhandled rejections would be silently swallowed. ADR-0018 explicitly rejected that shape for
  `execute()` (Option 1, L60: *"masks genuine bugs"*), but said nothing about `dispatch()`, whose
  entire purpose is fire-and-forget.
- **Cost**: small code change + tests, but it needs an ADR (the repo's rule: every lifecycle or
  concurrency-pattern change gets a MADR record).

### Option B — make the documentation tell the truth

Correct the `dispatch()` JSDoc, amend ADR-0018's §Architectural Mechanics (and the L74 premise),
and make the shipped skill say that the caller must handle `handle.promise` — including in the
outbox pattern.

- **Pro**: no behaviour change; the docs stop lying.
- **Con**: `dispatch()` stops being "fire-and-forget safe" in practice, which weakens the API's
  headline ergonomics; every user hits the footgun the runtime could have absorbed.

### Recommendation

**Option A**, with the swallowing made *observable* rather than silent: attach the internal handler
but keep the rejection reachable through `onError` (which already exists) and document that
fire-and-forget tasks report failures through `onError`, not through the promise. That satisfies
ADR-0018's rejection of Option 1 (no masking) while making the published contract true. It still
needs an ADR, because it changes what a rejected fire-and-forget task does.

Option B is the honest fallback if the project prefers zero behaviour change — but then the
`dispatch()` JSDoc, ADR-0018 and the shipped skill must all be corrected together, and the skill
gate must gain a case that asserts a fire-and-forget `dispatch()` **does** produce an unhandled
rejection.

## Prevention

- **A documented contract is a testable claim.** "`.promise` is already `.catch()`-handled
  internally" is a behavioural promise; it needed a test, not a paragraph. The skill gate now
  catches the *symptom* (a crashing snippet); nothing yet asserts the *contract*.
- **An ADR that justifies a decision with an implementation claim inherits that claim's fate.**
  ADR-0018 reasoned from "dispatch() is safe" without the code doing it. When an ADR's premise is
  an implementation detail, the premise needs its own test.
- **`onError` is not `.catch()`.** A callback and a rejection handler are different things; the
  outbox pattern in the skill conflates them.
