import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkerRuntimeError,
  WorkerCrashError,
  TaskQueueTimeoutError,
  TaskTimeoutError,
  TaskAbortedError,
  QueueOverflowError,
} from '../src/errors.js';

describe('Error Hierarchy', () => {
  describe('WorkerRuntimeError', () => {
    it('defaults code to ERR_WORKER_RUNTIME when not provided', () => {
      const err = new WorkerRuntimeError('boom');
      assert.equal(err.name, 'WorkerRuntimeError');
      assert.equal(err.code, 'ERR_WORKER_RUNTIME');
      assert.equal(err.message, 'boom');
    });

    it('honors a custom code', () => {
      const err = new WorkerRuntimeError('boom', { code: 'CUSTOM_CODE' });
      assert.equal(err.code, 'CUSTOM_CODE');
    });

    it('propagates the cause when provided', () => {
      const root = new Error('underlying');
      const err = new WorkerRuntimeError('wrapped', { cause: root });
      assert.equal(err.cause, root);
    });

    it('omits cause when not provided', () => {
      const err = new WorkerRuntimeError('no cause');
      assert.equal(err.cause, undefined);
    });
  });

  describe('WorkerCrashError', () => {
    it('sets code, workerId and exitCode from options', () => {
      const err = new WorkerCrashError('crashed', {
        workerId: 'w_1',
        exitCode: 7,
      });
      assert.equal(err.name, 'WorkerCrashError');
      assert.equal(err.code, 'ERR_WORKER_CRASHED');
      assert.equal(err.workerId, 'w_1');
      assert.equal(err.exitCode, 7);
    });

    it('extends WorkerRuntimeError', () => {
      const err = new WorkerCrashError('crash', { workerId: 'w', exitCode: 1 });
      assert.ok(err instanceof WorkerRuntimeError);
      assert.ok(err instanceof Error);
    });
  });

  describe('TaskQueueTimeoutError', () => {
    it('captures taskId, waitedMs and queueDepth', () => {
      const err = new TaskQueueTimeoutError('queue timeout', {
        taskId: 't_42',
        waitedMs: 30000,
        queueDepth: 1000,
      });
      assert.equal(err.name, 'TaskQueueTimeoutError');
      assert.equal(err.code, 'ERR_TASK_QUEUE_TIMEOUT');
      assert.equal(err.taskId, 't_42');
      assert.equal(err.waitedMs, 30000);
      assert.equal(err.queueDepth, 1000);
    });
  });

  describe('TaskTimeoutError', () => {
    it('treats options.preempted as boolean (false)', () => {
      const err = new TaskTimeoutError('timeout', {
        taskId: 't',
        timeoutMs: 50,
        workerId: 'w',
        preempted: false,
      });
      assert.equal(err.preempted, false);
      assert.equal(err.code, 'ERR_TASK_TIMEOUT');
    });

    it('treats undefined preempted as false', () => {
      const err = new TaskTimeoutError('timeout', { taskId: 't', timeoutMs: 50 });
      assert.equal(err.preempted, false);
    });

    it('sets preempted=true for hard preemption', () => {
      const err = new TaskTimeoutError('preempted', {
        taskId: 't',
        timeoutMs: 50,
        preempted: true,
        workerId: 'w',
      });
      assert.equal(err.preempted, true);
      assert.equal(err.workerId, 'w');
      assert.equal(err.timeoutMs, 50);
    });

    it('defaults workerId to null when not provided', () => {
      const err = new TaskTimeoutError('timeout', { taskId: 't', timeoutMs: 50 });
      assert.equal(err.workerId, null);
    });
  });

  describe('TaskAbortedError', () => {
    it('uses a default message and stores taskId', () => {
      const err = new TaskAbortedError(undefined, { taskId: 't_99' });
      assert.equal(err.name, 'TaskAbortedError');
      assert.equal(err.message, 'Task was aborted by caller');
      assert.equal(err.code, 'ERR_TASK_ABORTED');
      assert.equal(err.taskId, 't_99');
    });

    it('accepts a custom message', () => {
      const err = new TaskAbortedError('custom reason', { taskId: 't' });
      assert.equal(err.message, 'custom reason');
    });
  });

  describe('QueueOverflowError', () => {
    it('captures maxQueueSize', () => {
      const err = new QueueOverflowError('overflow', { maxQueueSize: 500 });
      assert.equal(err.name, 'QueueOverflowError');
      assert.equal(err.code, 'ERR_QUEUE_OVERFLOW');
      assert.equal(err.maxQueueSize, 500);
    });

    it('extends WorkerRuntimeError', () => {
      const err = new QueueOverflowError('overflow', { maxQueueSize: 1 });
      assert.ok(err instanceof WorkerRuntimeError);
    });
  });
});
