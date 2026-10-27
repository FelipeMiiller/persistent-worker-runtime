# The preemption-latency assertion bounded below the mechanism's own ceiling

**Status**: ✅ **FIXED** 2026-10-27.

**Discovered**: 2026-10-27, in CI run `40536778188` (the v0.4.0 release candidate).
**Component**: `test/watchdog-poll-interval.test.js` (HARDEN-10 / ADR-0024 D2)
**Symptom**: on the `Test on Node 26.x (macos-latest)` leg,
`AssertionError: preemption fired at 402ms — expected < 400ms` — a **2 ms** overshoot. The
other nine legs, including `Node 22.x / Node 24.x (macos-latest)`, passed the same suite.

## Root cause

The assertion bounded the wrong quantity against a threshold **below the mechanism's own
ceiling**.

`src/supervisor.js:990-991` is the whole mechanism:

```javascript
const elapsedMs = performance.now() - task.startedAt;
if (elapsedMs < this.#workerPollIntervalMs) return;
```

The supervisor preempts on the first poll tick that **observes** `elapsed >= workerPollIntervalMs`.
The task's start phase inside the poll cycle is arbitrary, so the preemption lands anywhere in
**(pollInterval, 2 × pollInterval]**: a tick that fires a hair before the interval has elapsed does
not observe it, and the **next** tick fires.

The test asserted `elapsed < 400` — with `workerPollIntervalMs: 200`, that is **exactly
2 × pollInterval**, the mechanism's ceiling, with zero margin. The ceiling is not a value the
mechanism can beat; it is the value the mechanism *converges to* whenever the task starts just
after a tick.

Measured on 2026-10-27, 25 consecutive runs on an idle host:

```
n=25  min=356  p50=360  p90=365  max=373      (mechanism ceiling = 400 ms)
```

Every sample was in the second-tick band, and the widest gap to the ceiling was 27 ms. The
assertion therefore had **~40 ms of headroom on a machine that was not even loaded** — and a
loaded macOS runner pushed the sample 2 ms past a boundary that had no margin in the first place.

**It was not a regression in the runtime.** The preemption fired when it should have; the
*assertion* was wrong. The same suite passed on the macOS legs of the previous CI run.

## The fix

The bound is now derived from the mechanism's range plus a stated margin:

- **Upper**: `2 × workerPollIntervalMs + 75% of workerPollIntervalMs` (550 ms at the 200 ms
  interval) — the mechanism's ceiling plus the detection overhead (the IPC round trip and the
  terminate) and a scheduling margin for a loaded runner.
- **Lower**: `workerPollIntervalMs − 12.5%` (175 ms) — the earliest possible preemption is one
  tick, with a tolerance for the supervisor measuring with `performance.now()` (monotonic) while
  the test measures with `Date.now()` (wall clock); the two can disagree by a few milliseconds.

The test's header comment claimed the contract *"preemption fires within `workerPollIntervalMs +
50 ms` after the runaway is detected by the poll"*. ADR-0024 does not say that: D2 and BC-2 say
the supervisor preempts **at the `workerPollIntervalMs` cadence**, decoupled from `task.timeoutMs`.
The `+ 50 ms` figure applied to the detection→preemption latency, which is not what the test
measured — it measured task-start→preemption, which additionally includes the wait for the tick.
Both the header comment and the assertion now state the contract the mechanism actually has.

## The bound keeps its power

Verified, not assumed: with a **slower** watchdog (`workerPollIntervalMs: 1000` — the shape of
the regression this test guards) the preemption landed at **1966 ms**, so the assertion still
fails. The pre-HARDEN-10 behaviour was to wait for `timeoutMs` (60 s) — two orders of magnitude
past the bound. The new bound is 550 ms, which keeps the test's power intact while sitting above
the mechanism's ceiling.

The test was also run **10 consecutive times** on an idle host after the fix: 10/10 pass.

## Prevention

- **An assertion must not bound a mechanism below its own ceiling.** When the rule is
  "fires on the next tick", the ceiling is two ticks, and a threshold at the ceiling is a
  guaranteed flake — the only question is how many samples it takes to expose.
- **State the noise floor before setting a timing threshold.** The measurement (25 runs, 356-373 ms)
  is what showed the old bound had ~40 ms of headroom on an *idle* host; without it, the only
  visible fact is "it failed once, by 2 ms", which looks like noise and invites a blind bump.
  This is the same rule the benchmark gates follow: an assertion that cannot distinguish signal
  from its own noise floor is a flaky gate by construction.
- **Check the sibling legs before blaming the platform.** The macOS legs of Node 22.x and 24.x
  passed in the same run; the variance was in the runner's load, not in the OS.
- **A test that cites an acceptance criterion must cite it accurately.** The header cited
  "AC4 — within `workerPollIntervalMs + 50 ms`", a number that applied to a different quantity
  than the one being measured. The citation is what carried the wrong expectation into the code.
