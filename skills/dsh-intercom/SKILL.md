---
name: dsh-intercom
description: |
  Streamline session-to-session coordination with dsh-intercom. Send messages,
  delegate tasks, and coordinate work across multiple dsh sessions on the same
  machine. Use for planner-worker workflows, cross-session context sharing,
  and real-time collaboration between sessions.
---

# dsh Intercom Skill

Use this skill when you need to coordinate work across multiple dsh sessions
running on the same machine. dsh-intercom enables direct 1:1 messaging between
sessions for delegation, context sharing, and collaborative workflows.

## When to Use

- **Task delegation**: Split work between a planner session and worker sessions
- **Context handoffs**: Send findings from a research session to an execution session
- **Clarification loops**: Worker asks questions, planner answers, work continues
- **Multi-session workflows**: Coordinate between specialized sessions (frontend/backend, research/implementation)
- **Cross-codebase peer messages**: Message an explicit live peer in another project directory

## When NOT to Use

- The task fits in one session — coordination overhead buys nothing.
- You need a supervised subagent with a bounded task — prefer dsh's built-in
  subagent tool; intercom is for independent peer sessions, not owned children.
- The peer is on another machine — intercom is same-machine only.

## Core Patterns

### Pattern 1: Planner-Worker Delegation

The most common pattern. One session holds the big picture, others do hands-on work.

**Setup** (in each session, via the tool):

```typescript
intercom({ action: "name", alias: "planner" }); // session 1
intercom({ action: "name", alias: "worker" }); // session 2
```

**Planner delegates a task** (fire-and-forget):

```typescript
intercom({
  action: "send",
  to: "worker",
  message:
    "Task-3: Add retry logic to API client. Key files: src/api/client.ts. Ask if anything's unclear.",
});
```

**Worker asks for clarification** (blocks until the answer arrives):

```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Should I use exponential backoff or fixed intervals?",
});
// → Returns the planner's reply as the tool result
```

**Worker reports completion**:

```typescript
intercom({
  action: "ask",
  to: "planner",
  message:
    "Task-3 complete. Added exponential backoff (100ms → 1600ms, max 5 retries). Ready for task-4?",
});
```

### Pattern 2: Quick Status Check

Before sending, verify who's connected:

```typescript
intercom({ action: "list" });
// → Shows all connected sessions with names, cwd, models, and live status (`idle`, `thinking`, `tool:<name>`)
```

### Pattern 3: Reply Naturally

When responding to an inbound ask, prefer `reply` instead of reconstructing raw IDs:

```typescript
// In the turn triggered by the ask:
intercom({
  action: "reply",
  message: "Use exponential backoff starting at 100ms.",
});

// If replying later and there might be more than one pending ask:
intercom({ action: "pending" });
intercom({
  action: "reply",
  to: "planner",
  message: "Use exponential backoff starting at 100ms.",
});
```

`reply` preserves exact threading under the hood by sending the response with
the original `replyTo` value.

### Pattern 4: Broadcast to Multiple Workers

Send to multiple sessions in parallel (one tool call per worker):

```typescript
intercom({ action: "send", to: "worker-1", message: task });
intercom({ action: "send", to: "worker-2", message: task });
intercom({ action: "send", to: "worker-3", message: task });
```

### Pattern 5: Cross-Directory Peer Messages

Use `to` alone to message any explicit live peer on the machine, even when it
works in another directory. Use `cwd` alone when there should be exactly one
live peer in that directory. Use `to` plus `cwd` when the directory is a
safety guard.

```typescript
intercom({
  action: "ask",
  cwd: "/path/to/other-repo",
  to: "workbench-agent",
  message: "Which module owns workbench source slices?",
});
```

`list-cwd` shows only the sessions in a directory:

```typescript
intercom({ action: "list-cwd", cwd: "/path/to/other-repo" });
```

## Key Differences

| Action     | Behavior                                                                             | Use When                                              |
| ---------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `send`     | Fire-and-forget; infers the sole pending ask as its reply                            | You don't need a response                             |
| `ask`      | Blocks until reply (10 min default, configurable with `DSH_INTERCOM_ASK_TIMEOUT_MS`) | You need an answer to continue                        |
| `reply`    | Responds to the active or pending inbound ask                                        | You were asked something and need to answer naturally |
| `pending`  | Lists unresolved inbound asks                                                        | You need to see who is waiting before replying        |
| `list`     | Returns all sessions with live status                                                | You need to discover targets or choose an idle peer   |
| `list-cwd` | Returns sessions in one working directory                                            | You only care about peers in a specific repo          |
| `name`     | Gives this session an alias                                                          | Setup, so others can address you                      |
| `cancel`   | Requests cancellation of a message you sent                                          | You sent something stale or wrong                     |
| `status`   | Returns your connection state                                                        | Troubleshooting                                       |

## Important Constraints

### `ask` Limitations

- **Connected targets only**: `ask` fails immediately when the target is not in
  the live intercom roster. Use `list` before asking when liveness is
  uncertain; use `send` for non-blocking mailbox delivery.
- **Configurable timeout**: If no reply arrives before the shared ask timeout,
  the ask fails. The default is 10 minutes; set `DSH_INTERCOM_ASK_TIMEOUT_MS`
  to a positive millisecond value to change it.
- **One at a time**: Cannot have multiple pending asks from the same session.
- **Cannot self-target**: A session cannot ask itself.

### `send` Behavior

- **No timeout**: Message is delivered or fails immediately.
- **Mailbox queueing**: `send` to a recently disconnected _named_ session
  queues in the broker mailbox and is delivered when a session with the same
  alias and working directory reconnects.
- **Sole pending ask inference**: If the destination has exactly one pending
  inbound ask, `send` attaches its `replyTo` and reports
  `Reply sent to <target> (inferred from pending ask)`.
- **Ambiguity stays unthreaded**: Zero or multiple matching asks leave the
  send as an ordinary message.

## Best Practices

### Use `ask` for blocking workflows

When the worker needs information to proceed:

```typescript
// GOOD: Worker blocks until planner responds
intercom({
  action: "ask",
  to: "planner",
  message:
    "API rate limit is 100/min. Should I implement client-side throttling or batching?",
});
// → Continue with the answer...
```

### Use `send` for notifications

When you just want to inform:

```typescript
// GOOD: Fire-and-forget notification
intercom({
  action: "send",
  to: "reviewer",
  message: "PR #123 is ready for review. Key changes in auth.ts.",
});
// → Continue immediately, don't wait
```

### Name sessions meaningfully

Use the `name` action so others can target you easily:

```typescript
intercom({ action: "name", alias: "api-worker" });
```

### Long-running tasks: send + periodic asks

For tasks that might exceed the ask timeout, don't hold one `ask` open:

```typescript
// 1. Planner sends the full task
intercom({
  action: "send",
  to: "worker",
  message:
    "Implement user authentication. This will take 30+ minutes. Report at milestones.",
});

// 2. Worker reports progress via send (no timeout)
intercom({
  action: "send",
  to: "planner",
  message: "Milestone 1: Login form complete (10min)",
});

// 3. Worker asks for a specific decision only when blocked
intercom({
  action: "ask",
  to: "planner",
  message: "Should we use JWT or session cookies? Need decision to continue.",
});
```

## Error Handling

### Common Errors and Solutions

**"Already waiting for a reply"**

```typescript
// You can only have one pending ask at a time
// Option 1: Use send instead
intercom({ action: "send", to: "planner", message: "..." });
// Option 2: Wait for the current ask to complete first
```

**"intercom: cannot message the current session"**

```typescript
// You cannot target yourself — double-check the target name with:
intercom({ action: "list" });
```

**"Session ... is not currently connected"**

```typescript
// Blocking asks need a live target. Either list first:
intercom({ action: "list" });
// ...or use send for mailbox delivery to a named peer:
intercom({ action: "send", to: "worker", message: "..." });
```

**Ask timeout**

```typescript
// Default: 10 minutes; override with DSH_INTERCOM_ASK_TIMEOUT_MS.
// For longer tasks, use the send + periodic asks pattern above.
```

## Troubleshooting

### Session not appearing in list

1. Check intercom is enabled and which transport is active:
   `intercom({ action: "status" })`
2. Verify the target session runs dsh with dsh-intercom installed.
3. Ensure both sessions are on the same machine (intercom is same-machine
   only) and share the same `DSH_HOME` (broker discovery is keyed by
   `$DSH_HOME/intercom`).

### Message not delivered

`send` to a live peer fails with a reason; to a recently disconnected named
peer it queues in the mailbox. `ask` never queues — it fails immediately when
the target is not connected.

### Connection lost

Sessions automatically reconnect if the broker restarts. If persistently
disconnected, run `intercom({ action: "status" })` and restart dsh if the
broker cannot be reached.
