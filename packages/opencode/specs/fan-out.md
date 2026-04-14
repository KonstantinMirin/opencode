# Parallel Worktree Fan-Out Plugin

## Overview

A plugin that enables a lead agent to decompose work into independent tasks,
spawn autonomous worker agents in isolated git worktrees, supervise them via
mailbox-style messaging, and merge results back. Every agent gets infinite
context via tiered compaction from `feature/endless-context`.

**Branch:** `plugin/fan-out` (from `feature/endless-context` at `ff041fa97`)

**Core changes required:** None. The entire feature is a plugin.

## Architecture

```
Lead Agent (main worktree)
  │
  ├─ spawn_workers  → N worktrees + N child sessions + async prompts
  ├─ worker_status  → live status of all workers (from event bus)
  ├─ read_worker    → read last N messages from a child session
  ├─ message_worker → send follow-up (queued if busy, delivered on idle)
  ├─ merge_worker   → git merge worker branch into main
  └─ dismiss_worker → cancel + cleanup
```

### Why No Core Changes?

The server middleware at `server/instance/middleware.ts:101-112` already handles
ALS context switching for workspace-scoped requests:

```ts
WorkspaceContext.provide({
  workspaceID,
  fn: () => Instance.provide({ directory: target.directory, fn: next() }),
})
```

When the plugin's SDK client sends requests with `experimental_workspaceID`,
the middleware resolves the workspace directory and wraps execution in
`Instance.provide({ directory: worktreeDir })`. All tools (read, write, edit,
bash, glob, grep) resolve paths relative to the worktree automatically.

### Existing SDK Endpoints Used

| Endpoint                         | SDK Method                               | Purpose                                              |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `POST /experimental/workspace`   | `client.experimental.workspace.create()` | Create worktree                                      |
| `DELETE /experimental/worktree`  | `client.experimental.worktree.remove()`  | Remove worktree                                      |
| `POST /session`                  | `client.session.create()`                | Create child session with `workspaceID` + `parentID` |
| `POST /session/:id/prompt_async` | `client.session.promptAsync()`           | Fire LLM loop asynchronously                         |
| `GET /session/status`            | `client.session.status()`                | Idle/busy for all sessions                           |
| `GET /session/:id/children`      | `client.session.children()`              | List child sessions                                  |
| `GET /session/:id/message`       | `client.session.message.list()`          | Read messages                                        |
| `DELETE /session/:id`            | `client.session.delete()`                | Delete session                                       |

### Scoped SDK Client Pattern

From `dialog-workspace-create.tsx:18-25`:

```ts
function scoped(client, workspaceID) {
  return createOpencodeClient({
    baseUrl: client.url,
    fetch: client.fetch,
    directory: client.directory,
    experimental_workspaceID: workspaceID,
  })
}
```

`read_worker` and `message_worker` use scoped clients to route requests through
the correct worktree context.

## Design Decisions

| Decision            | Choice                | Rationale                                                  |
| ------------------- | --------------------- | ---------------------------------------------------------- |
| Communication model | Mailbox via tools     | Decoupled, uses existing SDK primitives                    |
| Execution model     | Async with polling    | Lead can supervise, send follow-ups, merge incrementally   |
| Conflict prevention | Behavioral (prompt)   | Workers are full agents; isolation is via git worktrees    |
| Worker permissions  | Unrestricted          | Workers are full agents — Task, todowrite, git, everything |
| Agent type          | Configurable per task | Enables build/verify pattern on same worktree              |
| Team cardinality    | One team per lead     | Must merge/dismiss before spawning new team                |
| Message delivery    | Queued if busy        | Delivered automatically when worker goes idle              |

## Plugin Hooks

### Per-Turn Injection

| Hook                                 | When Fired                     | What We Inject                                                           |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------ |
| `event`                              | Every bus event                | Track `session.status` → maintain worker state + deliver queued messages |
| `tool.definition`                    | Every tool resolution per turn | Append current worker status to tool descriptions                        |
| `experimental.chat.system.transform` | Every LLM turn                 | Inject team awareness reminders into system prompt                       |

### How `tool.definition` Injection Works

Every time the model sees the `spawn_workers` tool, the description includes
current worker status appended dynamically:

```
Current team (use worker_status for details, read_worker to inspect output):
- ses_abc (build): busy [wt-1]
- ses_def (verify): idle, has reply [wt-1]
- ses_ghi (build): retry (2/3) [wt-2]
```

This eliminates the need for explicit polling — the model sees team state on
every turn as part of the tool definition.

### How `experimental.chat.system.transform` Works

When a team exists, a system prompt section is injected:

```
## Active Worker Team

You have N worker(s). Key reminders:
- Use worker_status to check progress
- Use read_worker to inspect output (workers with "has reply" have new output)
- Use message_worker to send follow-up instructions (queued if worker busy)
- Use merge_worker to integrate completed work
- Use dismiss_worker to cancel and clean up
```

## Tool Definitions

### spawn_workers

```ts
args: {
  tasks: z.array(
    z.object({
      description: z.string(),
      prompt: z.string(),
      agent: z.string().default("build"),
      worktree: z.string().optional(), // reuse existing worktree by name
    }),
  )
    .min(1)
    .max(10)
}
```

**Flow:**

1. Check if a team already exists. If yes, reject — lead must merge/dismiss first.
2. For each task:
   - If `worktree` specified and exists, reuse it (enables build/verify pattern)
   - Otherwise create new workspace via `client.experimental.workspace.create()`
   - Create child session via `client.session.create({ parentID, workspaceID })`
   - Fire async prompt via `client.session.promptAsync({ agent: task.agent, ... })`
3. On partial failure: return which tasks succeeded and which failed. Worktrees
   that were created are kept — lead can retry failed tasks individually.

**The `worktree` parameter** enables the verification pattern:

```
spawn_workers([
  { agent: "build",  prompt: "Implement auth module",   worktree: "wt-1" },
  { agent: "verify", prompt: "Verify auth implementation", worktree: "wt-1" },
])
```

Both sessions share the same worktree filesystem but have independent context
windows, independent compaction, and independent session state.

### worker_status

```ts
args: {
}
```

Returns status table. Two sources merged for resilience:

- In-memory state from `event` hook (real-time)
- SDK fallback via `client.session.children()` + `client.session.status()` if
  in-memory state is stale or after recovery

```
Worker   | Agent   | Status | Worktree | Description
-------- | ------- | ------ | -------- | -----------
ses_abc  | build   | busy   | wt-1     | Implement auth
ses_def  | verify  | idle   | wt-1     | Verify auth
ses_ghi  | build   | retry  | wt-2     | Add tests (2/3 retries)
```

### read_worker

```ts
args: {
  sessionID: z.string(),
  limit: z.number().default(5),
}
```

Reads last N messages from a child session via scoped SDK client. Also shows
queued messages pending delivery.

### message_worker

```ts
args: {
  sessionID: z.string(),
  message: z.string(),
}
```

**Flow:**

1. If worker is **idle**: deliver immediately via `scopedClient.session.promptAsync()`
2. If worker is **busy**: queue in plugin state. The `event` hook delivers
   queued messages automatically when the worker transitions to `idle`.
3. When the worker finishes processing the message, `hasReply` flag is set.
   The lead sees this via `tool.definition` injection on the next turn.

### merge_worker

```ts
args: {
  sessionID: z.string(),
}
```

**Flow:**

1. Validate worker is idle
2. Show changed files: `git diff --name-only main..branch`
3. Merge: `git merge --no-edit branch`
4. On success: remove worktree, archive session, clean up state
5. On conflict: return conflict file list. Do NOT auto-resolve. Lead can:
   - Resolve manually in the main worktree
   - Spawn a new agent in the same worktree to resolve conflicts
   - Dismiss and abandon the branch

### dismiss_worker

```ts
args: {
  sessionID: z.string(),
  force: z.boolean().default(false),
}
```

- `force=false` and worker busy: reject with "Worker busy. Use force=true."
- `force=true`: cancel session, remove worktree, clean up state

## Edge Cases

### Lead Cancellation

If the lead's run is cancelled by the user (explicit stop), all child sessions
are cancelled and worktrees cleaned up. This is handled via the `abort` signal
in `ToolContext` — when the lead is cancelled, the plugin's cleanup runs.

If the lead process _crashes_, workers continue independently. They are regular
sessions in the database. On restart, the plugin recovers state via
`session.children()`.

### Circuit Breaker

When a worker enters `retry` status:

1. Increment `consecutiveRetries` counter (tracked in plugin state)
2. If `consecutiveRetries >= MAX_RETRIES` (default 3):
   - Archive the failed session
   - Reset the worktree: `git checkout main && git checkout -b new-branch`
   - Create new session in the same worktree
   - Fire prompt with original task description
   - Reset counter
3. If retry succeeds (status → idle), reset counter

### Merge Conflicts

When `git merge` produces conflicts, the lead has three options:

1. **Resolve manually** — use edit/write tools in the main worktree
2. **Spawn resolver agent** — `spawn_workers([{ agent: "build", worktree: "wt-1", prompt: "Resolve merge conflicts in ..." }])`
3. **Dismiss and abandon** — `dismiss_worker(sessionID, force=true)`

### Recovery on Plugin Load

On plugin initialization, rebuild state from the database:

```ts
const children = await client.session.children(currentSessionID)
for (const child of children) {
  if (child.workspaceID) {
    const workspace = await client.experimental.workspace
      .list()
      .then((ws) => ws.find((w) => w.id === child.workspaceID))
    if (workspace) {
      // Rebuild tracked worker state
    } else {
      // Orphan — workspace gone, garbage collect the session
      await client.session.delete(child.id)
    }
  }
}
```

### Orphan Garbage Collection

On plugin load, any child session whose workspace no longer exists is deleted.
Any workspace without a corresponding tracked session is removed. This prevents
resource leaks after crashes.

### Rate Limits

Workers share the same API key. Provider rate limits apply per-key, not
per-session. The existing exponential backoff in the retry logic handles this
— workers that hit rate limits enter `retry` status, which the circuit breaker
monitors.

## Endless Context Integration

Each worker gets its own tiered compaction instance automatically:

- `InstanceState` is keyed by directory — each worktree is a different directory
- `TieredCompaction.State` contains `sessions: Map<SessionID, PerSession>`
- Each worker session has its own anchor, fiber, and failure counter
- The Sieve queue is per-instance (shared within a worktree, not across)

**No changes to tiered compaction are needed for multi-agent support.** The
architecture is already session-scoped and instance-scoped, which maps cleanly
to the worktree isolation model.

When the lead reads a worker's messages via `read_worker`, compacted messages
are already filtered — the lead sees the compacted view, not raw tool output.
This is desirable: the lead gets summaries, not floods.

## Plugin File Structure

Single file: `.opencode/plugins/fan-out.ts`

```
fan-out.ts
  ├─ Types: WorkerHandle, WorkerState, TeamState
  ├─ State: Map<leadSessionID, TeamState>
  ├─ Helper: scopedClient(client, workspaceID)
  │
  ├─ Tool: spawn_workers
  ├─ Tool: worker_status
  ├─ Tool: read_worker
  ├─ Tool: message_worker
  ├─ Tool: merge_worker
  ├─ Tool: dismiss_worker
  │
  ├─ Hook: event           — track session.status, deliver queued messages
  ├─ Hook: tool.definition — inject worker status into tool descriptions
  ├─ Hook: experimental.chat.system.transform — team awareness reminders
  │
  └─ export default: Plugin function
```

## Implementation Order

1. Types and state management (WorkerHandle, TeamState, in-memory maps)
2. `spawn_workers` tool (workspace creation, session creation, async prompt)
3. `event` hook (status tracking, message queue delivery)
4. `worker_status` tool
5. `read_worker` tool
6. `message_worker` tool (with queue logic)
7. `merge_worker` tool (git merge, cleanup)
8. `dismiss_worker` tool (cancel, cleanup)
9. `tool.definition` hook (per-turn status injection)
10. `experimental.chat.system.transform` hook (team awareness)
11. Circuit breaker logic in event hook
12. Recovery on plugin load
13. End-to-end testing
