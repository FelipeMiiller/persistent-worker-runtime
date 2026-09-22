import { parentPort, workerData } from 'node:worker_threads';
import { ChannelRegistry } from './broadcast-channel.js';
import { createPauseController, isGeneratorFunction, runStream } from './stream-runner.js';

if (!parentPort) {
  throw new Error('worker-thread-entry must be run as a Worker thread.');
}

// L1 Persistent Worker-Local State (Private Heap)
const localState = new Map();

// Per-worker BroadcastChannel registry. One registry per worker thread;
// channels created here are automatically cleaned up when the worker
// terminates (FinalizationRegistry safety net + explicit closeAll on exit).
const channelRegistry = new ChannelRegistry();

// Active streaming tasks on this worker. Each entry holds the per-task
// AbortController so an incoming MSG_STREAM_ABORT can run `gen.return()`
// on the right iterator and let its `finally` blocks execute cleanly.
const activeStreams = new Map();
// Parallel map of pause controllers keyed by taskId. An incoming
// MSG_STREAM_PAUSE / MSG_STREAM_RESUME flips the corresponding iterator's
// pause flag; the await loop inside runStream parks between yields when
// the flag is set so chunks stop arriving on the wire.
const streamPauseControllers = new Map();

// Optional user-provided custom task handler module
let customHandler = null;

if (workerData?.handlerPath) {
  try {
    const mod = await import(workerData.handlerPath);
    customHandler = mod.default || mod.handleTask || mod;
  } catch (err) {
    parentPort.postMessage({
      type: 'init_error',
      error: { message: err.message, stack: err.stack },
    });
  }
}

/**
 * Builds the execution context passed to user task functions.
 *
 * `context.channel(name)` returns a channel wrapper bound to this
 * worker's BroadcastChannel registry. Workers can publish to and
 * subscribe from any named channel without involving the main thread.
 */
function buildContext() {
  return {
    channel(name) {
      return channelRegistry.getChannel(name);
    },
    // Expose registry so advanced users (customHandler) can call
    // closeAll() explicitly during teardown if desired.
    _registry: channelRegistry,
  };
}

/**
 * Executes a single task inside the worker thread.
 */
async function processTask(message) {
  const { taskId, type, payload, fnCode, fnDeps } = message;

  try {
    let result;
    const context = buildContext();

    // 1. Built-in L1 state manipulation actions
    if (type === '__get_state__') {
      result = localState.get(payload?.key);
    } else if (type === '__set_state__') {
      localState.set(payload?.key, payload?.value);
      result = true;
    } else if (type === '__has_state__') {
      result = localState.has(payload?.key);
    } else if (type === '__clear_state__') {
      localState.clear();
      result = true;
    } else if (type === '__ping__') {
      result = 'pong';
    } else if (fnCode) {
      // 2. Dynamic serialized function execution with HARDEN-02 (ADR-0024 A2)
      // `node:*` dependency injection.
      //
      // The fn receives (payload, state, context) so existing fnCode that
      // uses only payload or (payload, state) continues to work. We also
      // build a per-task `__fnDeps` object from the manifest (e.g.
      // `{ 'node:net': <net module> }`) and inject each module as a
      // bare-name closure variable BEFORE the user code, so users can call
      // `net.createConnection(...)` directly without `await import(...)`
      // boilerplate. Fns that reference a module NOT in the manifest fall
      // back to their own `await import(...)` (preserves A2-from-before for
      // user-installed deps — ADR-0005 zero external deps applies to the
      // runtime, not to user code).
      const modules = {};
      for (const name of fnDeps || []) {
        // `import('node:net')` is idempotent in Node.js — repeated calls
        // return the same module namespace instance from the loader cache.
        modules[name] = await import(name);
      }
      const captureLines = Object.keys(modules)
        .map((name) => {
          const bare = name.replace(/^node:/, '');
          return `const ${bare} = __modules[${JSON.stringify(name)}];`;
        })
        .join('\n');
      const wrappedSource = `${captureLines}\nreturn (${fnCode})(payload, state, context);`;
      const fn = new Function('payload', 'state', 'context', '__modules', wrappedSource);

      // 2a. Streaming path — generator function (async or sync).
      // Detected via the source string (`new Function(...)` strips the
      // AsyncGeneratorFunction / GeneratorFunction constructor identity,
      // so we fall back to a regex on fnCode). When fnCode is not
      // available (e.g. inline customHandler), runtime detection via
      // Function.prototype.constructor.name is attempted.
      if (isGeneratorFunction(fn, fnCode)) {
        const ac = new AbortController();
        const pauseController = createPauseController();
        activeStreams.set(taskId, ac);
        streamPauseControllers.set(taskId, pauseController);
        try {
          await runStream({
            parentPort,
            taskId,
            fn,
            payload,
            localStorage: localState,
            context,
            signal: ac.signal,
            pauseController,
            // HARDEN-02 (ADR-0024 A2): pass per-task `node:*` deps so
            // streaming generators can call bare-name `net`, `crypto`, etc.
            __modules: modules,
          });
        } finally {
          activeStreams.delete(taskId);
          streamPauseControllers.delete(taskId);
        }
        // runStream handles all IPC frames for streaming tasks; do not
        // emit a final success/failure here.
        return;
      }

      // 2b. Regular (async) function path — single result back to main.
      // `modules` is the per-task `node:*` dependency map built above;
      // empty object when the fn has no `node:*` references.
      result = await fn(payload, localState, context, modules);
    } else if (typeof customHandler === 'function') {
      // 3. User-defined module handler (object signature includes context)
      result = await customHandler({ type, payload, state: localState, context });
    } else if (customHandler && typeof customHandler[type] === 'function') {
      // 4. User-defined module handler (per-type function; context passed
      // as third argument)
      result = await customHandler[type](payload, localState, context);
    } else {
      // 5. Default fallback: echo payload with acknowledgment
      result = { executed: true, type, payload };
    }

    const memoryUsageBytes = process.memoryUsage().heapUsed;

    parentPort.postMessage({
      taskId,
      success: true,
      result,
      memoryUsageBytes,
    });
  } catch (err) {
    const memoryUsageBytes = process.memoryUsage().heapUsed;
    parentPort.postMessage({
      taskId,
      success: false,
      error: {
        message: err.message || String(err),
        stack: err.stack,
        code: err.code || 'ERR_TASK_EXECUTION',
      },
      memoryUsageBytes,
    });
  }
}

// Listen for tasks from the main thread
parentPort.on('message', (message) => {
  if (message?.type === 'MSG_STREAM_ABORT' && message.taskId) {
    const ac = activeStreams.get(message.taskId);
    if (ac) ac.abort(message.reason);
    return;
  }
  if (message?.type === 'MSG_STREAM_PAUSE' && message.taskId) {
    const pc = streamPauseControllers.get(message.taskId);
    if (pc) pc.pause();
    return;
  }
  if (message?.type === 'MSG_STREAM_RESUME' && message.taskId) {
    const pc = streamPauseControllers.get(message.taskId);
    if (pc) pc.resume();
    return;
  }
  if (!message?.taskId) return;
  processTask(message);
});

// Best-effort cleanup when the worker exits. The FinalizationRegistry
// safety net in ChannelRegistry covers the GC case; this explicit
// closeAll() covers explicit shutdown paths (terminate, recycle).
function cleanup() {
  try {
    channelRegistry.closeAll();
  } catch {
    // Worker is shutting down; ignore any close errors.
  }
}

process.on('beforeExit', cleanup);
parentPort.on('close', cleanup);

// Signal to the main thread supervisor that this worker is initialized and ready
parentPort.postMessage({ type: 'ready' });
