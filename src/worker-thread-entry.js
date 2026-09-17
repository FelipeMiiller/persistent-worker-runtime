import { parentPort, workerData } from 'node:worker_threads';
import { ChannelRegistry } from './broadcast-channel.js';
import { isGeneratorFunction, runStream } from './stream-runner.js';

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
  const { taskId, type, payload, fnCode } = message;

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
      // 2. Dynamic serialized function execution.
      // The function receives (payload, state, context) so existing fnCode
      // that uses only payload or (payload, state) continues to work.
      const fn = new Function(
        'payload',
        'state',
        'context',
        `return (${fnCode})(payload, state, context);`,
      );

      // 2a. Streaming path — generator function (async or sync).
      // Detected via the source string (`new Function(...)` strips the
      // AsyncGeneratorFunction / GeneratorFunction constructor identity,
      // so we fall back to a regex on fnCode). When fnCode is not
      // available (e.g. inline customHandler), runtime detection via
      // Function.prototype.constructor.name is attempted.
      if (isGeneratorFunction(fn, fnCode)) {
        const ac = new AbortController();
        activeStreams.set(taskId, ac);
        try {
          await runStream({
            parentPort,
            taskId,
            fn,
            payload,
            localStorage: localState,
            context,
            signal: ac.signal,
          });
        } finally {
          activeStreams.delete(taskId);
        }
        // runStream handles all IPC frames for streaming tasks; do not
        // emit a final success/failure here.
        return;
      }

      // 2b. Regular (async) function path — single result back to main.
      result = await fn(payload, localState, context);
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
