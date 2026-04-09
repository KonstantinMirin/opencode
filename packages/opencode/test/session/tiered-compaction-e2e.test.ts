import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Log } from "../../src/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Token } from "../../src/util/token"
import { TieredCompaction } from "../../src/session/tiered-compaction"
import { Provider } from "../../src/provider/provider"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { Permission } from "../../src/permission"
import { LLM } from "../../src/session/llm"
import { Snapshot } from "../../src/snapshot"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider as ProviderType } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"

Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 10000, output: 2000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function createModel(): ProviderType.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: 10000, output: 2000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai-compatible" },
    options: {},
  } as ProviderType.Model
}

const model = createModel()

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fakeProcessor() {
  return Layer.succeed(
    SessionProcessor.Service,
    SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) =>
        Effect.succeed({
          message: input.assistantMessage,
          partFromToolCall() {
            return {
              id: PartID.ascending(),
              messageID: input.assistantMessage.id,
              sessionID: input.assistantMessage.sessionID,
              type: "tool" as const,
              callID: "fake",
              tool: "fake",
              state: { status: "pending" as const, input: {}, raw: "" },
            }
          },
          abort: Effect.fn("TestSessionProcessor.abort")(() => Effect.void),
          process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed("continue" as const)),
        }),
      ),
    }),
  )
}

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  fakeProcessor(),
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(TestLLMServer.layer, TieredCompaction.layer.pipe(Layer.provideMerge(deps)))

const it = testEffect(env)

const user = Effect.fn("E2E.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("E2E.assistant")(function* (sessionID: SessionID, parentID: MessageID, root: string) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const addTextPart = Effect.fn("E2E.addTextPart")(function* (sessionID: SessionID, messageID: MessageID, text: string) {
  const session = yield* Session.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text",
    text,
  })
})

const toolPart = Effect.fn("E2E.toolPart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  tool: string,
  output: string,
) {
  const session = yield* Session.Service
  return yield* session.updatePart({
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
      time: { start: Date.now(), end: Date.now() },
    },
  })
})

const pollUntilFalse = Effect.fn("E2E.pollUntilFalse")(function* (
  effect: Effect.Effect<boolean, never>,
  maxAttempts: number = 30,
  delayMs: number = 200,
) {
  for (let i = 0; i < maxAttempts; i++) {
    const result = yield* effect
    if (!result) return
    yield* Effect.sleep(`${delayMs} millis`)
  }
})

// ─── Horizon e2e: check() triggers summarization and writes summary to DB ───

it.live("tiered-compaction e2e: check() triggers summarization and writes summary to DB", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const svc = yield* TieredCompaction.Service

        yield* llm.text("## Goal\nUser wants to build a feature.\n## State\nPartially complete.")

        const chat = yield* session.create({})

        for (let i = 0; i < 6; i++) {
          const u = yield* user(chat.id, `turn ${i}: please help with step ${i}`)
          const a = yield* assistant(chat.id, u.id, dir)
          yield* addTextPart(chat.id, a.id, `Response for step ${i}`)
        }

        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        const tokens: MessageV2.Assistant["tokens"] = {
          total: 5500,
          input: 5000,
          output: 500,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }

        const triggered = yield* svc.check({
          sessionID: chat.id,
          tokens,
          model: mdl,
          agent: "build",
        })
        expect(triggered).toBe(true)

        yield* llm.wait(1)

        yield* pollUntilFalse(svc.pending(chat.id))

        const all = yield* Effect.promise(() => Session.messages({ sessionID: chat.id }))

        const boundaries = all.filter((m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"))
        expect(boundaries.length).toBe(1)

        const summaries = all.filter((m) => m.info.role === "assistant" && (m.info as any).summary === true)
        expect(summaries.length).toBe(1)

        const filtered = MessageV2.filterCompacted(MessageV2.stream(chat.id))
        expect(filtered.some((m) => m.parts.some((p) => p.type === "compaction"))).toBe(true)
        expect(filtered.some((m) => (m.info as any).summary === true)).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// ─── Race condition: user chats during summarization ────────────────

it.live("tiered-compaction e2e: messages added during summarization survive merge", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const svc = yield* TieredCompaction.Service

        const chat = yield* session.create({})

        const { promise: holdPromise, resolve: holdResolve } = defer<void>()
        yield* llm.hold("## Goal\nUser conversation summary.", holdPromise)

        for (let i = 0; i < 6; i++) {
          const u = yield* user(chat.id, `turn ${i}: help with step ${i}`)
          const a = yield* assistant(chat.id, u.id, dir)
          yield* addTextPart(chat.id, a.id, `Response for step ${i}`)
        }

        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        const tokens: MessageV2.Assistant["tokens"] = {
          total: 5500,
          input: 5000,
          output: 500,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }

        const triggered = yield* svc.check({
          sessionID: chat.id,
          tokens,
          model: mdl,
          agent: "build",
        })
        expect(triggered).toBe(true)

        yield* llm.wait(1)

        const isPending = yield* svc.pending(chat.id)
        expect(isPending).toBe(true)

        const u7 = yield* user(chat.id, "turn 6: new message during compaction")
        const a7 = yield* assistant(chat.id, u7.id, dir)
        yield* addTextPart(chat.id, a7.id, "Response during compaction")

        holdResolve(undefined)

        yield* pollUntilFalse(svc.pending(chat.id))

        const all = yield* Effect.promise(() => Session.messages({ sessionID: chat.id }))

        expect(all.find((m) => m.info.id === u7.id)).toBeDefined()
        expect(all.find((m) => m.info.id === a7.id)).toBeDefined()

        const boundaries = all.filter((m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"))
        expect(boundaries.length).toBe(1)

        const filtered = MessageV2.filterCompacted(MessageV2.stream(chat.id))
        expect(filtered.find((m) => m.info.id === u7.id)).toBeDefined()
        expect(filtered.find((m) => m.info.id === a7.id)).toBeDefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// ─── Sieve e2e: enqueue queues large tool output for extraction ───

it.live("tiered-compaction e2e: enqueue queues large tool output for compression", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const svc = yield* TieredCompaction.Service

        const chat = yield* session.create({})
        const u1 = yield* user(chat.id, "list files")
        const a1 = yield* assistant(chat.id, u1.id, dir)

        const originalOutput = "file1.ts\nfile2.ts\nfile3.ts\n" + "x".repeat(20_000)
        const part = yield* toolPart(chat.id, a1.id, "bash", originalOutput)

        yield* svc.enqueue({
          sessionID: chat.id,
          part,
          estimate: Token.estimate(originalOutput),
        })

        const isPendingAfterEnqueue = yield* svc.pending(chat.id)
        expect(isPendingAfterEnqueue).toBe(false)

        const refreshed = MessageV2.parts(a1.id)
        const tool = refreshed.find((p) => p.type === "tool")
        expect(tool).toBeDefined()
        if (tool && tool.type === "tool" && tool.state.status === "completed") {
          expect(tool.state.output).toBe(originalOutput)
          expect(tool.state.time.compacted).toBeUndefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)
