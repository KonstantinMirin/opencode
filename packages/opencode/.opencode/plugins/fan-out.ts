import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type {
  OpencodeClient,
  Session,
  SessionStatus,
  EventSessionStatus,
  EventSessionIdle,
  Workspace,
} from "@opencode-ai/sdk/v2"
import { z } from "zod"

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

type Status = SessionStatus | undefined

interface Worker {
  sessionID: string
  workspaceID: string
  branch: string
  directory: string
  description: string
  agent: string
  status: Status
  queued: string[]
  hasReply: boolean
  retries: number
  originalPrompt: string
  originalAgent: string
}

interface Team {
  workers: Map<string, Worker>
}

// ──────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────

const teams = new Map<string, Team>()

const MAX_RETRIES = 3
const MAX_WORKERS = 10

function makeV2(baseUrl: string, directory: string, workspaceID?: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl,
    directory,
    experimental_workspaceID: workspaceID,
  })
}

function teamFor(sessionID: string): Team | undefined {
  return teams.get(sessionID)
}

function workerFor(sessionID: string, workerID: string): Worker | undefined {
  return teams.get(sessionID)?.workers.get(workerID)
}

function data<T>(res: { data?: T; response: Response }): T | undefined {
  if (res.response.status >= 400) return undefined
  return res.data
}

function statusLabel(s: Status): string {
  if (!s) return "unknown"
  if (s.type === "idle") return "idle"
  if (s.type === "busy") return "busy"
  if (s.type === "retry") return `retry (${s.attempt})`
  return "unknown"
}

function formatTeam(t: Team): string {
  const lines: string[] = []
  for (const [id, w] of t.workers) {
    const flags: string[] = []
    if (w.hasReply) flags.push("has reply")
    if (w.queued.length > 0) flags.push(`${w.queued.length} queued`)
    const suffix = flags.length > 0 ? ` | ${flags.join(", ")}` : ""
    lines.push(`- ${id.slice(0, 12)} (${w.agent}): ${statusLabel(w.status)} [${w.branch}]${suffix}`)
  }
  return lines.join("\n")
}

// ──────────────────────────────────────────────────────────────
// Plugin
// ──────────────────────────────────────────────────────────────

const FanOutPlugin: Plugin = async (input: PluginInput) => {
  const baseUrl = input.serverUrl.origin

  const v2 = makeV2(baseUrl, input.directory)

  async function ensureTeam(leadID: string): Promise<Team | undefined> {
    const existing = teams.get(leadID)
    if (existing && existing.workers.size > 0) return existing

    const children = await v2.session
      .children({ sessionID: leadID })
      .then((r) => data(r))
      .catch(() => undefined)
    if (!children || children.length === 0) return undefined

    const workspaces = await v2.experimental.workspace
      .list()
      .then((r) => data(r))
      .catch(() => undefined)
    const wsMap = workspaces ? new Map(workspaces.map((ws) => [ws.id, ws])) : new Map<string, any>()

    let statuses: Record<string, SessionStatus> | undefined
    try {
      statuses = await v2.session.status().then((r) => data(r))
    } catch {}

    const team: Team = { workers: new Map() }
    for (const child of children) {
      if (!child.workspaceID) continue
      const ws = wsMap.get(child.workspaceID)
      if (!ws) continue

      const desc = child.title?.replace(/ \(worker\)$/, "") ?? "recovered"
      const worker: Worker = {
        sessionID: child.id,
        workspaceID: ws.id,
        branch: ws.branch ?? ws.name,
        directory: ws.directory ?? "",
        description: desc,
        agent: "build",
        status: statuses?.[child.id],
        queued: [],
        hasReply: false,
        retries: 0,
        originalPrompt: "",
        originalAgent: "build",
      }
      team.workers.set(child.id, worker)
    }

    if (team.workers.size === 0) return undefined
    teams.set(leadID, team)
    return team
  }

  // ── Tools ───────────────────────────────────────────────

  const spawn_workers = tool({
    description:
      "Spawn parallel worker agents in isolated git worktrees. One team per lead — merge or dismiss existing workers before spawning a new team.",
    args: {
      tasks: z
        .array(
          z.object({
            description: z.string().describe("Short task label"),
            prompt: z.string().describe("Full task instructions for the worker"),
            agent: z.string().default("build").describe("Agent type: build, verify, or custom"),
            worktree: z.string().optional().describe("Reuse an existing worktree name (enables build→verify pattern)"),
          }),
        )
        .min(1)
        .max(MAX_WORKERS)
        .describe("Tasks to delegate to workers"),
    },
    async execute(args, ctx) {
      const leadID = ctx.sessionID
      const existing = teamFor(leadID)
      if (existing && existing.workers.size > 0) {
        return (
          `Team already exists with ${existing.workers.size} worker(s).\n` +
          `Use merge_worker or dismiss_worker first.\n\n` +
          `Current team:\n${formatTeam(existing)}`
        )
      }

      const team: Team = { workers: new Map() }

      const results: Array<{
        description: string
        sessionID?: string
        branch?: string
        error?: string
      }> = []

      // Resolve worktree reuses
      const worktreeMap = new Map<string, { workspaceID: string; branch: string; directory: string }>()

      for (const task of args.tasks) {
        if (task.worktree && worktreeMap.has(task.worktree)) {
          // Reuse existing worktree — no creation needed
          const info = worktreeMap.get(task.worktree)!
          try {
            const sessionRes = await v2.session.create({
              parentID: leadID,
              workspaceID: info.workspaceID,
              title: `${task.description} (worker)`,
            })
            const session = data(sessionRes)
            if (!session) {
              results.push({ description: task.description, error: "Failed to create session" })
              continue
            }

            await v2.session
              .promptAsync({
                sessionID: session.id,
                agent: task.agent,
                parts: [{ type: "text", text: task.prompt }],
              })
              .catch(() => {})

            const worker: Worker = {
              sessionID: session.id,
              workspaceID: info.workspaceID,
              branch: info.branch,
              directory: info.directory,
              description: task.description,
              agent: task.agent,
              status: { type: "busy" },
              queued: [],
              hasReply: false,
              retries: 0,
              originalPrompt: task.prompt,
              originalAgent: task.agent,
            }
            team.workers.set(session.id, worker)
            results.push({ description: task.description, sessionID: session.id, branch: info.branch })
          } catch (err) {
            results.push({ description: task.description, error: String(err) })
          }
          continue
        }

        // Create new worktree + session
        try {
          const wsRes = await v2.experimental.workspace.create({
            type: "worktree",
            branch: null,
          })
          const ws = data(wsRes)
          if (!ws) {
            results.push({ description: task.description, error: "Failed to create workspace" })
            continue
          }

          const sessionRes = await v2.session.create({
            parentID: leadID,
            workspaceID: ws.id,
            title: `${task.description} (worker)`,
          })
          const session = data(sessionRes)
          if (!session) {
            await v2.experimental.workspace.remove({ id: ws.id }).catch(() => {})
            results.push({ description: task.description, error: "Failed to create session" })
            continue
          }

          await v2.session
            .promptAsync({
              sessionID: session.id,
              agent: task.agent,
              parts: [{ type: "text", text: task.prompt }],
            })
            .catch(() => {})

          const branch = ws.branch ?? ws.name
          const dir = ws.directory ?? ""
          worktreeMap.set(branch, { workspaceID: ws.id, branch, directory: dir })

          const worker: Worker = {
            sessionID: session.id,
            workspaceID: ws.id,
            branch,
            directory: dir,
            description: task.description,
            agent: task.agent,
            status: { type: "busy" },
            queued: [],
            hasReply: false,
            retries: 0,
            originalPrompt: task.prompt,
            originalAgent: task.agent,
          }
          team.workers.set(session.id, worker)
          results.push({ description: task.description, sessionID: session.id, branch })
        } catch (err) {
          results.push({ description: task.description, error: String(err) })
        }
      }

      if (team.workers.size > 0) {
        teams.set(leadID, team)
      }

      const succeeded = results.filter((r) => r.sessionID)
      const failed = results.filter((r) => r.error)

      let out = `Spawned ${succeeded.length} worker(s).\n`
      if (failed.length > 0) {
        out += `\nFailed (${failed.length}):\n`
        for (const f of failed) out += `  - ${f.description}: ${f.error}\n`
      }
      out += `\nWorkers:\n`
      for (const s of succeeded) {
        out += `  - ${s.sessionID} (${s.branch}) — ${s.description}\n`
      }
      out += `\nUse worker_status to monitor, read_worker to inspect, message_worker to follow up.`
      return out
    },
  })

  const worker_status = tool({
    description: "Check status of all workers in your team.",
    args: {},
    async execute(_args, ctx) {
      const team = await ensureTeam(ctx.sessionID)
      if (!team || team.workers.size === 0) {
        return "No active workers. Use spawn_workers to create a team."
      }

      // Refresh status from SDK as fallback + self-healing
      try {
        const statuses = await v2.session.status().then((r) => data(r))
        if (statuses) {
          for (const [id, worker] of team.workers) {
            const fresh = statuses[id]
            if (!fresh) continue
            const wasBusy = worker.status?.type === "busy" || worker.status?.type === "retry"
            worker.status = fresh
            if (wasBusy && fresh.type === "idle" && worker.queued.length > 0) {
              const msg = worker.queued.shift()!
              const scoped = makeV2(baseUrl, input.directory, worker.workspaceID)
              await scoped.session.promptAsync({ sessionID: id, parts: [{ type: "text", text: msg }] }).catch(() => {})
              worker.status = { type: "busy" }
            }
          }
        }
      } catch {}

      let out = `Team (${team.workers.size} worker(s)):\n\n`
      out += `Worker         | Agent   | Status     | Worktree | Description\n`
      out += `-------------- | ------- | ---------- | -------- | -----------\n`
      for (const [id, w] of team.workers) {
        const short = id.slice(0, 14).padEnd(14)
        const agent = w.agent.padEnd(7)
        const st = statusLabel(w.status).padEnd(10)
        const br = w.branch.slice(0, 8).padEnd(8)
        const flags: string[] = []
        if (w.hasReply) flags.push("reply")
        if (w.queued.length > 0) flags.push(`${w.queued.length}q`)
        const suffix = flags.length > 0 ? ` [${flags.join(",")}]` : ""
        out += `${short} | ${agent} | ${st} | ${br} | ${w.description}${suffix}\n`
      }
      return out
    },
  })

  const read_worker = tool({
    description: "Read recent messages from a worker session. Use this to inspect worker output.",
    args: {
      sessionID: z.string().describe("Worker session ID"),
      limit: z.number().default(5).describe("Number of recent messages to read"),
    },
    async execute(args, ctx) {
      const team = await ensureTeam(ctx.sessionID)
      if (!team) return "No active team."
      const worker = team.workers.get(args.sessionID)
      if (!worker) return `Worker ${args.sessionID} not found in your team.`

      const scoped_v2 = makeV2(baseUrl, input.directory, worker.workspaceID)
      const msgs = await scoped_v2.session
        .messages({ sessionID: args.sessionID, limit: args.limit })
        .then((r) => data(r))
        .catch(() => undefined)

      if (!msgs || msgs.length === 0) return "No messages yet."

      worker.hasReply = false

      const parts: string[] = []
      for (const msg of msgs) {
        const role = msg.info.role
        const textParts = msg.parts.filter((p: any) => p.type === "text")
        for (const tp of textParts) {
          parts.push(`[${role}]\n${(tp as any).text}\n`)
        }
      }
      return parts.join("\n---\n\n")
    },
  })

  const message_worker = tool({
    description:
      "Send a follow-up message to a worker. If the worker is busy, the message is queued and delivered automatically when it becomes idle.",
    args: {
      sessionID: z.string().describe("Worker session ID"),
      message: z.string().describe("Message to send"),
    },
    async execute(args, ctx) {
      const team = await ensureTeam(ctx.sessionID)
      if (!team) return "No active team."
      const worker = team.workers.get(args.sessionID)
      if (!worker) return `Worker ${args.sessionID} not found in your team.`

      const isIdle = !worker.status || worker.status.type === "idle"

      if (isIdle) {
        const scoped_v2 = makeV2(baseUrl, input.directory, worker.workspaceID)
        await scoped_v2.session.promptAsync({
          sessionID: args.sessionID,
          parts: [{ type: "text", text: args.message }],
        })
        worker.status = { type: "busy" }
        worker.hasReply = false
        return `Message delivered to ${args.sessionID.slice(0, 12)}.`
      }

      // Worker is busy — queue the message
      worker.queued.push(args.message)
      return `Worker ${args.sessionID.slice(0, 12)} is busy. Message queued (${worker.queued.length} pending). It will be delivered when the worker finishes.`
    },
  })

  const merge_worker = tool({
    description:
      "Merge a worker's changes into the main worktree. Fails on conflicts — you can then resolve manually, spawn a resolver agent, or dismiss.",
    args: {
      sessionID: z.string().describe("Worker session ID"),
    },
    async execute(args, ctx) {
      const team = await ensureTeam(ctx.sessionID)
      if (!team) return "No active team."
      const worker = team.workers.get(args.sessionID)
      if (!worker) return `Worker ${args.sessionID} not found in your team.`

      const isIdle = !worker.status || worker.status.type === "idle"
      if (!isIdle) return `Worker ${args.sessionID.slice(0, 12)} is still busy. Wait for it to finish.`

      // Check for dirty worktree
      try {
        const dirty = await input.$`git status --porcelain`.quiet()
        if (dirty.text().trim().length > 0) {
          return (
            `Main worktree has uncommitted changes. Commit or stash before merging.\n\n` +
            `Uncommitted files:\n${dirty.text()}`
          )
        }
      } catch {}

      // Show changed files
      let diff: string
      try {
        const pwd = await input.$`pwd`.quiet()
        console.log("pwd inside merge_worker:", pwd.text().trim())
        console.log("process.cwd():", process.cwd())
        console.log("input.directory:", input.directory)
        const st = await input.$`git status`.quiet()
        console.log("git status:", st.text())

        const baseBranch = await input.$`git branch --show-current`.quiet()
        const base = baseBranch.text().trim() || "HEAD"
        console.log(`Plugin executing: git diff --name-only ${base}..${worker.branch}`)
        const result = await input.$`git diff --name-only ${base}..${worker.branch}`.quiet()
        diff = result.text()
        console.log(`Plugin diff output: '${diff}'`)
      } catch (err) {
        console.log("Plugin diff failed:", err)
        diff = "(could not diff)"
      }

      // Attempt merge
      try {
        await input.$`git merge --no-edit ${worker.branch}`.quiet()
      } catch (err: any) {
        // Get conflicts
        let conflicts = ""
        try {
          const result = await input.$`git diff --name-only --diff-filter=U`.quiet()
          conflicts = result.text()
        } catch {}
        return (
          `Merge conflict in worker ${args.sessionID.slice(0, 12)} (${worker.branch}).\n\n` +
          `Changed files:\n${diff}\n\n` +
          `Conflicts:\n${conflicts}\n\n` +
          `Options:\n` +
          `1. Resolve conflicts manually (edit files, git add, git commit)\n` +
          `2. Spawn a resolver: spawn_workers([{ agent: "build", worktree: "${worker.branch}", prompt: "Resolve merge conflicts in ..." }])\n` +
          `3. Dismiss: dismiss_worker("${args.sessionID}", force=true)`
        )
      }

      // Merge succeeded — clean up
      try {
        await v2.experimental.workspace.remove({ id: worker.workspaceID })
      } catch {}

      team.workers.delete(args.sessionID)
      if (team.workers.size === 0) teams.delete(ctx.sessionID)

      return `Merged ${worker.branch} successfully.\n\nChanged files:\n${diff}`
    },
  })

  const dismiss_worker = tool({
    description:
      "Dismiss a worker — cancel its session and clean up the worktree. Use force=true to kill a busy worker.",
    args: {
      sessionID: z.string().describe("Worker session ID"),
      force: z.boolean().default(false).describe("Force kill a busy worker"),
    },
    async execute(args, ctx) {
      const team = await ensureTeam(ctx.sessionID)
      if (!team) return "No active team."
      const worker = team.workers.get(args.sessionID)
      if (!worker) return `Worker ${args.sessionID} not found in your team.`

      const isBusy = worker.status?.type === "busy"
      if (isBusy && !args.force) {
        return `Worker ${args.sessionID.slice(0, 12)} is busy. Use force=true to kill it.`
      }

      // Abort merge if one is in progress
      try {
        await input.$`git rev-parse MERGE_HEAD`.quiet()
        await input.$`git merge --abort`.quiet()
      } catch {}

      // Abort session if running
      if (isBusy) {
        await v2.session.abort({ sessionID: args.sessionID }).catch(() => {})
      }

      // Remove worktree
      await v2.experimental.workspace.remove({ id: worker.workspaceID }).catch(() => {})

      team.workers.delete(args.sessionID)
      if (team.workers.size === 0) teams.delete(ctx.sessionID)

      return `Dismissed worker ${args.sessionID.slice(0, 12)} (${worker.branch}).`
    },
  })

  // ── Hooks ───────────────────────────────────────────────

  const eventHook: NonNullable<Hooks["event"]> = async ({ event }) => {
    // Track session.status events for all known workers
    if (event.type === "session.status") {
      const { sessionID, status } = (event as EventSessionStatus).properties
      for (const [, team] of teams) {
        const worker = team.workers.get(sessionID)
        if (!worker) continue

        const wasBusy = worker.status?.type === "busy" || worker.status?.type === "retry"
        worker.status = status

        // Worker transitioned to idle → deliver queued message
        if (wasBusy && status.type === "idle") {
          if (worker.queued.length > 0) {
            const msg = worker.queued.shift()!
            const scoped_v2 = makeV2(baseUrl, input.directory, worker.workspaceID)
            await scoped_v2.session
              .promptAsync({
                sessionID,
                parts: [{ type: "text", text: msg }],
              })
              .catch(() => {})
            worker.status = { type: "busy" }
          } else {
            worker.hasReply = true
          }
        }

        // Circuit breaker on retry
        if (status.type === "retry") {
          worker.retries++
          if (worker.retries >= MAX_RETRIES) {
            // Archive failed session
            await v2.session.update({ sessionID, time: { archived: Date.now() } }).catch(() => {})

            // Create new session in same worktree
            const newSession = await v2.session
              .create({
                parentID: sessionID,
                workspaceID: worker.workspaceID,
                title: `${worker.description} (retry)`,
              })
              .then((r) => data(r))
              .catch(() => undefined)

            if (newSession) {
              await v2.session.promptAsync({
                sessionID: newSession.id,
                agent: worker.originalAgent,
                parts: [{ type: "text", text: worker.originalPrompt }],
              })

              team.workers.delete(sessionID)
              worker.sessionID = newSession.id
              worker.retries = 0
              worker.status = { type: "busy" }
              worker.hasReply = false
              team.workers.set(newSession.id, worker)
            }
          }
        }

        // Reset retries on success
        if (status.type === "idle") {
          worker.retries = 0
        }
      }
    }

    // session.idle is redundant but belt-and-suspenders for message delivery
    if (event.type === "session.idle") {
      const { sessionID } = (event as EventSessionIdle).properties
      for (const [, team] of teams) {
        const worker = team.workers.get(sessionID)
        if (!worker) continue
        if (worker.queued.length > 0 && worker.status?.type !== "busy") {
          const msg = worker.queued.shift()!
          const scoped_v2 = makeV2(baseUrl, input.directory, worker.workspaceID)
          await scoped_v2.session
            .promptAsync({
              sessionID,
              parts: [{ type: "text", text: msg }],
            })
            .catch(() => {})
          worker.status = { type: "busy" }
        } else {
          worker.hasReply = true
        }
      }
    }
  }

  const toolDefinitionHook: NonNullable<Hooks["tool.definition"]> = async (input, output) => {
    // Inject current team status into fan-out tool descriptions
    const relevantTools = new Set([
      "spawn_workers",
      "worker_status",
      "read_worker",
      "message_worker",
      "merge_worker",
      "dismiss_worker",
    ])
    if (!relevantTools.has(input.toolID)) return

    // Find any team for any lead — we don't know the sessionID here
    let teamStatus = ""
    for (const [leadID, team] of teams) {
      if (team.workers.size > 0) {
        teamStatus = `\n\nCurrent team (${leadID.slice(0, 12)}):\n${formatTeam(team)}`
        break
      }
    }

    if (teamStatus) {
      output.description += teamStatus
    }
  }

  const systemTransformHook: NonNullable<Hooks["experimental.chat.system.transform"]> = async (input, output) => {
    // Find team for current session
    const sid = input.sessionID
    if (!sid) return
    const team = teamFor(sid)
    if (!team || team.workers.size === 0) return

    const lines = [
      `## Active Worker Team (${team.workers.size} worker(s))`,
      ``,
      `Use worker_status to check progress.`,
      `Use read_worker to inspect output (workers with "has reply" have new output).`,
      `Use message_worker to send follow-up instructions (queued if worker is busy).`,
      `Use merge_worker to integrate completed work.`,
      `Use dismiss_worker to cancel and clean up.`,
      ``,
      `When all workers are done, merge results one at a time and verify before merging the next.`,
    ]
    output.system.push(lines.join("\n"))
  }

  return {
    tool: {
      spawn_workers,
      worker_status,
      read_worker,
      message_worker,
      merge_worker,
      dismiss_worker,
    },
    event: eventHook,
    "tool.definition": toolDefinitionHook,
    "experimental.chat.system.transform": systemTransformHook,
  }
}

export { teams as _teams }
export default FanOutPlugin
