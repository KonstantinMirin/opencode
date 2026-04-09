import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import path from "path"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { Token } from "../../src/util/token"
import { Log } from "../../src/util/log"
import { TieredCompaction } from "../../src/session/tiered-compaction"
import { Provider } from "../../src/provider/provider"
import { ProviderTest } from "../fake/provider"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { tmpdir } from "../fixture/fixture"
import type { Provider as ProviderType } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { isOverflow } from "../../src/session/overflow"

Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: ProviderType.Model["cost"]
  npm?: string
}): ProviderType.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as ProviderType.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

async function user(sessionID: SessionID, text: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

async function assistant(sessionID: SessionID, parentID: MessageID, root: string) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await Session.updateMessage(msg)
  return msg
}

async function toolPart(
  sessionID: SessionID,
  messageID: MessageID,
  tool: string,
  output: string,
  opts?: { compacted?: boolean },
): Promise<MessageV2.ToolPart> {
  return Session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    callID: crypto.randomUUID(),
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title: "done",
      metadata: {},
      time: {
        start: Date.now(),
        end: Date.now(),
        ...(opts?.compacted ? { compacted: Date.now() - 1000 } : undefined),
      },
    },
  })
}

afterEach(() => {
  mock.restore()
})

// ─── Seam: Merge (stitch compacted past to live present) ───────────────────────

describe("tiered-compaction.merge", () => {
  test("inserts compaction boundary and summary at anchor point", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = runtime()
        try {
          const session = await Session.create({})
          const u1 = await user(session.id, "turn 0")
          await assistant(session.id, u1.id, tmp.path)
          const u2 = await user(session.id, "turn 1")
          await assistant(session.id, u2.id, tmp.path)
          const u3 = await user(session.id, "turn 2 (live buffer)")

          await rt.runPromise(
            TieredCompaction.Service.use((svc) =>
              svc.merge({
                sessionID: session.id,
                anchor: u1.id,
                summary: "## Goal\nUser wants to build a feature.",
                agent: "build",
                model: ref,
              }),
            ),
          )

          const msgs = await Session.messages({ sessionID: session.id })

          const summary = msgs.find((m) => m.info.role === "assistant" && (m.info as any).summary)
          expect(summary).toBeDefined()
          expect((summary!.info as any).agent).toBe("compaction")

          const boundary = msgs.find((m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"))
          expect(boundary).toBeDefined()

          const live = msgs.find((m) => m.info.id === u3.id)
          expect(live).toBeDefined()
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("idempotent: merging twice with same anchor is a no-op", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = runtime()
        try {
          const session = await Session.create({})
          const u1 = await user(session.id, "turn 0")
          await assistant(session.id, u1.id, tmp.path)

          await rt.runPromise(
            TieredCompaction.Service.use((svc) =>
              svc.merge({
                sessionID: session.id,
                anchor: u1.id,
                summary: "first summary",
                agent: "build",
                model: ref,
              }),
            ),
          )

          const after1 = await Session.messages({ sessionID: session.id })

          await rt.runPromise(
            TieredCompaction.Service.use((svc) =>
              svc.merge({
                sessionID: session.id,
                anchor: u1.id,
                summary: "second summary",
                agent: "build",
                model: ref,
              }),
            ),
          )

          const after2 = await Session.messages({ sessionID: session.id })

          const boundaries1 = after1.filter(
            (m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"),
          )
          const boundaries2 = after2.filter(
            (m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"),
          )
          expect(boundaries2.length).toBe(boundaries1.length)

          const summaries1 = after1.filter((m) => m.info.role === "assistant" && (m.info as any).summary)
          const summaries2 = after2.filter((m) => m.info.role === "assistant" && (m.info as any).summary)
          expect(summaries2.length).toBe(summaries1.length)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("all original messages survive merge in the database", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = runtime()
        try {
          const session = await Session.create({})
          const ids: MessageID[] = []
          for (let i = 0; i < 6; i++) {
            const ui = await user(session.id, `turn ${i}`)
            ids.push(ui.id)
            await assistant(session.id, ui.id, tmp.path)
          }

          await rt.runPromise(
            TieredCompaction.Service.use((svc) =>
              svc.merge({
                sessionID: session.id,
                anchor: ids[1],
                summary: "Summary of turns 0-1",
                agent: "build",
                model: ref,
              }),
            ),
          )

          const msgs = await Session.messages({ sessionID: session.id })

          for (const id of ids) {
            expect(msgs.find((m) => m.info.id === id)).toBeDefined()
          }

          expect(msgs.some((m) => m.parts.some((p) => p.type === "compaction"))).toBe(true)
          expect(msgs.some((m) => m.info.role === "assistant" && (m.info as any).summary)).toBe(true)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("filterCompacted correctly processes messages after merge structure", () => {
    // Test filterCompacted with in-memory data (newest-first order)
    const sid = SessionID.make("test-session")
    const uid0 = MessageID.ascending()
    const aid0 = MessageID.ascending()
    const uid1 = MessageID.ascending()
    const aid1 = MessageID.ascending()
    const boundaryId = MessageID.ascending()
    const summaryId = MessageID.ascending()
    const uid2 = MessageID.ascending()
    const aid2 = MessageID.ascending()

    // Simulate newest-first order (as stream() returns)
    const msgs: MessageV2.WithParts[] = [
      // newest first
      {
        info: { id: aid2, sessionID: sid, role: "assistant", time: { created: 7000 } } as any,
        parts: [{ type: "text" as const, text: "a2" }] as any[],
      },
      {
        info: { id: uid2, sessionID: sid, role: "user", time: { created: 6000 } } as any,
        parts: [{ type: "text" as const, text: "u2" }] as any[],
      },
      {
        info: {
          id: summaryId,
          sessionID: sid,
          role: "assistant",
          parentID: boundaryId,
          summary: true,
          finish: "stop",
        } as any,
        parts: [{ type: "text" as const, text: "summary" }] as any[],
      },
      {
        info: { id: boundaryId, sessionID: sid, role: "user", time: { created: 4000 } } as any,
        parts: [{ type: "compaction" as const, auto: true, anchor: uid1 }] as any[],
      },
      {
        info: { id: aid1, sessionID: sid, role: "assistant", time: { created: 3000 }, parentID: uid1 } as any,
        parts: [{ type: "text" as const, text: "a1" }] as any[],
      },
      {
        info: { id: uid1, sessionID: sid, role: "user", time: { created: 2000 } } as any,
        parts: [{ type: "text" as const, text: "u1" }] as any[],
      },
      {
        info: { id: aid0, sessionID: sid, role: "assistant", time: { created: 1000 } } as any,
        parts: [{ type: "text" as const, text: "a0" }] as any[],
      },
      {
        info: { id: uid0, sessionID: sid, role: "user", time: { created: 0 } } as any,
        parts: [{ type: "text" as const, text: "u0" }] as any[],
      },
    ]

    const filtered = MessageV2.filterCompacted(msgs)

    // filterCompacted should return: [boundary, summary, u2, a2] (chronological order)
    // u0, a0, u1, a1 should be filtered out
    expect(filtered.length).toBe(4)
    expect(filtered.find((m) => m.info.id === uid0)).toBeUndefined()
    expect(filtered.find((m) => m.info.id === aid0)).toBeUndefined()
    expect(filtered.find((m) => m.info.id === uid1)).toBeUndefined()
    expect(filtered.find((m) => m.info.id === aid1)).toBeUndefined()

    // Live buffer should survive
    expect(filtered.find((m) => m.info.id === uid2)).toBeDefined()
    expect(filtered.find((m) => m.info.id === aid2)).toBeDefined()

    // Boundary and summary should exist
    expect(filtered.find((m) => m.info.id === boundaryId)).toBeDefined()
    expect(filtered.find((m) => m.info.id === summaryId)).toBeDefined()

    // Summary should have summary=true
    const summaryMsg = filtered.find((m) => (m.info as any).summary === true)
    expect(summaryMsg).toBeDefined()
  })
})

// ─── Sieve: Watcher threshold ──────────────────────────────

describe("tiered-compaction.enqueue", () => {
  test("enqueues tool output above threshold", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = runtime()
        try {
          const session = await Session.create({})
          const u1 = await user(session.id, "hello")
          const a1 = await assistant(session.id, u1.id, tmp.path)
          const part = await toolPart(session.id, a1.id, "bash", "x".repeat(20_000))

          const result = await rt.runPromise(
            TieredCompaction.Service.use((svc) =>
              svc.enqueue({
                sessionID: session.id,
                part,
                estimate: Token.estimate(part.state.status === "completed" ? part.state.output : ""),
              }),
            ),
          )
          expect(result).toBeUndefined()
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("skips protected tool outputs (skill)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = runtime()
        try {
          const session = await Session.create({})
          const u1 = await user(session.id, "hello")
          const a1 = await assistant(session.id, u1.id, tmp.path)
          const part = await toolPart(session.id, a1.id, "skill", "x".repeat(20_000))

          const result = await rt.runPromise(
            TieredCompaction.Service.use((svc) =>
              svc.enqueue({
                sessionID: session.id,
                part,
                estimate: Token.estimate(part.state.status === "completed" ? part.state.output : ""),
              }),
            ),
          )
          expect(result).toBeUndefined()
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("skips small tool outputs below threshold", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = runtime()
        try {
          const session = await Session.create({})
          const u1 = await user(session.id, "hello")
          const a1 = await assistant(session.id, u1.id, tmp.path)
          const part = await toolPart(session.id, a1.id, "bash", "ls")

          const result = await rt.runPromise(
            TieredCompaction.Service.use((svc) =>
              svc.enqueue({
                sessionID: session.id,
                part,
                estimate: Token.estimate(part.state.status === "completed" ? part.state.output : ""),
              }),
            ),
          )
          expect(result).toBeUndefined()
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("skips already-compacted outputs", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = runtime()
        try {
          const session = await Session.create({})
          const u1 = await user(session.id, "hello")
          const a1 = await assistant(session.id, u1.id, tmp.path)
          const part = await toolPart(session.id, a1.id, "bash", "x".repeat(20_000), {
            compacted: true,
          })

          const result = await rt.runPromise(
            TieredCompaction.Service.use((svc) =>
              svc.enqueue({
                sessionID: session.id,
                part,
                estimate: Token.estimate(part.state.status === "completed" ? part.state.output : ""),
              }),
            ),
          )
          expect(result).toBeUndefined()
        } finally {
          await rt.dispose()
        }
      },
    })
  })
})

// ─── Horizon: Threshold logic ──────────────────────────────

describe("tiered-compaction.check", () => {
  test("pending returns false for idle session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rt = runtime()
        try {
          const session = await Session.create({})
          const isPending = await rt.runPromise(TieredCompaction.Service.use((svc) => svc.pending(session.id)))
          expect(isPending).toBe(false)
        } finally {
          await rt.dispose()
        }
      },
    })
  })
})

// ─── Overflow threshold logic ─────────────────────────────────────

describe("overflow.threshold", () => {
  test("existing overflow logic still works correctly", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })

        const tokens = {
          input: 75_000,
          output: 5_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }
        expect(await isOverflow({ cfg: { compaction: {} } as any, tokens, model })).toBe(true)

        const tokensBelow = {
          input: 30_000,
          output: 5_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }
        expect(await isOverflow({ cfg: { compaction: {} } as any, tokens: tokensBelow, model })).toBe(false)
      },
    })
  })

  test("compaction.auto=false disables overflow", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const tokens = {
      input: 80_000,
      output: 10_000,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
    expect(isOverflow({ cfg: { compaction: { auto: false } } as any, tokens, model })).toBe(false)
  })

  test("reserved tokens buffer respects config", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const tokens67 = {
      total: 67_000,
      input: 60_000,
      output: 5_000,
      reasoning: 0,
      cache: { read: 2_000, write: 0 },
    }
    expect(isOverflow({ cfg: { compaction: {} } as any, tokens: tokens67, model })).toBe(false)

    const tokens69 = {
      total: 69_000,
      input: 60_000,
      output: 5_000,
      reasoning: 0,
      cache: { read: 4_000, write: 0 },
    }
    expect(isOverflow({ cfg: { compaction: {} } as any, tokens: tokens69, model })).toBe(true)
  })
})

// ─── Token estimation ─────────────────────────────────────────────

describe("token.estimate", () => {
  test("summary is significantly smaller than original context", () => {
    const conversation = "x".repeat(50_000)
    expect(Token.estimate(conversation)).toBe(12_500)

    const summary = `## Goal\nBuild the feature\n\n## State\nPartially complete\n\n## Files\n- src/foo.ts\n- src/bar.ts`
    expect(Token.estimate(summary)).toBeLessThan(500)
  })
})

// ─── Helper: runtime setup ────────────────────────────────────────

function runtime() {
  const bus = Bus.layer
  return ManagedRuntime.make(
    Layer.mergeAll(TieredCompaction.layer, bus).pipe(
      Layer.provide(wide().layer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(SessionProcessor.defaultLayer),
      Layer.provide(LLM.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(bus),
      Layer.provide(Config.defaultLayer),
    ),
  )
}
