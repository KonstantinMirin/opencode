# Architectural Plan for Fan-Out Plugin Gaps

## 1. Recovery on Restart (State Rehydration & Orphan GC)

Since the plugin operates entirely in-memory (`teams` Map), a server crash or restart loses the worker state while the actual worktrees and sessions remain in the database.

**Lazy Rehydration:**
- Recovery cannot happen at plugin init time because `ctx.sessionID` (the lead agent) is not available until a tool or hook is invoked.
- We will implement a `getOrRecoverTeam(ctx.sessionID)` helper that checks the in-memory map. If empty, it attempts to recover the team from the DB.

**Recovery Flow:**
1. Fetch `v2.session.children({ sessionID: leadID })`.
2. Filter for children that have a `workspaceID`.
3. Fetch `v2.experimental.workspace.list()`.
4. For each child with a workspace:
   - If the workspace exists, rebuild the `Worker` state.
   - We extract `branch` and `directory` from the workspace object.
   - We extract the task description from the session `title` (which we formatted as `Task Description (worker)` during spawn).
   - We fetch `v2.session.status()` to get the current `idle`/`busy`/`retry` state.
   - We check `v2.session.messages()` to see if the last message is from the assistant (setting `hasReply = true`).
5. **Orphan GC (Garbage Collection):** 
   - If a child session has a `workspaceID` but that workspace no longer exists in `workspace.list()`, it is an orphan (the worktree was deleted but the session remained). We will issue `v2.session.delete({ sessionID: child.id })`.
   - If `workspace.list()` contains a `worktree` type workspace with branch prefix `opencode/` that has no associated session across *any* parent, it should ideally be cleaned up. To keep the scope safe, we will focus on GCing orphaned sessions for the current lead.

## 2. The `merge_worker` Git Flow

Git operations are executed using `input.$` which runs in the `input.directory` (the main worktree where the lead agent operates). 

**Pre-flight Checks:**
1. Check if the worker is `idle`.
2. Ensure the main worktree is clean before merging. We will run `git status --porcelain`. If dirty, `merge_worker` will reject the operation and instruct the lead agent to commit or stash changes first.
3. Identify the current branch (`git branch --show-current`) so we know what we are merging into.

**Merge Scenarios:**
- **Clean Merge:** 
  - `git merge --no-edit <worker-branch>` succeeds.
  - The plugin automatically calls `v2.experimental.workspace.remove({ id: worker.workspaceID })` which cleans up the worktree folder and deletes the `<worker-branch>`.
  - The worker is removed from the `teams` Map.
- **Merge Conflicts:**
  - `git merge` fails with exit code > 0.
  - We run `git diff --name-only --diff-filter=U` to get conflicting files.
  - **Crucial:** We do *not* run `git merge --abort`. We leave the main worktree in the conflict state.
  - The tool returns the conflict list and tells the lead agent its options: manually edit files & commit, spawn a resolver agent, or abort.
- **Aborting a Conflict via `dismiss_worker`:**
  - If a merge is actively in conflict and the lead decides to `dismiss_worker`, we must prevent the main worktree from being permanently stuck.
  - `dismiss_worker` will check if `git MERGE_HEAD` exists and points to the worker's branch. If so, it will run `git merge --abort` in the main worktree before deleting the worker's workspace.

## 3. `session.status` Polling & Synchronization

Workers autonomously transition between `busy`, `idle`, and `retry`. The lead agent relies on accurate status to know when to read output, send queued messages, or merge.

**Synchronization Strategy:**
1. **Event Bus (Primary):** The `event` hook listens for `session.status` and `session.idle` events, updating the `teams` map in real-time. This is where queued messages are flushed.
2. **On-Demand Polling (Fallback/Verification):** 
   - Whenever `worker_status` is invoked, we call `v2.session.status()`. This returns a `Map<SessionID, SessionStatus>` mapping.
   - We iterate over the returned map and reconcile our in-memory `teams` state.
   - *Self-Healing:* If we discover a worker transitioned from `busy` to `idle` during this poll (meaning we missed the event), we will flush its message queue right then.
3. **Availability Fallback:** If `v2.session.status()` fails (e.g. timeout), the tool catches the error and gracefully falls back to the last known in-memory state, preventing the lead agent from crashing.
