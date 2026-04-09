# Beads: Task DAG System

## Problem Statement

The current `todowrite` tool is a flat list with no structure, no dependency tracking, and no enforcement. The LLM writes the entire list on every call (full replacement semantics), never reads from the DB, and after compaction the conversation-level task state is destroyed — only a compressed narrative remains. The DB rows become orphans.

## Architecture: DB as Source of Truth, Conversation as Derived View

### Data Flow

```
                          ┌─────────┐
                          │   DB    │
                          │BeadTable│
                          │FormulaTable│
                          └────┬────┘
                               │
                    ┌──────────┼──────────┐
                    │          │          │
                    ▼          │          │
            insertReminders()  │   BeadsTool
            (reads DB,       │   (writes DB,
             injects into    │    reads DB)
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
                                  │from DB    │
                                  └──────────┘
```

The DB is the single source of truth. The conversation only ever sees derived views — either the tool I/O (which compaction can destroy) or the synthetic reminder (which is re-generated from DB on every turn). No duplication, no reconciliation needed.

## Schema

### BeadTable

```sql
CREATE TABLE bead (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES bead(id),
  formula_id    TEXT REFERENCES formula(id),
  content       TEXT NOT NULL,
  status        TEXT NOT NULL,  -- pending | blocked | in_progress | completed | failed | cancelled
  priority      TEXT NOT NULL,  -- high | medium | low
  position      INTEGER NOT NULL,
  depends_on    TEXT,           -- JSON array of bead IDs (for DAG)
  command       TEXT,           -- optional shell command for deterministic steps
  result        TEXT,           -- completion note, error message, output summary
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX bead_session_idx ON bead(session_id);
CREATE INDEX bead_formula_idx ON bead(formula_id);
```

### FormulaTable

```sql
CREATE TABLE formula (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  steps         TEXT NOT NULL,  -- JSON: ordered array of step templates
  created_at    INTEGER NOT NULL
);
```

### Step template format (stored in `formula.steps`)

```json
[
  { "content": "Explore codebase for relevant files" },
  { "content": "Plan the implementation" },
  { "content": "Implement the changes" },
  { "content": "Run linter and type checker", "command": "bun run lint && bun run typecheck" },
  { "content": "Run tests", "command": "bun test" }
]
```

Steps with a `command` field are verified deterministically (exit code 0 = pass).

## Tool Interface

The `beads` tool replaces `todowrite` with operational commands instead of full-replacement semantics:

```
beads.plan({tasks: [...]})         → creates task DAG, returns full state
beads.start({id})                  → marks task in_progress, returns next-task context
beads.complete({id, result: "..."}) → marks done, auto-unblocks dependents, returns what's next
beads.fail({id, reason: "..."})     → marks failed, blocks dependents
beads.skip({id, reason: "..."})    → marks cancelled, unblocks dependents
beads.next()                        → returns the next unblocked task (the one agent should work on)
beads.status()                      → returns full task DAG state (for re-orientation)
beads.add({content, depends_on, after}) → inserts a new task into the DAG
beads.retry({id})                   → re-runs a failed command step
```

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

**Problem:** The LLM only _writes_ to the DB. It never _reads_ from it. After compaction, the conversation copy is destroyed. The DB rows are orphaned — no mechanism to reinject them.

### 2. Proposed flow: `beads` tool

```
User: "Add login endpoint and tests"
        │
        ▼
 ┌──────────────┐
 │  Loop iter 1 │
 └──────┬───────┘
        │
        ▼
  insertReminders()  ◄── NEW: inject beads state from DB
        │               "→ Task 1: ... [in_progress]"
        │               "  Task 2: ... [blocked by 1]"
        ▼
  LLM calls beads.plan({tasks: [
    {content: "Explore auth patterns"},
    {content: "Implement login endpoint",
     depends_on: ["1"]},
    {content: "Write tests",
     depends_on: ["2"]},
    {command: "bun test",
     depends_on: ["3"]},
  ]})
        │
        ▼
  ┌──────────────────────────────────────┐
  │  BeadsTool.execute()                  │
  │   1. Create BeadTable rows            │
  │      with dependencies, positions     │
  │   2. Mark task 1 as in_progress        │
  │   3. Mark 2,3,4 as blocked            │
  │   4. Publish Bead.Event.Created       │
  │   5. Return:                           │
  │      "Plan created. 4 tasks.           │
  │       Next: Task 1 'Explore auth...'  │
  │       → in_progress"                   │
  └──────────────┬───────────────────────┘
        │
        ▼
  LLM works on task 1 (uses explore agent, etc.)
        │
        ▼
  LLM calls beads.complete({id: "1",
    result: "Found auth patterns in src/auth/..."})
        │
        ▼
  ┌──────────────────────────────────────┐
  │  BeadsTool.execute()                  │
  │   1. Set task 1 status = completed     │
  │   2. Check dependents of task 1:       │
  │      task 2's depends_on = [] now      │
  │      → mark task 2 as pending          │
  │   3. Return:                           │
  │      "Task 1 ✓. Next: Task 2           │
  │       'Implement login endpoint'"      │
  └──────────────┬───────────────────────┘
        │
        ▼
 ┌──────────────┐
 │  Loop iter N │
 └──────┬───────┘
        │
        ▼
  insertReminders()  ◄── RE-INJECTS from DB:
        │              "✅ Task 1: Explore auth — completed
        │               ✅ Task 2: Implement endpoint — completed
        │               → Task 3: Write tests — in_progress
        │                 Task 4: bun test — blocked by 3"
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
                 │  Read DB → BeadTable │
                 │  WHERE session_id=?  │
                 │  ORDER BY position   │
                 └─────────┬───────────┘
                           │
                           ▼
                 ┌─────────────────────┐
                 │  Inject synthetic  │
                 │  part on user msg:  │
                 │                     │
                 │  <system-reminder>  │
                 │  Task progress:     │
                 │  ✅ 1. Explore...    │
                 │  ✅ 2. Implement... │
                 │  → 3. Write tests   │
                 │    4. bun test      │
                 │  </system-reminder> │
                 └─────────────────────┘

                    ╔════════════════════════╗
                    ║  DATABASE LAYER        ║
                    ║  (authoritative,       ║
                    ║   survives compaction) ║
                    ╚════════════════════════╝
```

The key insight: conversation is a cache that gets invalidated. DB is the source of truth that gets re-projected into the conversation on every turn.

### 4. Formula instantiation

```
User: "/add-feature auth-rate-limiting"

        │
        ▼
  Command handler matches "add-feature" formula
        │
        ▼
  ┌────────────────────────────────────────────────┐
  │  FormulaTable lookup:                           │
  │   name: "add-feature"                           │
  │   steps: [                                      │
  │     {content: "Explore codebase"},              │
  │     {content: "Plan implementation"},           │
  │     {content: "Implement changes"},             │
  │     {content: "Run lint+typecheck",              │
  │      command: "bun run lint && bun typecheck"},  │
  │     {content: "Run tests",                      │
  │      command: "bun test"}                       │
  │   ]                                            │
  └────────────────────┬───────────────────────────┘
                       │
                       ▼
  ┌────────────────────────────────────────────────┐
  │  Create user message with:                     │
  │   agent: "build"                               │
  │   part.type: "subtask" (or "text")             │
  │   text: "Implement auth rate limiting"         │
  │                                                │
  │  BeadsTool.plan() is called implicitly:        │
  │   → creates 5 Bead rows with                  │
  │     formula_id = "add-feature"                 │
  │     each.depends_on = [previous]               │
  │     step 1 → in_progress                       │
  │     steps 2-5 → blocked                         │
  └────────────────────────────────────────────────┘
                       │
                       ▼
              Loop starts, insertReminders
              injects task state, LLM begins
```

### 5. Deterministic command steps (CI-like)

For formula steps with a `command` field:

```
  LLM calls beads.complete({id: "3", result: "implementation done"})
        │
        ▼
  ┌──────────────────────────────────────────────┐
  │  BeadsTool.complete() handler:               │
  │   1. Set task 3 = completed                   │
  │   2. Check dependents: task 4 unblocked       │
  │                                               │
  │   3. IF task 4 has .command:                  │
  │      → run the command immediately            │
  │        (not via LLM, via Process)             │
  │      → capture exit code + output              │
  │      → IF exit code 0:                         │
  │          mark task 4 = completed               │
  │          auto-unblock task 5                   │
  │          return to LLM:                        │
  │            "Task 3 ✓.                          │
  │             Task 4 'Run lint+typecheck' ✓      │
  │             (command exited 0, 1.2s)           │
  │             Next: Task 5 'Run tests'"           │
  │      → IF exit code ≠ 0:                       │
  │          mark task 4 = failed                  │
  │          block task 5                          │
  │          return to LLM:                        │
  │            "Task 3 ✓.                          │
  │             Task 4 'Run lint+typecheck' ✗      │
  │             (command exited 1)                 │
  │             Output: [truncated]                │
  │             Fix the issues and retry"          │
  └──────────────────────────────────────────────┘
        │
        ▼
  LLM sees task 4 failed, fixes code,
  calls beads.retry({id: "4"})
        │
        ▼
  Re-runs command, etc.
```

The `command` field makes certain steps globally deterministic — the system runs them, not the LLM. The LLM never gets a chance to skip them or lie about the result. The exit code is the truth.

### 6. Skip / deviate flow

```
  LLM: "I need to check an unrelated bug first"
  LLM calls: beads.add({
    content: "Investigate unrelated bug",
    priority: "high",
    depends_on: [],       // no deps, can start immediately
    after: "3"            // insert after task 3 in display order
  })
        │
        ▼
  ┌────────────────────────────────────┐
  │  BeadsTool.add() handler:           │
  │   1. Insert new row in BeadTable    │
  │   2. Recalculate positions          │
  │   3. Since depends_on = [],          │
  │      status = pending (not blocked) │
  │   4. Return:                         │
  │      "Added task 5 'Investigate...' │
  │       This task is unblocked.        │
  │       Current: Task 3 'Write tests'  │
  │       You may skip to Task 5 with    │
  │       beads.skip({id: '3'})"         │
  └────────────────────────────────────┘
        │
        ▼
  LLM either continues on task 3,
  or calls beads.skip({id: "3", reason: "deferring"})
        │
        ▼
  skip() marks task 3 as cancelled,
  auto-unblocks task 4 (was blocked by 3)
```

Deviation is allowed but must be explicit. The LLM calls `beads.add()`, `beads.skip()`, or `beads.cancel()` to account for what it's doing. The system reminder on the next turn will reflect the current state regardless.

## Code Integration Points

### insertReminders (src/session/prompt.ts:258)

This is where the beads reminder gets injected. Add after the existing plan/build logic:

```typescript
// After existing plan/build reminders
const beads = yield * Bead.Service
const activeBeads = yield * beads.list(input.session.id)
if (activeBeads.length > 0 && !activeBeads.every((b) => b.status === "completed" || b.status === "cancelled")) {
  const current = activeBeads.find((b) => b.status === "in_progress")
  const reminder = formatBeadsReminder(activeBeads)
  userMessage.parts.push({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: reminder,
    synthetic: true,
  })
}
```

This runs every iteration of the loop (step >= 1), so even after compaction, full task state is re-injected from DB.

### Migration from todowrite

1. Replace `TodoTable` with `BeadTable` (add `depends_on`, `formula_id`, `command`, `result` columns, rename)
2. Replace `TodoWriteTool` / `todowrite.txt` with `BeadsTool` and operational commands
3. Add `insertBeadsReminder` to `insertReminders` in `src/session/prompt.ts`
4. Add `FormulaTable` for predefined task templates
5. Remove the 167-line `todowrite.txt` prompt — the tool interface itself enforces the workflow now
6. Remove `TodoTable` and `Todo.Service` entirely
