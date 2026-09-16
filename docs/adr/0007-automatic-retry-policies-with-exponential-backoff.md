# ADR-0007: Automatic Retry Policies with Exponential Backoff for Background Tasks

- **Date**: 2026-09-16
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: resilience, background-jobs, outbox, retry-policy

## Context and Problem Statement

Background side-effects (such as sending emails, contacting external microservices, or webhook dispatching) frequently encounter transient network glitches or temporary service unavailability. Without built-in retry mechanisms, callers must write boilerplate wrapper loops or rely on heavy external job queues (like BullMQ/Redis) just to handle retries. How can the Persistent Worker Runtime support resilient retries for background tasks without blocking the main Event Loop?

## Decision Drivers

- Provide non-blocking retries with exponential backoff directly in `runtime.dispatch()`.
- Avoid busy-waiting or thread blocking during backoff intervals.
- Maintain seamless integration with the Transactional Outbox pattern.
- Track attempt counts and failure reasons across retries.

## Considered Options

- **Option 1: No runtime retries** (Caller must handle all failures manually upon `onError`)
- **Option 2: Immediate synchronous retry inside the worker thread** (Pins the worker thread in a sleep loop)
- **Option 3: Scheduled non-blocking re-enqueueing with configurable backoff**

## Decision Outcome

Chosen option: **"Option 3: Scheduled non-blocking re-enqueueing with configurable backoff"**, because it releases the worker thread immediately when a task fails and schedules a timer on the main Event Loop (`setTimeout`) to re-enqueue the task only when its backoff delay expires.

### Task Configuration:
```javascript
runtime.dispatch({
  type: 'send_email',
  payload: { to: 'user@example.com' },
  retries: 3,
  retryDelayMs: 1000,
  backoff: 'exponential', // 1s, 2s, 4s
});
```

### Positive Consequences

- Worker threads are never blocked during retry delays; they remain free to process other tasks.
- Transient errors are recovered automatically before `onError` is finally triggered.
- Full trace metadata is preserved across retry attempts.

### Negative Consequences

- Non-idempotent tasks should not configure retries without external safeguards.
