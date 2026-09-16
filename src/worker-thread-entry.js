import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('worker-thread-entry must be run as a Worker thread.');
}

// L1 Persistent Worker-Local State (Private Heap)
const localState = new Map();

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
 * Executes a single task inside the worker thread.
 */
async function processTask(message) {
  const { taskId, type, payload, fnCode } = message;

  try {
    let result;

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
      // 2. Dynamic serialized function execution
      const fn = new Function('payload', 'state', `return (${fnCode})(payload, state);`);
      result = await fn(payload, localState);
    } else if (typeof customHandler === 'function') {
      // 3. User-defined module handler
      result = await customHandler({ type, payload, state: localState });
    } else if (customHandler && typeof customHandler[type] === 'function') {
      result = await customHandler[type](payload, localState);
    } else {
      // 4. Default fallback: echo payload with acknowledgment
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
  if (!message || !message.taskId) return;
  processTask(message);
});

// Signal to the main thread supervisor that this worker is initialized and ready
parentPort.postMessage({ type: 'ready' });
