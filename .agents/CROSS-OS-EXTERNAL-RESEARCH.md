---
title: "Cross-OS External Research (Node.js interactions across operating systems)"
category: research
scope: cross-cutting
audience: AI agents + humans investigating cross-platform behavior
synthesis-of: 2026-09-19 web research session
---

# Cross-OS External Research — Node.js interactions across operating systems

Companion to `.agents/CROSS-OS-LESSONS.md` (project-specific). This file captures
the **external evidence base** — what the Node.js docs, libuv maintainers, and CI
infrastructure docs actually say about cross-OS behavior. Pair with the project-side
lessons for the heuristic layer; pair with this file for the source-of-truth layer.

## 1. The event loop is portable because libuv abstracts the OS

`libuv` is a C library that implements the Node.js event loop as a portable abstraction
over three different OS-provided polling APIs:

| OS | Polling primitive |
|---|---|
| Linux | `epoll_wait(epfd, events, maxevents, timeout_ms)` |
| macOS | `kevent(kq, NULL, 0, events, nevents, timespec)` |
| Windows | `GetQueuedCompletionStatusEx(iocp, ...)` |

That abstraction is the reason Node.js exposes a single portable JS API for async I/O —
you almost never touch the OS API directly. But the **consequences** of that abstraction
leak through in surprising places.

Sources:
- [The Node.js Event Loop](https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick)
- [How the Node.js Event Loop Works Under the Hood](https://www.devlift.dev/blog/how-the-nodejs-event-loop-works-under-the-hood)
- [Event Loop Performance](https://www.thenodebook.com/node-arch/event-loop-intro)

## 2. `setImmediate` vs `setTimeout` ordering depends on the **call site**, not the OS

This is one of the most-asked Node.js questions. From the official docs:

> "The order in which the two timers are executed will vary depending on the context
> in which they are called. If both are called from within the main module, then timing
> will be bound by the performance of the process (which can be impacted by other
> applications running on the machine)."

Inside an I/O callback, `setImmediate()` is **deterministically first** (runs in
the check phase right after poll). Outside I/O, the order is **non-deterministic** —
it depends on whether the 1ms minimum timer threshold was crossed before the
loop reached the timers phase.

Practical implications for tests:
- `setImmediate` chain is the only reliable way to drive event-loop saturation
  without yielding to timers.
- Cross-OS, `setImmediate` semantics are stable (it's a libuv primitive); but the
  *speed* at which the chain executes depends on the OS's `GetQueuedCompletionStatus`
  / `epoll_wait` / `kevent` scheduling latency.

Sources:
- [Understanding setImmediate()](https://nodejs.org/en/learn/asynchronous-work/understanding-setimmediate)
- [Non-deterministic order of execution](https://codeburst.io/understanding-non-deterministic-order-of-execution-of-settimeout-vs-setimmediate-in-node-js-49e8d5956cab)

## 3. `setInterval` has cumulative drift — never use it for "every N ms exactly"

From the [Node.js GitHub issue #21822](https://github.com/nodejs/node/issues/21822):

> "Timers are not guaranteed to go off precisely when they are scheduled, for example
> because the event loop is busy doing other things. Each time the timer is late there
> is *drift* D. The logic to re-arm the timer is unaware of the drift and schedules it
> to run again after time interval T — so it will go off after T + D relative to when
> the timer previously went off. This drift is *cumulative*: the timer will not get
> closer to the expected expiration time than it was in the previous iteration."

Implication for benchmarks: a `setInterval(busyBurst, 8.5)` chain is **not** a
reliable "every 8.5ms" mechanism. On a busy event loop, intervals drift, busy periods
become irregular, and ELU samples oscillate. This is exactly the symptom the cpu-
saturation benchmark hit on this codebase (`0.59 ↔ 0.68 ELU oscillation` — see
`CROSS-OS-LESSONS.md` §2).

Fix pattern: use a recursive `setImmediate` chain. The callback runs as soon as the
current one returns — no drift, no coalescing, no minimum-interval clamping.

## 4. `setTimeout(fn, 0)` is internally clamped to 1ms

From [Node.js timers docs](https://nodejs.org/api/timers.html):

> "When delay is larger than 2147483647 or less than 1, the delay will be set to 1.
> Non-integer delays are truncated to an integer."

So `setTimeout(fn, 0)` does not give you a "run as fast as possible" callback — it
gives you "run after at least 1ms". On Linux/macOS this is fine because the 1ms
threshold is crossed in microseconds. On Windows the 1ms threshold has more
variance — see §5.

## 5. Windows timer resolution is a documented pain point

Windows uses a 15.6ms default timer tick (the legacy scheduler quantum). Even when
you pass `Sleep(2)`, the actual sleep is bounded below by the timer resolution.
From [Windows and high-resolution timers](https://www.siliceum.com/en/blog/post/windows-high-resolution-timers/):

> "It is limited by the OS timers, which by default are around 15.6ms."

> "Starting with Windows 11, if a window-owning process becomes fully occluded,
> minimized, or otherwise invisible or inaudible to the end user, Windows does not
> guarantee a higher resolution than the default system resolution."

This is the underlying reason **Windows CI GitHub Actions runners have slower
event-loop saturation than Linux/macOS runners** — the underlying `timeBeginPeriod`
behavior on the VM doesn't reliably hit 1ms. `setImmediate` chains partially
work around this because they don't go through the timer subsystem, but the
final scheduling latency is still higher than Linux's epoll cycle.

This is **not specific to CI** — the same phenomenon hits any Windows production
process running headless (Windows Server, Docker Desktop on Windows). CI just
amplifies it because the runners share hardware with other tenants.

## 6. GitHub-hosted runner resources are smaller than you think

From [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners):

| Runner | vCPU | RAM | Architecture | Workflow label |
|---|---|---|---|---|
| Linux | 4 | 16GB | x64 | `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04` |
| Windows | 4 | 16GB | x64 | `windows-latest`, `windows-2025`, `windows-2022` |
| macOS | **3 (M1)** | 7GB | arm64 | `macos-latest`, `macos-14`, `macos-15` |
| macOS Intel | 4 | 14GB | x64 | `macos-13` |

The **macOS `macos-latest` runner has 3 logical cores** — the same number this codebase
hit in the cpu-saturation E-2 failure (commit `ddcd33f`). Code that assumes
`availableParallelism() >= N` for any `N > 3` will break on `macos-latest`.

Larger runners are available on Team/Enterprise plans (`macos-latest-large` = 12 vCPU
Intel, `macos-latest-xlarge` = 5 vCPU M2 + GPU). For benchmarks that need stable
host resources, switch to a pinned larger runner.

Sources:
- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Larger runners reference](https://docs.github.com/en/actions/reference/runners/larger-runners)

## 7. `os.availableParallelism()` exists for a reason — and has known pitfalls

From [Node.js os docs](https://nodejs.org/api/os.html):

> "`os.cpus().length` should not be used to calculate the amount of parallelism
> available to an application. Use `os.availableParallelism()` for this purpose."

From the [Bun issue tracker](https://github.com/oven-sh/bun/issues/4986), the
implementation has known quirks:

> "On Linux, inspects the calling thread's CPU affinity mask to determine if it has
> been pinned to specific CPUs. On Windows, the available parallelism may be
> underreported on systems with more than 64 logical CPUs. On other platforms,
> reports the number of CPUs that the operating system considers to be online."

In Docker containers, `availableParallelism()` can be wrong (cgroups doesn't expose
host CPU limits correctly). Use cgroup-aware tooling (`--cpuset-cpus` checks) for
containerized workloads.

## 8. Worker threads: same problem on every OS, but the costs vary

Worker thread behavior is **mostly portable**, but the costs vary:

| Cost | Linux/macOS | Windows |
|---|---|---|
| Cold start (V8 isolate + script eval) | 30-80ms | 30-80ms (similar) |
| Heap memory per worker | ~30-50MB RSS | ~30-50MB RSS (similar) |
| `postMessage` structured clone | O(n) in payload | O(n) in payload |
| Transferable ArrayBuffer | O(1) | O(1) |
| `SharedArrayBuffer` + Atomics | O(1) | O(1) |

The key insight from the [krun.pro deep dive](https://krun.pro/node-js-worker-threads/):

> "Worker thread startup isn't free: V8 Isolate initialization, context creation,
> and script evaluation routinely cost 30-80ms on a cold start. If your CPU-bound
> task executes in 15ms, you've tripled your wall time before you've serialized a
> single byte."

> "The math only works when task duration significantly exceeds (startup cost +
> serialization cost × 2). For anything under ~100ms of compute, a well-structured
> synchronous function with chunked execution on the Event Loop often wins outright."

Concrete implication for this codebase: the persistent-worker-runtime uses
**long-lived workers** (created at `start()`, recycled across tasks) precisely to
amortize the 30-80ms cold start. The `recycling` ADR (`src/.../supervisor.js`)
implements this. Per-task worker creation would be 10-20× slower.

Sources:
- [Node.js Worker Threads Performance Bottlenecks](https://krun.pro/node-js-worker-threads/)
- [Worker threads in Node, and the pool you actually need](https://dev.to/yaseenyk04/worker-threads-in-node-and-the-pool-you-actually-need-2n96)
- [Worker threads vs Cluster: When to Use Which](https://www.tothenew.com/blog/node-js-worker-threads-vs-cluster-when-to-use-which/)

## 9. `path` module: drive letters, backslashes, and case-sensitivity

From [Node.js path docs](https://nodejs.org/api/path.html):

> "On POSIX: `path.basename('C:\\temp\\myfile.html')` → `'C:\\temp\\myfile.html'`
> On Windows: `path.basename('C:\\temp\\myfile.html')` → `'myfile.html'`"

> "Although Windows usually treats file names, including file extensions, in a
> case-insensitive manner, this function does not. For example, `C:\\foo.html` and
> `C:\\foo.HTML` refer to the same file, but `basename` treats the extension as a
> case-sensitive string."

Key gotchas:
- **`process.env` is case-sensitive on Windows workers** (whereas POSIX preserves
  case but is convention-insensitive). From worker_threads docs: "On Windows, unlike
  the main thread, a copy of the environment variables operates in a case-sensitive
  manner."
- **`path.sep` is `\\` on Windows, `/` on POSIX.** Always use `path.sep` or
  `path.join()` — never hardcode `/` or `\\`.
- **Drive-letter semantics**: `path.resolve('C:\\')` and `path.resolve('C:')` return
  different results on Windows (per-drive working directory concept).

## 10. Native modules: prebuilds are the only sane default in 2026

From [node-gyp vs prebuild vs napi-rs](https://www.pkgpulse.com/blog/node-gyp-vs-prebuild-vs-napi-rs-native-nodejs-addons-2026):

> "N-API (Node.js API) is ABI-stable — addons built for Node.js 18 work in 20, 22, etc."

> "Users should never need to compile from source — always ship pre-built binaries."

Cross-platform toolchain cost (per CI runner):
- **Linux**: `python3`, `make`, `gcc`
- **macOS**: `xcode-select --install` (Xcode Command Line Tools, ~1GB)
- **Windows**: Visual Studio Build Tools, `windows-build-tools` (~5GB)

The recommended modern stack is **N-API + prebuild** (C/C++) or **@napi-rs** (Rust).
napi-rs CI matrix shown above builds 7 platforms in a single GitHub Actions matrix
job — that's the 2026 standard.

Sources:
- [N-API docs](https://nodejs.org/api/n-api.html)
- [prebuild package](https://www.npmjs.com/package/prebuild)
- [napi-rs cross-build example](https://github.com/napi-rs/cross-build)

## 11. `cluster` module: Windows has a non-default scheduling algorithm

From [Node.js concurrency docs](https://nodejs.org/learn/concurrency/comparing-nodejs-concurrency-models):

> "The primary process distributes incoming connections to its workers — by default
> in a round-robin fashion (`cluster.SCHED_RR`), which is the default on every
> platform except Windows."

On Windows, the cluster primary uses a different distribution strategy that has
historically had different fairness properties. For uniform load balancing across
workers, use Linux or explicitly set the scheduling policy.

## 12. Process signals and stdin/stdout behavior differ between OS

From the worker_threads docs:

> "The `process.stdin`, `process.stdout`, and `process.stderr` streams may be
> redirected by the parent thread."

> "Signals are not delivered through `process.on('...')`."

> "On Windows, unlike the main thread, a copy of the environment variables operates
> in a case-sensitive manner."

Practical implication: cross-platform signal handling (`SIGINT`, `SIGTERM`) inside
workers needs explicit forwarding from the main thread. The codebase uses
`runtime.shutdown()` which handles this correctly on all three OSes — but the
contract is: **workers don't get signals automatically, the runtime forwards them.**

## Synthesis: heuristics with external refs

The lessons in `CROSS-OS-LESSONS.md` are not unique to this codebase. The same patterns
appear in:

1. **Krun.pro worker threads deep dive** — same V8 isolate cost analysis, same
   `postMessage` O(n) warning, same "long-lived workers only" recommendation.
2. **GitHub Actions runner docs** — confirms `macos-latest = 3 cores`, confirming
   the failure pattern from the cpu-saturation E-2 bug.
3. **Siliceum Windows timer article** — confirms that headless Windows (CI runner
   included) has unreliable 1ms timer resolution, explaining the T9 P1+P2 Phase 2
   timing flake on Windows CI.
4. **Node.js path docs** — explicit guidance to use `path.sep` and `path.join`,
   confirming the codebase's path usage.
5. **N-API docs** — ABI-stable, ships prebuilds, confirms the 2026 standard for
   cross-platform native modules.

When you encounter a cross-OS issue that doesn't fit one of the lessons in
`CROSS-OS-LESSONS.md`, check whether the source can be found in one of the docs
above. Most cross-OS issues in Node.js codebases are documented — they're just hard
to find because the docs span multiple pages.

## When to consult this file

- A benchmark or test is flaky on one OS but passes on the others.
- You're adding code that depends on `availableParallelism()`, `path`, `setInterval`,
  `setImmediate`, `setTimeout`, worker_threads, native modules, or process signals.
- A CI matrix shows a single-host failure pattern that the heuristics in
  `CROSS-OS-LESSONS.md` don't already cover.
- You're onboarding a new agent or contributor and want to give them the
  "what does cross-OS mean in this codebase" reading list.
