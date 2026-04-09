import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Provider } from "../provider/provider"
import { Session } from "."
import { SessionID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import { LLM } from "./llm"
import { Effect, Layer, ServiceMap } from "effect"
import { NotFoundError } from "@/storage/db"
import z from "zod"

export namespace ToolExtraction {
  const log = Log.create({ service: "session.tool-extraction" })

  const DEFAULT_EXTRACT_THRESHOLD = 5_000
  const PRUNE_PROTECTED_TOOLS = ["skill"]
  const CONTEXT_MESSAGES = 6

  export const Event = {
    Extracted: BusEvent.define("tool-extraction.extracted", z.object({ sessionID: SessionID.zod, partID: PartID.zod })),
  }

  export function shouldExtract(part: MessageV2.ToolPart, threshold = DEFAULT_EXTRACT_THRESHOLD): boolean {
    if (part.state.status !== "completed") return false
    if (part.state.time.compacted) return false
    if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) return false
    if (Token.estimate(part.state.output) < threshold) return false
    return true
  }

  export function structuredPreviewSync(part: MessageV2.ToolPart): string {
    if (part.state.status !== "completed") return "[Old tool result content cleared]"
    return structuredPreviewFromPart(part.state.output, part.tool, part.state.input, part.state.metadata)
  }

  function structuredPreviewFromPart(
    output: string,
    tool: string,
    input: Record<string, any> | undefined,
    metadata: Record<string, any> | undefined,
  ): string {
    const lines: string[] = []
    const diskPath = metadata?.outputPath as string | undefined
    const toolLine = `Tool: ${tool}`
    const argsLine = input && Object.keys(input).length > 0 ? `Args: ${JSON.stringify(input)}` : undefined
    const pathLine = diskPath ? `Full output: ${diskPath}` : undefined

    lines.push(`[Compacted tool result. ${toolLine}${pathLine ? `. ${pathLine}` : ""}]`)

    if (argsLine) lines.push(argsLine)

    const outputLines = output.split("\n")

    const errors = outputLines.filter((l) => /^error/i.test(l) || /FAIL|Error|error:|exception/i.test(l))
    if (errors.length > 0 && errors.length <= 10) {
      lines.push("")
      lines.push("Errors:")
      lines.push(...errors.slice(0, 10))
    }

    const tailCount = Math.min(5, outputLines.length)
    if (tailCount > 0 && outputLines.length > 1) {
      lines.push("")
      lines.push(`Last ${tailCount} lines:`)
      lines.push(...outputLines.slice(-tailCount))
    }

    return lines.join("\n")
  }

  const PROMPT = `You are extracting specific facts from a tool output that are relevant to the current task.

You are NOT summarizing. You are NOT paraphrasing. You are NOT interpreting.

Rules:
- Preserve exact file paths, line numbers, error messages, and configuration values
- If a command failed, preserve the exact error output
- Preserve the exact structure of any data formats (JSON, YAML, etc.)
- Omit only content that is clearly irrelevant to the task (boilerplate, decorative output, progress bars, repeated lines)
- When in doubt, keep it

The conversation context below shows what the user was working on. Use it to determine what facts from the tool output are relevant.`

  const extractWithLLM = Effect.fn("ToolExtraction.extractWithLLM")(function* (input: {
    sessionID: SessionID
    part: MessageV2.ToolPart
    context: string
  }) {
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const session = yield* Session.Service
    const plugin = yield* Plugin.Service

    const compactionAgent = yield* agents.get("compaction")
    if (!compactionAgent) return

    const resolved = compactionAgent.model
      ? yield* provider.getModel(compactionAgent.model.providerID, compactionAgent.model.modelID)
      : yield* provider
          .getSmallModel(input.sessionID as unknown as ProviderID)
          .pipe(
            Effect.flatMap((m) =>
              m
                ? Effect.succeed(m)
                : provider.defaultModel().pipe(Effect.flatMap((d) => provider.getModel(d.providerID, d.modelID))),
            ),
          )

    const state = input.part.state
    if (state.status !== "completed") return

    const output = state.output
    const diskPath = (state.metadata ?? {}).outputPath as string | undefined
    const outputSection = diskPath
      ? `The full output is saved at: ${diskPath}\nRead the file to find specific details if needed.\n\n<tool_output_preview>\n${output.slice(0, 8000)}\n</tool_output_preview>`
      : `<tool_output>\n${output}\n</tool_output>`

    const userMessage = `<conversation_context>\n${input.context}\n</conversation_context>\n\n<tool name="${input.part.tool}">\n${outputSection}\n</tool>\n\nExtract the relevant facts. Format your response as a single block:\n\n<extraction>\n## Key findings\n- {fact 1 with exact strings preserved}\n- {fact 2 with exact strings preserved}\n\n## Errors (if any)\n{exact error messages, stack traces}\n\n## Files affected (if any)\n{exact file paths and line numbers}\n\n## Data (if any)\n{exact JSON/YAML/config snippets that are relevant}\n</extraction>`

    const compacting = yield* plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )

    const systemPrompt = compacting.prompt ?? [PROMPT, ...compacting.context].join("\n\n")

    const text = yield* Effect.promise(async (signal) => {
      const result = await LLM.stream({
        agent: compactionAgent,
        user: undefined as unknown as MessageV2.User,
        system: [systemPrompt],
        tools: {},
        model: resolved,
        abort: signal,
        sessionID: input.sessionID,
        small: true,
        messages: [{ role: "user", content: userMessage }],
      })
      let out = ""
      for await (const event of result.fullStream) {
        if (event.type === "text-delta") out += event.text
      }
      return out
    })

    const extracted = text.match(/<extraction>([\s\S]*?)<\/extraction>/)?.[1]?.trim() ?? text.trim()
    if (!extracted) return

    const metadata = { ...(state.metadata ?? {}), extraction: true } as Record<string, any>
    if (diskPath) metadata.compactedPath = diskPath

    state.output = extracted
    state.time.compacted = Date.now()
    state.metadata = metadata
    yield* session.updatePart(input.part)

    log.info("extracted", {
      sessionID: input.sessionID,
      tool: input.part.tool,
      before: Token.estimate(output),
      after: Token.estimate(extracted),
    })
    yield* Effect.promise(() =>
      Bus.publish(Event.Extracted, {
        sessionID: input.sessionID,
        partID: input.part.id,
      }),
    )
  })

  const extract = Effect.fn("ToolExtraction.extract")(function* (input: {
    sessionID: SessionID
    part: MessageV2.ToolPart
  }) {
    const config = yield* Config.Service
    const cfg = yield* config.get()
    const threshold = cfg.compaction?.extract_threshold ?? DEFAULT_EXTRACT_THRESHOLD
    if (!shouldExtract(input.part, threshold)) return

    const session = yield* Session.Service
    const msgs = yield* session
      .messages({ sessionID: input.sessionID })
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
    if (!msgs) return

    const recentMsgs = msgs.slice(-CONTEXT_MESSAGES)
    const contextParts: string[] = []
    for (const msg of recentMsgs) {
      if (msg.info.role === "user") {
        const textParts = msg.parts
          .filter((p) => p.type === "text" && !p.synthetic)
          .map((p) => (p as MessageV2.TextPart).text)
          .join("\n")
        if (textParts) contextParts.push(`User: ${textParts}`)
      } else if (msg.info.role === "assistant") {
        const toolParts = msg.parts
          .filter((p) => p.type === "tool" && p.state.status === "completed")
          .map((p) => {
            const tp = p as MessageV2.ToolPart
            return `Assistant called ${tp.tool}(${JSON.stringify(tp.state.input ?? {}).slice(0, 200)})`
          })
          .join("; ")
        const textParts = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as MessageV2.TextPart).text)
          .join("\n")
        const summary = [textParts, toolParts].filter(Boolean).join(" | ")
        if (summary) contextParts.push(`Assistant: ${summary.slice(0, 500)}`)
      }
    }
    const context = contextParts.join("\n\n")

    yield* extractWithLLM({
      sessionID: input.sessionID,
      part: input.part,
      context,
    }).pipe(
      Effect.catch((err) => {
        log.error("extraction failed", { error: String(err) })
        return Effect.void
      }),
    )
  })

  interface ServiceShape {
    extract: typeof extract
  }

  export class Service extends ServiceMap.Service<Service, ServiceShape>()("@opencode/ToolExtraction") {}

  export const layer: Layer.Layer<
    Service,
    never,
    Config.Service | Session.Service | Agent.Service | Plugin.Service | Provider.Service | LLM.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({ extract })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(LLM.defaultLayer),
    ),
  )
}
