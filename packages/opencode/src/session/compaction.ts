import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/db"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow } from "./overflow"
import {
  stripSummaryMeta,
  CONTINUATION_PROMPT,
  extractRecentFiles,
  formatFileReminders,
  truncateToTokens,
  REATTACH_LIMITS,
  continuationWithSession,
} from "./compaction-prompt"
import { ToolExtraction } from "./tool-extraction"
import { TieredCompaction } from "./tiered-compaction"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000
  const PRUNE_PROTECTED_TOOLS = ["skill"]
  const IDLE_THRESHOLD_MS = 60 * 60_000
  const IDLE_PRESSURE_FLOOR = PRUNE_PROTECT * 0.5
  const STALEABLE_TOOLS = new Set(["read", "bash", "grep", "glob", "list", "write", "edit", "multiedit"])

  export interface Interface {
    readonly isOverflow: (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) => Effect.Effect<boolean>
    readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
    readonly process: (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) => Effect.Effect<"continue" | "stop">
    readonly create: (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Bus.Service
    | Config.Service
    | Session.Service
    | Agent.Service
    | Plugin.Service
    | SessionProcessor.Service
    | Provider.Service
    | TieredCompaction.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const config = yield* Config.Service
      const session = yield* Session.Service
      const agents = yield* Agent.Service
      const plugin = yield* Plugin.Service
      const processors = yield* SessionProcessor.Service
      const provider = yield* Provider.Service
      const tiered = yield* TieredCompaction.Service

      const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
        tokens: MessageV2.Assistant["tokens"]
        model: Provider.Model
      }) {
        return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
      })

      // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
      // calls, then erases output of older tool calls to free context space.
      // For outputs above the Sieve threshold, enqueues for LLM extraction instead
      // of just marking as compacted (P4: Prune-Sieve integration).
      const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
        const cfg = yield* config.get()
        if (cfg.compaction?.prune === false) return
        log.info("pruning")

        const msgs = yield* session
          .messages({ sessionID: input.sessionID })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
        if (!msgs) return

        const extractThreshold = cfg.compaction?.extract_threshold ?? 5_000
        const idleMs = (cfg.compaction?.idle_threshold_minutes ?? 60) * 60_000

        // P7: Detect idle session. Only activates when:
        // 1) Last assistant message is older than idle threshold (prompt cache expired)
        // 2) Context has enough tool output to justify clearing (> IDLE_PRESSURE_FLOOR)
        // When idle, only staleable tool outputs (read, bash, grep, etc.) are
        // cleared — analysis/skill results are preserved regardless of age.
        const lastAssistant = msgs.findLast((m) => m.info.role === "assistant")
        const isIdle = lastAssistant
          ? Date.now() - (lastAssistant.info as MessageV2.Assistant).time.created > idleMs
          : false

        let total = 0
        let pruned = 0
        let idleTotal = 0
        let idlePruned = 0
        const toPrune: MessageV2.ToolPart[] = []
        const toExtract: MessageV2.ToolPart[] = []
        let turns = 0

        loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
          const msg = msgs[msgIndex]
          if (msg.info.role === "user") turns++
          if (turns < 2) continue
          if (msg.info.role === "assistant" && msg.info.summary) break loop
          for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
            const part = msg.parts[partIndex]
            if (part.type === "tool")
              if (part.state.status === "completed") {
                if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
                if (part.state.time.compacted) break loop
                const estimate = Token.estimate(part.state.output)
                total += estimate
                if (total > PRUNE_PROTECT) {
                  pruned += estimate
                  if (ToolExtraction.shouldExtract(part, extractThreshold)) {
                    toExtract.push(part)
                  } else {
                    toPrune.push(part)
                  }
                }
                // Track idle-eligible tokens separately
                if (isIdle && STALEABLE_TOOLS.has(part.tool)) {
                  idleTotal += estimate
                  if (!part.state.time.compacted) idlePruned += estimate
                }
              }
          }
        }

        // P7: When idle AND context is pressured, clear staleable tools aggressively
        const idleActive = isIdle && idleTotal > IDLE_PRESSURE_FLOOR
        if (idleActive) {
          for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
            const msg = msgs[msgIndex]
            if (msg.info.role === "assistant" && msg.info.summary) break
            for (const part of msg.parts) {
              if (
                part.type === "tool" &&
                part.state.status === "completed" &&
                STALEABLE_TOOLS.has(part.tool) &&
                !part.state.time.compacted &&
                !toPrune.includes(part) &&
                !toExtract.includes(part)
              ) {
                if (ToolExtraction.shouldExtract(part, extractThreshold)) {
                  toExtract.push(part)
                } else {
                  toPrune.push(part)
                  pruned += Token.estimate(part.state.output)
                }
              }
            }
          }
        }

        log.info("found", { pruned, total, extract: toExtract.length, compact: toPrune.length, isIdle, idleActive })
        for (const part of toExtract) {
          if (part.state.status === "completed") {
            yield* tiered
              .enqueue({ sessionID: input.sessionID, part, estimate: Token.estimate(part.state.output) })
              .pipe(Effect.catch(() => Effect.void))
          }
        }
        if (pruned > PRUNE_MINIMUM) {
          for (const part of toPrune) {
            if (part.state.status === "completed") {
              part.state.time.compacted = Date.now()
              yield* session.updatePart(part)
            }
          }
          log.info("pruned", { count: toPrune.length })
        }
      })

      const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
        parentID: MessageID
        messages: MessageV2.WithParts[]
        sessionID: SessionID
        auto: boolean
        overflow?: boolean
      }) {
        const parent = input.messages.findLast((m) => m.info.id === input.parentID)
        if (!parent || parent.info.role !== "user") {
          throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
        }
        const userMessage = parent.info

        let messages = input.messages
        let replay:
          | {
              info: MessageV2.User
              parts: MessageV2.Part[]
            }
          | undefined
        if (input.overflow) {
          const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
          for (let i = idx - 1; i >= 0; i--) {
            const msg = input.messages[i]
            if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
              replay = { info: msg.info, parts: msg.parts }
              messages = input.messages.slice(0, i)
              break
            }
          }
          const hasContent =
            replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
          if (!hasContent) {
            replay = undefined
            messages = input.messages
          }
        }

        const agent = yield* agents.get("compaction")
        const model = agent.model
          ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
          : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
        // Allow plugins to inject context or replace compaction prompt.
        const compacting = yield* plugin.trigger(
          "experimental.session.compacting",
          { sessionID: input.sessionID },
          { context: [], prompt: undefined },
        )
        const defaultPrompt = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need.
- Tool calls will be REJECTED and will waste your only turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

Provide a detailed summary of the conversation above for continuing the work.
The summary that you construct will be used so that another agent can read it and continue the work.

First, write an <analysis> block where you chronologically analyze each section of the conversation. Identify the user's requests, your approach, key decisions, code details, errors encountered, and user feedback. Double-check for technical accuracy and completeness.

Then, write a <summary> block following this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---

Respond in the same language as the user's messages in the conversation.

Remember: respond with <analysis> then <summary> tags only. No tool calls.`

        const prompt = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
        const msgs = structuredClone(messages)
        yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
        const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })
        const ctx = yield* InstanceState.context
        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.model.variant,
          summary: true,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        }
        yield* session.updateMessage(msg)
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model,
        })
        const result = yield* processor
          .process({
            user: userMessage,
            agent,
            sessionID: input.sessionID,
            tools: {},
            system: [],
            messages: [
              ...modelMessages,
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
              },
            ],
            model,
          })
          .pipe(Effect.onInterrupt(() => processor.abort()))

        if (result === "compact") {
          processor.message.error = new MessageV2.ContextOverflowError({
            message: replay
              ? "Conversation history too large to compact - exceeds model context limit"
              : "Session too large to compact - context exceeds model limit even after stripping media",
          }).toObject()
          processor.message.finish = "error"
          yield* session.updateMessage(processor.message)
          return "stop"
        }

        if (result === "continue" && input.auto) {
          if (replay) {
            const original = replay.info
            const replayMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: original.agent,
              model: original.model,
              format: original.format,
              tools: original.tools,
              system: original.system,
              variant: original.model.variant,
            })
            for (const part of replay.parts) {
              if (part.type === "compaction") continue
              const replayPart =
                part.type === "file" && MessageV2.isMedia(part.mime)
                  ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                  : part
              yield* session.updatePart({
                ...replayPart,
                id: PartID.ascending(),
                messageID: replayMsg.id,
                sessionID: input.sessionID,
              })
            }
          }

          if (!replay) {
            // P5: Collect recently referenced files for re-attachment
            const filePaths = extractRecentFiles(messages)
            let fileReminder = ""
            if (filePaths.length > 0) {
              const entries: { path: string; content: string }[] = []
              let totalTokens = 0
              for (const fp of filePaths) {
                if (totalTokens >= REATTACH_LIMITS.maxTotal) break
                const raw = yield* Effect.tryPromise({
                  try: () => Bun.file(fp).text(),
                  catch: () => new Error("file read failed"),
                }).pipe(Effect.catch(() => Effect.succeed(null as string | null)))
                if (!raw) continue
                const capped = truncateToTokens(raw, REATTACH_LIMITS.maxPerFile)
                const tokens = Math.ceil(capped.length / 4)
                if (totalTokens + tokens > REATTACH_LIMITS.maxTotal) break
                entries.push({ path: fp, content: capped })
                totalTokens += tokens
              }
              fileReminder = formatFileReminders(entries)
            }

            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              continuationWithSession(input.sessionID) +
              fileReminder
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }

        if (processor.message.error) return "stop"

        // Strip <analysis>/<thinking> blocks from summary text parts
        const allMsgs = yield* session
          .messages({ sessionID: input.sessionID })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))
        const summaryMsg = allMsgs.find(
          (m) => m.info.role === "assistant" && m.info.summary && m.info.id === processor.message.id,
        )
        if (summaryMsg) {
          for (const part of summaryMsg.parts) {
            if (part.type === "text" && part.text) {
              const stripped = stripSummaryMeta(part.text)
              if (stripped !== part.text) {
                part.text = stripped
                yield* session.updatePart(part)
              }
            }
          }
        }

        if (result === "continue") yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
        return result
      })

      const create = Effect.fn("SessionCompaction.create")(function* (input: {
        sessionID: SessionID
        agent: string
        model: { providerID: ProviderID; modelID: ModelID }
        auto: boolean
        overflow?: boolean
      }) {
        const msg = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: input.model,
          sessionID: input.sessionID,
          agent: input.agent,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "compaction",
          auto: input.auto,
          overflow: input.overflow,
        })
      })

      return Service.of({
        isOverflow,
        prune,
        process: processCompaction,
        create,
      })
    }),
  )

  export const defaultLayer = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(Provider.defaultLayer),
        Layer.provide(Session.defaultLayer),
        Layer.provide(SessionProcessor.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(Bus.layer),
        Layer.provide(Config.defaultLayer),
        Layer.provide(TieredCompaction.defaultLayer),
      ),
    ),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    return runPromise((svc) => svc.isOverflow(input))
  }

  export async function prune(input: { sessionID: SessionID }) {
    return runPromise((svc) => svc.prune(input))
  }

  export const process = fn(
    z.object({
      parentID: MessageID.zod,
      messages: z.custom<MessageV2.WithParts[]>(),
      sessionID: SessionID.zod,
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    (input) => runPromise((svc) => svc.process(input)),
  )

  export const create = fn(
    z.object({
      sessionID: SessionID.zod,
      agent: z.string(),
      model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    (input) => runPromise((svc) => svc.create(input)),
  )
}
