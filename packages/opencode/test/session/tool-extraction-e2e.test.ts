import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Log } from "../../src/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID } from "../../src/session/schema"
import { Provider } from "../../src/provider/provider"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { Permission } from "../../src/permission"
import { LLM } from "../../src/session/llm"
import { Snapshot } from "../../src/snapshot"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ToolExtraction } from "../../src/session/tool-extraction"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { ModelID, ProviderID } from "../../src/provider/schema"

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
      test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: url } },
    },
  }
}

function fakeProcessor() {
  return Layer.succeed(
    SessionProcessor.Service,
    SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) =>
        Effect.succeed({
          message: input.assistantMessage,
          updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
          completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
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
const env = Layer.mergeAll(TestLLMServer.layer, ToolExtraction.layer.pipe(Layer.provideMerge(deps)))

const it = testEffect(env)

it.live.skip("extracts facts from large tool output using LLM", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const extraction = yield* ToolExtraction.Service

        const chat = yield* session.create({})
        const longOutput = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: /src/module${i}.ts`).join("\n")

        const userMsg = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: userMsg.id,
          sessionID: chat.id,
          type: "text",
          text: "What files are in src?",
        })

        const asstMsg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: userMsg.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        yield* session.updateMessage(asstMsg)

        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: asstMsg.id,
          sessionID: chat.id,
          type: "tool",
          callID: "call_extract_test",
          tool: "bash",
          state: {
            status: "completed",
            input: { cmd: "find /src -type f" },
            output: longOutput,
            title: "find",
            metadata: {},
            time: { start: Date.now() - 1000, end: Date.now() },
          },
        })

        yield* llm.text(
          "<extraction>\n## Key findings\n- 200 files in /src\n- Pattern: module0.ts through module199.ts\n\n## Files affected\n/src/module0.ts through /src/module199.ts\n</extraction>",
        )
        yield* extraction.extract({ sessionID: chat.id, part })
        yield* llm.wait(1)

        const msgs = yield* Effect.promise(() => Session.messages({ sessionID: chat.id }))
        const asst = msgs.find((m) => m.info.id === asstMsg.id)
        expect(asst).toBeDefined()

        const updatedPart = asst!.parts.find((p) => p.type === "tool" && p.id === part.id) as MessageV2.ToolPart
        expect(updatedPart.state.status).toBe("completed")
        if (updatedPart.state.status === "completed") {
          expect(updatedPart.state.time.compacted).toBeDefined()
          expect((updatedPart.state.metadata as Record<string, any>)?.extraction).toBe(true)
          expect(updatedPart.state.output).toContain("Key findings")
          expect(updatedPart.state.output.length).toBeLessThan(longOutput.length)
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)
