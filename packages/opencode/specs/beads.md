# Beads: Task DAG System

## Problem Statement

The current `todowrite` tool is a flat list with no structure, no dependency tracking, and no enforcement. The LLM writes the entire list on every call (full replacement semantics), never reads from the DB, and after compaction the conversation-level task state is destroyed — only a compressed narrative remains. The DB rows become orphans.

## Design Principle: Wrap `bd`, Fall Back to `todowrite`

Beads is a mature CLI tool (`bd`) with MIT license, DAG traversal, dependency resolution, hierarchical IDs, `--json` output on all commands, and an embedded Dolt database. We do **not** reimplement it. Instead:

- The `beads` tool **shells out to `bd`** for all state mutations and queries
- `bd` is the source of truth — `.beads/` directory on disk
- If `bd` is not on PATH, the tool **degrades to the existing `todowrite` behavior** (flat list, no DAG, no dependencies)
- The `insertReminders` hook reads state from `bd ready --json` (or falls back to `TodoTable`)
- The TUI sidebar renders beads data (or falls back to the current `TodoItem`)

This means zero reinvention and a graceful degradation path.

## Data Flow

```
                          ┌─────────┐
                          │  bd CLI │
                          │ .beads/ │
                          └────┬────┘
                               │
                    ┌──────────┼──────────┐
                    │          │          │
                    ▼          │          │
            insertReminders()  │   BeadsTool
            (reads bd,       │   (calls bd
             injects into    │    commands)
             conversation)   │          │
                    │          │          │
                    ▼          │          ▼
            ┌──────────┐      │   ┌──────────┐
            │ Synthetic │      │   │ Tool     │
            │ reminder  │      │   │ response │
            │ part on   │      │   │ in       │
            │ user msg  │      │   │ conversation│
            └──────────┘      │   └─────┬──────┘
                              │         │
                              │         ▼
                              │   ┌──────────┐
                              │   │ Compaction│
                              │   │ may       │
                              │   │ summarize │
                              │   └─────┬──────┘
                              │         │
                              │         ▼
                              └──►┌──────────┐
                                  │next loop  │
                                  │re-injects │
                                  │from bd    │
                                  └──────────┘

         ┌─────────────────────────────────────────────┐
         │  FALLBACK: bd not on PATH                   │
         │  BeadsTool degrades to todowrite semantics  │
         │  insertReminders reads from TodoTable       │
         │  TUI renders current TodoItem               │
         └─────────────────────────────────────────────┘
```

`bd` is the single source of truth (or `TodoTable` in fallback mode). The conversation only ever sees derived views. No duplication, no reconciliation.

## Tool Interface

The `beads` tool replaces `todowrite`. When `bd` is available, it shells out:

| Command                            | `bd` call                                     | Fallback                           |
| ---------------------------------- | --------------------------------------------- | ---------------------------------- |
| `beads.plan({tasks})`              | Creates issues via `bd create` + `bd dep add` | Creates rows in `TodoTable` (flat) |
| `beads.complete({id, result})`     | `bd close <id> --reason "..."`                | Update `TodoTable` row status      |
| `beads.fail({id, reason})`         | `bd update <id> --status failed`              | Update `TodoTable` row status      |
| `beads.skip({id, reason})`         | `bd close <id> --wontfix`                     | Update `TodoTable` row status      |
| `beads.next()`                     | `bd ready --json`                             | Scan `TodoTable` for first pending |
| `beads.status()`                   | `bd list --json`                              | Read all `TodoTable` rows          |
| `beads.add({content, depends_on})` | `bd create` + `bd dep add`                    | Append to `TodoTable`              |
| `beads.retry({id})`                | Re-run command step if present                | N/A (fallback has no commands)     |
| `beads.claim({id})`                | `bd update <id> --claim`                      | Update status to in_progress       |

### `bd` is not available

When `bd` is not found on PATH:

- The tool falls back to the current `todowrite` semantics (flat list in `TodoTable`)
- No DAG, no dependencies, no formulas — same as today
- `insertReminders` reads from `TodoTable` instead of `bd ready --json`
- The TUI renders the current `TodoItem` component

This is a zero-friction default. Users who install `bd` get the full experience; everyone else gets what they have today.

## Interaction Diagrams

### 1. Current flow: `todowrite`

```
User sends message
        │
        ▼
 ┌──────────────┐
 │  Loop iter   │◄──────────────────────────────────┐
 │  (step N)    │                                    │
 └──────┬───────┘                                    │
        │                                            │
        ▼                                            │
  insertReminders()                                  │
  (plan/build reminders)                             │
        │                                            │
        ▼                                            │
  LLM processes messages                             │
  ──► decides to update todo list                    │
        │                                            │
        ▼                                            │
  calls todowrite({todos: [                          │
    {content, status, priority},                      │
    ...entire list...                                │
  ]})                                                │
        │                                            │
        ▼                                            │
  Tool handler:                                      │
    1. Replaces ALL rows in TodoTable                │
    2. Publishes Event.Updated                        │
    3. Returns JSON of full list                      │
        │                                            │
        ▼                                            │
  JSON goes into conversation as tool result ────────┘
        │
        ▼
  ...many turns later...
        │
        ▼
  ┌─────────────────┐
  │   COMPACTION     │
  └────────┬────────┘
           │
           ▼
  Tool call/result summarized to:
  "[Compacted] Tool: todowrite"
  + 5 tail lines of JSON
           │
           ▼
  Task state effectively LOST
  (DB still has rows but LLM
   never reads from DB)
```

### 2. Proposed flow: `beads` tool (bd available)

```
User: "Add login endpoint and tests"
        │
        ▼
 ┌──────────────┐
 │  Loop iter 1 │
 └──────┬───────┘
        │
        ▼
  insertReminders()  ◄── NEW: inject beads state from bd
        │               "→ Task 1: ... [in_progress]"
        │               "  Task 2: ... [blocked by 1]"
        ▼
  LLM calls beads.plan({tasks: [
    {content: "Explore auth patterns"},
    {content: "Implement login endpoint",
     depends_on: ["1"]},
    {content: "Write tests",
     depends_on: ["2"]},
  ]})
        │
        ▼
  ┌──────────────────────────────────────┐
  │  BeadsTool.execute()                  │
  │   1. bd create "Explore auth..."       │
  │   2. bd create "Implement login..."   │
  │   3. bd dep add <id2> blocks <id1>    │
  │   4. bd create "Write tests"          │
  │   5. bd dep add <id3> blocks <id2>    │
  │   6. Return:                           │
  │      "Plan created. 3 tasks.           │
  │       Next: bd-1 'Explore auth...'     │
  │       Use beads.claim({id: 'bd-1'})    │
  │       to start working on it."         │
  └──────────────┬───────────────────────┘
        │
        ▼
  LLM calls beads.claim({id: "bd-1"})
  ┌──────────────────────────────────────┐
  │  BeadsTool.execute()                  │
  │   1. bd update bd-1 --claim           │
  │   2. Return: "Claimed bd-1.           │
  │       Status: in_progress"            │
  └──────────────┬───────────────────────┘
        │
        ▼
  LLM works on task 1, calls beads.complete({id: "bd-1",
    result: "Found auth patterns in src/auth/..."})
        │
        ▼
  ┌──────────────────────────────────────┐
  │  BeadsTool.execute()                  │
  │   1. bd close bd-1 --reason "..."     │
  │   2. bd ready --json → task 2 ready   │
  │   3. Return:                           │
  │      "Task bd-1 ✓. Next: bd-2         │
  │       'Implement login endpoint'"      │
  └──────────────┬───────────────────────┘
        │
        ▼
 ┌──────────────┐
 │  Loop iter N │
 └──────┬───────┘
        │
        ▼
  insertReminders()  ◄── RE-INJECTS from bd ready --json:
        │              "✅ bd-1: Explore auth — completed
        │               → bd-2: Implement endpoint — in_progress
        │                 bd-3: Write tests — blocked by bd-2"
        ▼
  ...LLM continues...
```

### 3. Compaction resilience

```
                    ╔════════════════════════╗
                    ║  CONVERSATION LAYER    ║
                    ║  (ephemeral, compacted)║
                    ╚══════╤═════════════════╝
                           │
                  tool calls/results
                  get summarized/
                  truncated by compaction
                           │
                           ▼
                    ┌──────────────┐
                    │   Compaction  │
                    │   runs, cuts  │
                    │   old messages│
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │filterCompacted│
                    │ed() removes  │
                    │everything    │
                    │before anchor │
                    └──────┬───────┘
                           │
                           ▼
                 ┌─────────────────────┐
                 │  Next loop iter:    │
                 │  insertReminders()  │
                 └─────────┬───────────┘
                           │
                 ┌─────────▼───────────┐
                 │  Run bd ready --json│
                 │  (or read TodoTable │
                 │   if bd unavailable)│
                 └─────────┬───────────┘
                           │
                           ▼
                 ┌─────────────────────┐
                 │  Inject synthetic  │
                 │  part on user msg:  │
                 │                     │
                 │  <system-reminder>  │
                 │  Task progress:    │
                 │  ✅ bd-1: Explore.. │
                 │  ✅ bd-2: Implement│
                 │  → bd-3: Write test│
                 │    bd-4: bun test  │
                 │  </system-reminder> │
                 └─────────────────────┘

                    ╔════════════════════════╗
                    ║  .beads/ (on disk)     ║
                    ║  (authoritative,       ║
                    ║   survives compaction)║
                    ╚════════════════════════╝
```

The key insight: conversation is a cache that gets invalidated. `bd` state is the source of truth that gets re-projected into the conversation on every turn.

### 4. Fallback mode (bd not available)

```
  BeadsTool.execute() called
        │
        ▼
  ┌──────────────────────────────────────┐
  │  whichBd() returns null               │
  │  → switch to fallback mode            │
  │                                       │
  │  beads.plan → TodoTable.replaceAll() │
  │  beads.complete → TodoTable.setStatus()│
  │  beads.next → scan TodoTable          │
  │  beads.status → read all TodoTable    │
  │                                       │
  │  Same as todowrite, just              │
  │  operational interface instead of      │
  │  full-replacement                     │
  └──────────────────────────────────────┘
```

In fallback mode, the tool still uses operational commands (plan, complete, next, status) but stores state in `TodoTable` with no DAG or dependencies. `insertReminders` reads from `TodoTable`. The TUI renders `TodoItem`. No `bd` dependency required.

### 5. Deterministic command steps (formulas)

For formula steps with a `command` field, execution is deterministic:

```
  LLM calls beads.complete({id: "bd-3", result: "implementation done"})
        │
        ▼
  ┌──────────────────────────────────────────────┐
  │  BeadsTool.complete() handler:               │
  │   1. bd close bd-3 --reason "..."            │
  │   2. bd ready --json → bd-4 now ready        │
  │                                               │
  │   3. IF bd-4 has command metadata:            │
  │      → run the command via Process.text()     │
  │      → capture exit code + output              │
  │      → IF exit code 0:                         │
  │          bd close bd-4 --reason "exited 0"    │
  │          auto-unblock dependents              │
  │          return to LLM:                        │
  │            "bd-3 ✓. bd-4 ✓ (exited 0, 1.2s)  │
  │             Next: bd-5 'Run tests'"             │
  │      → IF exit code ≠ 0:                       │
  │          bd update bd-4 --status failed         │
  │          return to LLM:                        │
  │            "bd-3 ✓. bd-4 ✗ (exited 1)         │
  │             Output: [truncated]                │
  │             Fix the issues and beads.retry()" │
  └──────────────────────────────────────────────┘
```

Note: command steps are stored as `bd` issue metadata (labels or body fields), not in a separate formula table. The formula concept becomes a `bd create` batch operation.

### 6. Skip / deviate flow

```
  LLM: "I need to check an unrelated bug first"
  LLM calls: beads.add({
    content: "Investigate unrelated bug",
    priority: "high",
    depends_on: [],
  })
        │
        ▼
  ┌────────────────────────────────────┐
  │  BeadsTool.add() handler:           │
  │   1. bd create "Investigate..." -p 0│
  │   2. bd ready --json               │
  │   3. Return:                         │
  │      "Created bd-5 'Investigate...' │
  │       No blockers. Ready to claim.   │
  │       Current: bd-3 'Write tests'   │
  │       Skip with beads.skip({id: 'bd-3'})"│
  └────────────────────────────────────┘

  LLM calls beads.skip({id: "bd-3", reason: "deferring"})
  ┌────────────────────────────────────┐
  │  BeadsTool.skip() handler:          │
  │   1. bd close bd-3 --wontfix       │
  │   2. Dependents auto-unblocked by bd│
  └────────────────────────────────────┘
```

Deviation is allowed but explicit. The LLM calls `beads.add()`, `beads.skip()`, or `beads.cancel()` to account for what it's doing. The system reminder on the next turn reflects current state regardless.

## Implementation: `whichBd` Detection

```typescript
// src/tool/beads.ts

const BD_PATH_CACHE: { path: string | null; checked: boolean } = { path: null, checked: false }

async function whichBd(): Promise<string | null> {
  if (BD_PATH_CACHE.checked) return BD_PATH_CACHE.path
  try {
    const result = await Process.text(["which", "bd"], { nothrow: true })
    BD_PATH_CACHE.path = result.exitCode === 0 ? result.text.trim() : null
  } catch {
    BD_PATH_CACHE.path = null
  }
  BD_PATH_CACHE.checked = true
  return BD_PATH_CACHE.path
}
```

On first call, check if `bd` is on PATH. Cache the result. If found, all operations shell out to `bd`. If not, fall back to `TodoTable`.

## Code Integration Points

### 1. BeadsTool (`src/tool/beads.ts`) — replaces `TodoWriteTool`

The tool definition detects `bd` availability at init time and routes to either `bd` CLI calls or `TodoTable` fallback.

### 2. insertReminders (`src/session/prompt.ts:258`)

After the existing plan/build logic, add:

```typescript
// After existing plan/build reminders
const beadsReminder = yield * getBeadsReminder(input.session)
if (beadsReminder) {
  userMessage.parts.push({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: beadsReminder,
    synthetic: true,
  })
}
```

Where `getBeadsReminder` runs `bd ready --json` (or reads `TodoTable` in fallback) and formats the state as a reminder string. This runs every loop iteration, so even after compaction, full task state is re-injected.

### 3. TUI Sidebar (`src/cli/cmd/tui/feature-plugins/sidebar/todo.tsx`)

Replace the current sidebar with a beads-aware view. When `bd` is available, render hierarchical task tree with dependency indicators. When not, render current `TodoItem` list.

### 4. TodoTable → fallback

Keep `TodoTable` as-is. It becomes the fallback storage when `bd` is not available. No schema migration needed.

### 5. Event bus

Add `Bead.Event.Updated` (same pattern as `Todo.Event.Updated`). When `bd` mutates state, publish the event so the TUI sidebar updates in real-time. In fallback mode, `Todo.Event.Updated` fires as before.

### 6. Tool registry

Replace `todo` in the tool registry with `beads`. The tool ID can be `todowrite` (for backwards compatibility with agent prompts) or `beads` — agent permissions already reference the tool by name in `src/agent/agent.ts`.

## `bd` CLI Commands Used

| BeadsTool operation | `bd` command                                                                    | Notes                                             |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| plan (create batch) | `bd create "..." -p N` for each task, then `bd dep add <child> blocks <parent>` | Created in a batch, returns IDs                   |
| claim               | `bd update <id> --claim`                                                        | Sets status to in_progress, assigns current agent |
| complete            | `bd close <id> --reason "..."`                                                  | Sets status to closed                             |
| fail                | `bd update <id> --status failed`                                                | Sets status to failed                             |
| skip                | `bd close <id> --wontfix`                                                       | Sets status to wontfix                            |
| next                | `bd ready --json`                                                               | Returns unblocked tasks                           |
| status              | `bd list --json`                                                                | Returns all tasks                                 |
| add                 | `bd create "..." + dep add`                                                     | Single task creation                              |
| retry               | `bd update <id> --status open`                                                  | Re-open a failed task                             |

All commands support `--json` for structured output. The tool parses JSON and formats it for the LLM.

## Why Not a Plugin?

The existing `opencode-beads` plugin demonstrates the ceiling of what plugins can do:

- Text injection via `client.session.prompt()` — but only on session start and compaction events, **not every turn**
- Custom tools via the `tool` hook — but can't **replace** `todowrite`
- No **TUI sidebar** integration — plugins render in the message stream only
- No **insertReminders** hook — can't inject synthetic parts at the prompt level

Replacing `todowrite` and wiring into `insertReminders` requires modifying core opencode code. The `bd` dependency is external and optional — but the tool replacement and per-turn re-injection are architectural changes that must live in core.

## Migration Steps

1. Create `src/tool/beads.ts` — new tool that shells out to `bd` or falls back to `TodoTable`
2. Update `src/tool/registry.ts` — replace `TodoWriteTool` with `BeadsTool`
3. Update `src/session/prompt.ts:insertReminders` — add beads reminder injection
4. Update `src/agent/agent.ts` — change `todowrite` permission references to `beads`
5. Update TUI — replace `sidebar/todo.tsx` with beads-aware view, add `TodoWrite` → `Beads` component mapping
6. Update server API — add `GET /session/:id/beads` endpoint that returns `bd list --json` (or `TodoTable` in fallback)
7. Keep `TodoTable` and `Todo.Service` — they remain the fallback
8. Remove `todowrite.txt` prompt — the tool interface itself enforces workflow
