# Strategic Guide: Proposing the Persistent Worker Runtime to Node.js Core

This document outlines the governance process, technical requirements, and strategic roadmap for submitting the **Persistent Worker Runtime** proposal to the official Node.js repository (`nodejs/node`).

---

## 1. How Node.js Evaluates New Core APIs (The "Small Core" Philosophy)

Historically, Node.js adheres to the **"Small Core"** philosophy:
> *"If a feature can be efficiently implemented in userland (as an npm package), it should NOT be added to Node.js core to avoid expanding the long-term maintenance surface of the standard library."*

However, in recent major releases, several significant additions successfully cleared this threshold:
1. **`node:test`**: Added because the entire ecosystem needed a standardized, fast test runner without the dependency overhead of Jest or Mocha.
2. **`node:sqlite`**: Added because native compilation with `node-gyp` caused widespread friction across platforms, and embedded local storage is a fundamental modern building block.
3. **`fetch` (via Undici)**: Added to align Node.js with WHATWG Web Standards.
4. **`node:watch`**: Added to eliminate external development dependencies like `nodemon`.

### The Crucial TSC Question: *"Why in Core and not npm?"*
For the **Node.js Technical Steering Committee (TSC)** and collaborators to accept this proposal into core, we must clearly demonstrate:
1. **Universal Ecosystem Pain:** Event Loop starvation caused by CPU-bound tasks remains the #1 operational pitfall for Node.js developers.
2. **Native Diagnostic Integration:** Reliable context propagation across thread boundaries via `node:async_hooks` (`AsyncResource`) for OpenTelemetry and APMs without monkey-patching.
3. **Zero-Dependency Universal DX:** Providing a canonical, batteries-included concurrency primitive on par with Promises and Streams.
4. **Differentiation from Existing Pools:** Libraries like `piscina` (authored by TSC member Matteo Collina) specialize in stateless task execution. Our proposal introduces **Stateful Workers with L1 in-memory persistence and worker affinity**, addressing use cases such as warm ML models, AST parsers, and local caches.

---

## 2. Why Pure Modern JavaScript (Targeting Node.js >= 24)?

Node.js standard library modules (`lib/*.js` and `lib/internal/*.js`) are authored strictly in **modern vanilla JavaScript**:
* **No TypeScript in Core:** The runtime itself does not compile TypeScript for internal modules.
* **Zero External Dependencies:** Built-in modules can only rely on Node.js internals and native C++ bindings.
* **Modern ES Features:** Targeting Node.js 24 allows the use of top-level await, ECMAScript modules (ESM), private class fields (`#field`), `structuredClone`, and `AbortSignal.timeout()`.

Developing the reference implementation in pure JavaScript with zero dependencies ensures the codebase can be directly mapped into the Node.js repository tree (`lib/internal/worker/` or `lib/worker_runtime.js`).

---

## 3. Step-by-Step Submission Roadmap

### Phase 1: Reference Implementation & Benchmarks (Local Repository)
Before opening the GitHub issue:
* Build a functional reference implementation in pure JavaScript (ESM).
* Provide comprehensive unit tests using the native test runner (`node:test`).
* Conduct rigorous benchmarks comparing:
  1. Synchronous Event Loop execution (demonstrating latency spikes).
  2. Ad-hoc `new Worker()` per task (demonstrating thread spawn cost).
  3. `piscina` (benchmarking against the userland state-of-the-art).
  4. Persistent Worker Runtime (demonstrating Event Loop responsiveness and warm L1 state benefits).

### Phase 2: Opening the Feature Request / RFC in `nodejs/node`
* Open a formal **Feature Request** on GitHub: `https://github.com/nodejs/node/issues/new/choose`
* Apply tags: `worker_threads`, `feature request`.
* Use the prepared draft from [`NODEJS_RFC_PROPOSAL_DRAFT.md`](NODEJS_RFC_PROPOSAL_DRAFT.md).

### Phase 3: Engaging with Working Groups
* Present the proposal to relevant Node.js working groups:
  * **Performance Working Group** (focus on Event Loop lag reduction).
  * **Next-10 Working Group** (focus on long-term developer needs and concurrency).
* Collaborate constructively with maintainers and iterate based on technical feedback.

### Phase 4: Experimental Core Integration
If consensus is achieved:
* The feature is merged as an experimental module (e.g., `node:worker_runtime` or behind the `--experimental-worker-runtime` flag).
* It remains under **Stability: 1 - Experimental** while collecting real-world ecosystem feedback before reaching **Stability: 2 - Stable**.
