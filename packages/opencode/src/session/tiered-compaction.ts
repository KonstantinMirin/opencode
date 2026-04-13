/**
 * Asynchronous Tiered Context Compaction
 *
 * Three-component system that decouples context management from the
 * conversational flow, ensuring zero UI latency and unbounded session length.
 *
 *   Sieve   — Background tool-output extractor (data-tier compression)
 *   Horizon — Narrative summarizer (context-tier compression)
 *   Seam    — Async merge router (stitch compacted past to live present)
 *
 * Integration points with the existing session loop (prompt.ts):
 *   1. After each `finish-step` in processor.ts, call `watcher.enqueue()`
 *      for any large tool output instead of (or in addition to) the existing
 *      synchronous `prune` pass.
 *   2. After each `finish-step`, call `narrator.check()` instead of the
 *      current `isOverflow` check. This triggers at 50% capacity rather
 *      than ~100%.
 *   3. The merge is fully async — the main loop never awaits it. The next
 *      time `filterCompacted()` runs, it picks up the new boundary if one
 *      has been inserted by the background fiber.
 */

import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import { LLM } from "./llm"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Fiber, Layer, Queue, Scope, ServiceMap } from "effect"
import * as Stream from "effect/Stream"
import z from "zod"
import { APICallError, type ModelMessage } from "ai"
import { ProviderError } from "@/provider/error"

import PROMPT_NARRATIVE from "@/agent/prompt/narrative-compaction.txt"
import PROMPT_DELTA from "@/agent/prompt/narrative-compaction-delta.txt"
import PROMPT_MERGE from "@/agent/prompt/narrative-compaction-merge.txt"
import { ToolExtraction } from "./tool-extraction"
import { Identifier } from "@/id/id"
import {
  stripSummaryMeta,
  CONTINUATION_PROMPT,
  extractRecentFiles,
  formatFileReminders,
  truncateToTokens,
  REATTACH_LIMITS,
  continuationWithSession,
} from "./compaction-prompt"

export namespace TieredCompaction {
  const log = Log.create({ service: "session.tiered-compaction" })

  // ───────────────────────────────────────────────────────────────
  // Deliverable 1 — Session State Interfaces
  // ───────────────────────────────────────────────────────────────

  /**
   * Anchor marks the Turn X boundary at which background compaction began.
   * Everything at or before this message ID will be replaced by the summary
   * once it resolves. Messages after this ID form the "live buffer."
   */
  export interface Anchor {
    /** The message ID of the last user turn included in the compaction snapshot */
    readonly id: MessageID
    /** Timestamp when the anchor was established */
    readonly time: number
    /** Token count at anchor time — used to verify the merge is still valid */
    readonly tokens: number
    /** The agent that was active when the anchor was set */
    readonly agent: string
    /** The model configuration at anchor time */
    readonly model: { providerID: ProviderID; modelID: ModelID }
  }

  /**
   * Per-session state for the tiered compaction system.
   * Stored in an InstanceState keyed by directory.
   */
  export interface PerSession {
    /** Horizon: active compaction anchor, undefined = idle */
    anchor: Anchor | undefined
    /** Horizon: background summarization fiber, undefined = idle */
    fiber: Fiber.Fiber<void> | undefined
    /** Circuit breaker: consecutive failed compaction attempts */
    consecutiveFailures: number
  }

  /**
   * The top-level tiered state, keyed by session ID.
   * Sieve's queue is shared across sessions.
   */
  export interface State {
    /** Per-session compaction state (Horizon + Seam) */
    readonly sessions: Map<SessionID, PerSession>
    /** Sieve: queue of tool parts awaiting background extraction */
    readonly queue: Queue.Queue<WatcherPayload>
    /** Sieve: background fiber running the extraction loop */
    watcher: Fiber.Fiber<void> | undefined
    /** Sieve: part IDs already enqueued (prevents re-queueing on every turn) */
    readonly enqueued: Set<string>
  }

  /** Payload enqueued for Sieve background extraction */
  export interface WatcherPayload {
    readonly sessionID: SessionID
    readonly part: MessageV2.ToolPart
    /** Estimated token count of the raw output */
    readonly estimate: number
  }

  // ───────────────────────────────────────────────────────────────
  // Events
  // ───────────────────────────────────────────────────────────────

  export const Event = {
    /** Fired when an async compaction merge completes */
    Merged: BusEvent.define("session.tiered.merged", z.object({ sessionID: SessionID.zod, anchor: MessageID.zod })),
    /** Fired when a tool output is compressed by the watcher */
    Compressed: BusEvent.define(
      "session.tiered.compressed",
      z.object({ sessionID: SessionID.zod, partID: PartID.zod }),
    ),
  }

  // ───────────────────────────────────────────────────────────────
  // Constants
  // ───────────────────────────────────────────────────────────────

  const WATCHER_THRESHOLD = 2_000

  const PROTECTED_TOOLS = ["skill"]

  const NARRATIVE_THRESHOLD = 0.5

  const PRESERVE_TURNS = 5

  /** Maximum consecutive delta cycles before forcing a full re-summary */
  export const MAX_DELTAS = 3

  /** Sentinel returned by the delta prompt when nothing meaningful changed */
  export const NO_CHANGES = "[NO_CHANGES]"

  /** Maximum consecutive failed compaction attempts before pausing */
  const MAX_CONSECUTIVE_FAILURES = 3

  /** Maximum retries when compaction prompt exceeds context window (P6) */
  const MAX_PTL_RETRIES = 3

  /** Messages to drop per PTL retry round (user→assistant pair = 2) */
  const PTL_DROP_PER_RETRY = 2

  export function isContextOverflow(err: unknown): boolean {
    if (!APICallError.isInstance(err)) return false
    const parsed = ProviderError.parseAPICallError({ providerID: "" as any, error: err })
    return parsed.type === "context_overflow"
  }

  /** Find the latest compaction boundary and return its summary text + mode/sourceRange metadata */
  export function findExistingSummary(msgs: MessageV2.WithParts[]): {
    summary: string
    mode: MessageV2.CompactionMode | undefined
    sourceRange: MessageV2.SourceRange | undefined
    anchor: MessageID
  } | null {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info.role !== "user") continue
      const cp = msg.parts.find((p): p is MessageV2.CompactionPart => p.type === "compaction")
      if (!cp) continue
      const nextMsg = msgs[i + 1]
      if (!nextMsg || nextMsg.info.role !== "assistant" || !nextMsg.info.summary) continue
      const textPart = nextMsg.parts.find((p): p is MessageV2.TextPart => p.type === "text")
      if (!textPart) continue
      return {
        summary: textPart.text,
        mode: cp.mode,
        sourceRange: cp.sourceRange,
        anchor: cp.anchor ?? msg.info.id,
      }
    }
    return null
  }

  /** Count consecutive delta compaction cycles since the last initial/full compaction */
  export function countDeltasSinceFull(msgs: MessageV2.WithParts[]): number {
    let count = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info.role !== "user") continue
      const cp = msg.parts.find((p): p is MessageV2.CompactionPart => p.type === "compaction")
      if (!cp) continue
      if (cp.mode === "delta") {
        count++
      } else {
        break
      }
    }
    return count
  }

  // ───────────────────────────────────────────────────────────────
  // Service Interface
  // ───────────────────────────────────────────────────────────────

  export interface Interface {
    /**
     * Sieve — Enqueue a tool output for background extraction.
     * Call this from the processor after each tool-result event.
     */
    readonly enqueue: (input: WatcherPayload) => Effect.Effect<void>

    /**
     * Horizon — Evaluate whether narrative compaction should trigger.
     * Returns true if a background summarizer was forked. The caller
     * should NOT block on this — the merge happens asynchronously.
     */
    readonly check: (input: {
      sessionID: SessionID
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
      agent: string
    }) => Effect.Effect<boolean>

    /**
     * Seam — Execute the pointer-based merge.
     * Normally called internally when the background summarizer completes.
     * Exported for testing and manual invocation.
     */
    readonly merge: (input: MergeInput) => Effect.Effect<void>

    /** Returns whether a background compaction is in-flight for this session */
    readonly pending: (sessionID: SessionID) => Effect.Effect<boolean>
  }

  export interface MergeInput {
    readonly sessionID: SessionID
    /** The anchor message ID (Turn X boundary) */
    readonly anchor: MessageID
    /** The generated narrative summary text */
    readonly summary: string
    /** Compaction mode: initial, delta, or full */
    readonly mode: MessageV2.CompactionMode
    /** Source range covered by this compaction */
    readonly sourceRange: MessageV2.SourceRange
    /** Agent name to attribute the compaction to */
    readonly agent: string
    /** Model used for the summarization */
    readonly model: { providerID: ProviderID; modelID: ModelID }
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/TieredCompaction") {}

  // ───────────────────────────────────────────────────────────────
  // Layer implementation
  // ───────────────────────────────────────────────────────────────

  export const layer: Layer.Layer<
    Service,
    never,
    Bus.Service | Config.Service | Session.Service | Agent.Service | Plugin.Service | Provider.Service | LLM.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const config = yield* Config.Service
      const session = yield* Session.Service
      const agents = yield* Agent.Service
      const plugin = yield* Plugin.Service
      const provider = yield* Provider.Service

      // ─── Shared mutable state per instance ───────────────────

      const state = yield* InstanceState.make(
        Effect.fn("TieredCompaction.state")(function* () {
          const q = yield* Queue.unbounded<WatcherPayload>()
          const st: State = {
            sessions: new Map(),
            queue: q,
            watcher: undefined,
            enqueued: new Set(),
          }
          yield* Effect.addFinalizer(
            Effect.fnUntraced(function* () {
              for (const [, s] of st.sessions) {
                if (s.fiber) yield* Fiber.interrupt(s.fiber)
              }
              st.sessions.clear()
              yield* Queue.shutdown(q)
              if (st.watcher) yield* Fiber.interrupt(st.watcher)
            }),
          )
          return st
        }),
      )

      const getPerSession = (st: State, id: SessionID): PerSession => {
        const existing = st.sessions.get(id)
        if (existing) return existing
        const fresh: PerSession = { anchor: undefined, fiber: undefined, consecutiveFailures: 0 }
        st.sessions.set(id, fresh)
        return fresh
      }

      // ─────────────────────────────────────────────────────────
      // Sieve — Background tool-output extractor (data-tier)
      // ─────────────────────────────────────────────────────────

      /**
       * Process a single tool output using context-aware extraction.
       * Delegates to ToolExtraction for the actual LLM call.
       */
      const processExtraction = Effect.fn("TieredCompaction.processExtraction")(function* (payload: WatcherPayload) {
        log.info("processExtraction: starting", { partID: payload.part.id, tool: payload.part.tool })
        const extraction = yield* ToolExtraction.Service
        yield* extraction.extract({ sessionID: payload.sessionID, part: payload.part })
        const st = yield* InstanceState.get(state)
        st.enqueued.delete(payload.part.id)
      })

      /** Background loop: dequeue and extract tool outputs one at a time */
      const watchLoop = Effect.fn("TieredCompaction.watchLoop")(function* () {
        const st = yield* InstanceState.get(state)
        yield* Stream.fromQueue(st.queue).pipe(
          Stream.tap((payload) => processExtraction(payload).pipe(Effect.catch(() => Effect.void))),
          Stream.runDrain,
        )
      })

      const enqueue = Effect.fn("TieredCompaction.enqueue")(function* (input: WatcherPayload) {
        const cfg = yield* config.get()
        const threshold = cfg.compaction?.extract_threshold ?? 5_000
        if (!ToolExtraction.shouldExtract(input.part, threshold)) {
          log.info("enqueue: part does not qualify for extraction", {
            partID: input.part.id,
            tool: input.part.tool,
            estimate: input.estimate,
            threshold,
          })
          return
        }
        const st = yield* InstanceState.get(state)
        if (st.enqueued.has(input.part.id)) return
        st.enqueued.add(input.part.id)
        log.info("enqueue: queuing part for extraction", {
          partID: input.part.id,
          tool: input.part.tool,
          estimate: input.estimate,
        })
        yield* Queue.offer(st.queue, input)

        // Lazily start the background watcher fiber
        if (!st.watcher) {
          const scope = yield* Scope.make()
          st.watcher = yield* watchLoop().pipe(Effect.forkIn(scope))
        }
      })

      // ─────────────────────────────────────────────────────────
      // Horizon — Narrative summarizer (context-tier)
      // ─────────────────────────────────────────────────────────

      /**
       * Check whether current token usage has crossed the narrative threshold
       * of the model's usable context window.
       */
      const exceeded = Effect.fn("TieredCompaction.exceeded")(function* (input: {
        tokens: MessageV2.Assistant["tokens"]
        model: Provider.Model
      }) {
        const cfg = yield* config.get()
        if (cfg.compaction?.auto === false) {
          log.info("exceeded: compaction auto disabled")
          return false
        }
        const context = input.model.limit.context
        if (context === 0) {
          log.info("exceeded: model context limit is 0, skipping")
          return false
        }

        const count =
          input.tokens.total ||
          input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

        const max = ProviderTransform.maxOutputTokens(input.model)
        const usable = input.model.limit.input ? input.model.limit.input : context - max
        const threshold = cfg.compaction?.narrative_threshold ?? NARRATIVE_THRESHOLD
        const result = count >= usable * threshold
        log.info("exceeded", {
          count,
          usable,
          threshold,
          result,
          total: input.tokens.total,
          input: input.tokens.input,
          output: input.tokens.output,
        })
        return result
      })

      /**
       * Determine compaction mode: initial, delta, or full re-summary.
       */
      const routingLogic = Effect.fn("TieredCompaction.routingLogic")(function* (msgs: MessageV2.WithParts[]) {
        const cfg = yield* config.get()
        const maxDeltas = cfg.compaction?.max_deltas ?? MAX_DELTAS
        const existing = findExistingSummary(msgs)
        if (!existing) {
          return { mode: "initial" as const, existing: null }
        }
        const deltas = countDeltasSinceFull(msgs)
        if (deltas >= maxDeltas) {
          return { mode: "full" as const, existing }
        }
        return { mode: "delta" as const, existing }
      })

      const PTL_MARKER = "[Earlier conversation truncated for compaction retry]"

      const streamWithRetry = Effect.fn("TieredCompaction.streamWithRetry")(function* (opts: {
        agent: Agent.Info
        user: MessageV2.User
        model: Provider.Model
        sessionID: SessionID
        baseMessages: ModelMessage[]
        prompt: string
      }) {
        let messages = [...opts.baseMessages, { role: "user" as const, content: opts.prompt }]
        for (let attempt = 0; attempt <= MAX_PTL_RETRIES; attempt++) {
          try {
            const text = yield* Effect.promise(async (signal) => {
              const result = await LLM.stream({
                agent: opts.agent,
                user: opts.user,
                system: [],
                tools: {},
                model: opts.model,
                abort: signal,
                sessionID: opts.sessionID,
                messages,
              })
              let out = ""
              for await (const event of result.fullStream) {
                if (event.type === "text-delta") out += event.text
              }
              return out
            })
            return text
          } catch (err) {
            if (!isContextOverflow(err) || attempt >= MAX_PTL_RETRIES) throw err
            const drop = PTL_DROP_PER_RETRY * (attempt + 1)
            if (messages.length <= drop + 1) throw err
            messages = [
              { role: "user" as const, content: PTL_MARKER },
              ...messages.slice(drop, -1),
              { role: "user" as const, content: opts.prompt },
            ]
            log.info("streamWithRetry: context overflow, truncating and retrying", {
              attempt: attempt + 1,
              dropped: drop,
              remaining: messages.length,
            })
          }
        }
        return "" as string
      })

      /**
       * Fork background narrative summarization. Routes between initial,
       * delta, and full re-summary modes based on existing compaction state.
       */
      const summarize = Effect.fn("TieredCompaction.summarize")(function* (input: {
        sessionID: SessionID
        agent: string
        model: { providerID: ProviderID; modelID: ModelID }
        tokens: number
      }) {
        const cfg = yield* config.get()
        const preserveTurns = cfg.compaction?.preserve_turns ?? PRESERVE_TURNS
        const msgs = MessageV2.filterCompacted(MessageV2.stream(input.sessionID))
        const userTurns = msgs.filter(
          (m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"),
        ).length
        if (userTurns < 1) {
          log.info("summarize: no user turns to summarize", { msgCount: msgs.length })
          return
        }

        let turns = 0
        let anchorIdx = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].info.role === "user" && !msgs[i].parts.some((p) => p.type === "compaction")) {
            turns++
          }
          if (userTurns > preserveTurns && turns > preserveTurns) {
            anchorIdx = i
            break
          }
        }
        if (anchorIdx < 0) {
          anchorIdx = msgs.findIndex((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        }
        if (anchorIdx < 0) {
          log.info("summarize: no anchor found")
          const st2 = yield* InstanceState.get(state)
          const ps2 = getPerSession(st2, input.sessionID)
          if (ps2) {
            ps2.anchor = undefined
            ps2.fiber = undefined
          }
          return
        }

        const existingBoundary = msgs.find(
          (m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"),
        )
        if (existingBoundary) {
          const boundaryIdx = msgs.indexOf(existingBoundary)
          const afterBoundary = msgs.slice(boundaryIdx + 2)
          const liveUserTurns = afterBoundary.filter(
            (m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"),
          )
          if (liveUserTurns.length < preserveTurns) {
            log.info("summarize: live buffer too small to compact further", {
              liveUserTurns: liveUserTurns.length,
              preserveTurns,
            })
            const st2 = yield* InstanceState.get(state)
            const ps2 = getPerSession(st2, input.sessionID)
            if (ps2) {
              ps2.anchor = undefined
              ps2.fiber = undefined
            }
            return
          }
        }

        const anchorMsg = msgs[anchorIdx]
        if (anchorMsg.info.role !== "user") {
          log.info("summarize: anchor is not a user message", { role: anchorMsg.info.role })
          return
        }

        const anchor: Anchor = {
          id: anchorMsg.info.id,
          time: Date.now(),
          tokens: input.tokens,
          agent: input.agent,
          model: input.model,
        }

        let snapshotEnd = msgs.length
        if (userTurns <= preserveTurns) {
          let lastUserIdx = -1
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].info.role === "user" && !msgs[i].parts.some((p) => p.type === "compaction")) {
              lastUserIdx = i
              break
            }
          }
          if (lastUserIdx > 0) {
            snapshotEnd = lastUserIdx
          }
        }
        const snapshot = msgs.slice(0, Math.max(anchorIdx + 1, snapshotEnd))

        const route = yield* routingLogic(msgs)
        const mode: MessageV2.CompactionMode =
          route.mode === "initial" ? "initial" : route.mode === "full" ? "full" : "delta"

        log.info("summarize: starting", {
          sessionID: input.sessionID,
          anchorID: anchor.id,
          snapshotSize: snapshot.length,
          totalMsgs: msgs.length,
          preserveTurns,
          mode,
        })

        const agent = yield* agents.get("compaction")
        const model = agent?.model
          ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
          : yield* provider.getModel(input.model.providerID, input.model.modelID)

        const compacting = yield* plugin.trigger(
          "experimental.session.compacting",
          { sessionID: input.sessionID },
          { context: [], prompt: undefined },
        )

        // Determine sourceRange: the earliest and latest message IDs in the snapshot
        const sourceFrom = snapshot[0]?.info.id
        const sourceTo = snapshot[snapshot.length - 1]?.info.id

        // ── Route: build the LLM call based on mode ──
        const scope = yield* Scope.make()
        const fiber = yield* Effect.gen(function* () {
          let summaryText: string

          if (mode === "delta" && route.existing) {
            const afterAnchorIdx = msgs.findIndex((m) => m.info.id === route.existing.anchor)
            const newMsgs = afterAnchorIdx >= 0 ? msgs.slice(afterAnchorIdx + 1) : msgs
            const deltaMsgs = newMsgs.filter(
              (m) => !(m.info.role === "user" && m.parts.some((p) => p.type === "compaction")),
            )

            const prompt = compacting.prompt ?? [PROMPT_DELTA, ...compacting.context].join("\n\n")
            const promptText = prompt
              .replace("EXISTING SUMMARY:\n\n---", `EXISTING SUMMARY:\n\n${route.existing.summary}\n---`)
              .replace(
                "NEW MESSAGES:\n\n---",
                `NEW MESSAGES:\n\n${deltaMsgs
                  .map((m) =>
                    m.parts
                      .filter((p) => p.type === "text")
                      .map((p) => (p as MessageV2.TextPart).text)
                      .join("\n"),
                  )
                  .join("\n---\n")}\n---`,
              )

            const cloned = structuredClone(deltaMsgs)
            const modelMsgs = yield* MessageV2.toModelMessagesEffect(cloned, model, { stripMedia: true })

            const deltaText = yield* streamWithRetry({
              agent: agent!,
              user: anchorMsg.info as MessageV2.User,
              model,
              sessionID: input.sessionID,
              baseMessages: modelMsgs,
              prompt: promptText,
            })

            const strippedDelta = stripSummaryMeta(deltaText)
            if (deltaText.trim() === NO_CHANGES || strippedDelta.trim() === NO_CHANGES) {
              log.info("summarize: delta produced no changes, skipping cycle")
              const st = yield* InstanceState.get(state)
              const ps = st.sessions.get(input.sessionID)
              if (ps) {
                ps.anchor = undefined
                ps.fiber = undefined
              }
              return
            }

            const mergePrompt = compacting.prompt ?? [PROMPT_MERGE, ...compacting.context].join("\n\n")
            const mergeText = mergePrompt
              .replace("EXISTING SUMMARY:\n\n---", `EXISTING SUMMARY:\n\n${route.existing.summary}\n---`)
              .replace(
                "DELTA (new/changed sections only):\n\n---",
                `DELTA (new/changed sections only):\n\n${deltaText}\n---`,
              )

            summaryText = yield* streamWithRetry({
              agent: agent!,
              user: anchorMsg.info as MessageV2.User,
              model,
              sessionID: input.sessionID,
              baseMessages: [],
              prompt: mergeText,
            })
          } else if (mode === "full" && route.existing?.sourceRange) {
            const sourceMsgs = [
              ...MessageV2.streamRange(input.sessionID, route.existing.sourceRange.from, route.existing.sourceRange.to),
            ]
            const cloned = structuredClone(sourceMsgs)
            const modelMsgs = yield* MessageV2.toModelMessagesEffect(cloned, model, { stripMedia: true })
            const prompt = compacting.prompt ?? [PROMPT_NARRATIVE, ...compacting.context].join("\n\n")

            summaryText = yield* streamWithRetry({
              agent: agent!,
              user: anchorMsg.info as MessageV2.User,
              model,
              sessionID: input.sessionID,
              baseMessages: modelMsgs,
              prompt,
            })
          } else {
            const prompt = compacting.prompt ?? [PROMPT_NARRATIVE, ...compacting.context].join("\n\n")
            const cloned = structuredClone(snapshot)
            const modelMsgs = yield* MessageV2.toModelMessagesEffect(cloned, model, { stripMedia: true })

            summaryText = yield* streamWithRetry({
              agent: agent!,
              user: anchorMsg.info as MessageV2.User,
              model,
              sessionID: input.sessionID,
              baseMessages: modelMsgs,
              prompt,
            })
          }

          if (!summaryText.trim()) {
            log.error("narrative summarizer produced empty output")
            return
          }

          summaryText = stripSummaryMeta(summaryText)

          yield* mergeImpl({
            sessionID: input.sessionID,
            anchor: anchor.id,
            summary: summaryText,
            mode,
            sourceRange: { from: sourceFrom, to: sourceTo },
            agent: input.agent,
            model: input.model,
          })

          // Reset circuit breaker on successful compaction
          const stOk = yield* InstanceState.get(state)
          const psOk = stOk.sessions.get(input.sessionID)
          if (psOk) psOk.consecutiveFailures = 0
        }).pipe(
          Effect.catch((err) =>
            Effect.gen(function* () {
              log.error("summarize: compaction failed", { error: String(err) })
              const stFail = yield* InstanceState.get(state)
              const psFail = stFail.sessions.get(input.sessionID)
              if (psFail) psFail.consecutiveFailures++
            }).pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              const st = yield* InstanceState.get(state)
              const ps = st.sessions.get(input.sessionID)
              if (ps) {
                ps.anchor = undefined
                ps.fiber = undefined
              }
            }).pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.forkIn(scope),
        )

        const st = yield* InstanceState.get(state)
        const ps = getPerSession(st, input.sessionID)
        ps.anchor = anchor
        ps.fiber = fiber
      })

      const check = Effect.fn("TieredCompaction.check")(function* (input: {
        sessionID: SessionID
        tokens: MessageV2.Assistant["tokens"]
        model: Provider.Model
        agent: string
      }) {
        const st = yield* InstanceState.get(state)
        const ps = getPerSession(st, input.sessionID)
        if (ps.anchor) {
          log.info("check: compaction already in-flight", { sessionID: input.sessionID })
          return false
        }

        const maxFailures = (yield* config.get()).compaction?.max_consecutive_failures ?? MAX_CONSECUTIVE_FAILURES
        if (ps.consecutiveFailures >= maxFailures) {
          log.info("check: circuit breaker active", {
            sessionID: input.sessionID,
            consecutiveFailures: ps.consecutiveFailures,
            maxFailures,
          })
          return false
        }

        if (!(yield* exceeded({ tokens: input.tokens, model: input.model }))) {
          log.info("check: threshold not exceeded", { sessionID: input.sessionID })
          return false
        }

        log.info("check: threshold exceeded, starting summarization", { sessionID: input.sessionID })

        const count =
          input.tokens.total ||
          input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

        yield* summarize({
          sessionID: input.sessionID,
          agent: input.agent,
          model: { providerID: input.model.providerID, modelID: input.model.id },
          tokens: count,
        })
        return true
      })

      // ─────────────────────────────────────────────────────────
      // Seam — Async merge router (stitch compacted past to live present)
      // ─────────────────────────────────────────────────────────

      /**
       * Deliverable 2 — The pointer-based merge function.
       *
       * Guarantees:
       *   1. No user messages are lost. The merge only INSERTS new messages
       *      (compaction boundary + summary). It never deletes or moves
       *      existing messages.
       *   2. The existing `filterCompacted()` mechanism handles windowing.
       *      Once the summary message has `finish` set, `filterCompacted()`
       *      will naturally drop everything before the anchor on the next
       *      call, and the live buffer [Turn X+1 … X+Y] is preserved.
       *   3. System prompts don't need handling — they are generated fresh
       *      each loop iteration by SystemPrompt/Instruction services.
       *   4. The merge is idempotent. If called twice with the same anchor,
       *      the second call is a no-op because the compaction part already
       *      exists.
       *
       * Conceptual timeline:
       *
       *   BEFORE merge (compaction in-flight):
       *   ┌───────────────────────────────────┬──────────────────────┐
       *   │  [Turn 0 … Turn X]                │  [Turn X+1 … X+Y]   │
       *   │  (being summarized in background)  │  (live buffer)       │
       *   └───────────────────────────────────┴──────────────────────┘
       *
       *   AFTER merge (boundary inserted):
       *   ┌────────────────┬─────────┬────────┬──────────────────────┐
       *   │  [Turn 0 … X]  │ Compact │ Summary│  [Turn X+1 … X+Y]   │
       *   │  (will be       │ (user   │ (asst  │  (live buffer,       │
       *   │   filtered out  │  msg w/ │  msg w/│   fully preserved)   │
       *   │   by filter-    │ Compac- │ summary│                      │
       *   │   Compacted)    │ tionPrt)│ =true) │                      │
       *   └────────────────┴─────────┴────────┴──────────────────────┘
       *
       *   ON NEXT filterCompacted() call:
       *   ┌─────────┬────────┬──────────────────────┐
       *   │ Compact  │ Summary│  [Turn X+1 … X+Y]   │
       *   │ (anchor) │ (text) │  (live buffer)       │
       *   └─────────┴────────┴──────────────────────┘
       *   Everything before the anchor is dropped.
       */
      const mergeImpl = Effect.fn("TieredCompaction.merge")(function* (input: MergeInput) {
        log.info("merge", { sessionID: input.sessionID, anchor: input.anchor })

        const ctx = yield* InstanceState.context

        // ── Step 1: Verify the anchor still exists ──
        // If a manual compaction already ran and passed this point,
        // the anchor may no longer be the relevant boundary. In that
        // case we skip — the manual compaction took priority.
        const msgs = MessageV2.filterCompacted(MessageV2.stream(input.sessionID))
        const anchorExists = msgs.some((m) => m.info.id === input.anchor && m.info.role === "user")
        if (!anchorExists) {
          log.info("anchor no longer in active window, skipping merge", {
            anchor: input.anchor,
          })
          return
        }

        // ── Step 2: Check idempotency ──
        // If a compaction part already exists AFTER this anchor,
        // someone else (or a retry) already merged.
        const alreadyMerged = msgs.some(
          (m) => m.info.role === "user" && m.info.id > input.anchor && m.parts.some((p) => p.type === "compaction"),
        )
        if (alreadyMerged) {
          log.info("merge already completed for this anchor", { anchor: input.anchor })
          // Clear the in-flight anchor so check() can trigger a new compaction
          const st = yield* InstanceState.get(state)
          const ps = st.sessions.get(input.sessionID)
          if (ps) {
            ps.anchor = undefined
            ps.fiber = undefined
          }
          return
        }

        // ── Step 2.5: P5 — Collect recently referenced files for re-attachment ──
        const anchorIdx = msgs.findIndex((m) => m.info.id === input.anchor)
        const preAnchor = anchorIdx >= 0 ? msgs.slice(0, anchorIdx + 1) : []
        const filePaths = extractRecentFiles(preAnchor)
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

        // ── Step 3: Insert the compaction boundary (user message) ──
        // Synthetic user message with a CompactionPart marking the
        // anchor point. filterCompacted finds the latest completed
        // compaction boundary and returns everything from that point
        // to the newest message.
        //
        // Use IDs/timestamps just after the anchor so they sort into
        // position in the stream — the boundary appears right after
        // the anchor's assistant response, not at the end.
        const anchorTimestamp = Identifier.timestamp(input.anchor)
        // Use timestamps slightly after the anchor so boundary/summary sort
        // into position right after the anchor message in the stream.
        // +1ms for boundary, +2ms for summary — avoids collision with
        // existing IDs thanks to the random suffix in Identifier.create.
        const boundaryTime = anchorTimestamp + 1
        const summaryTime = anchorTimestamp + 2

        const boundary = yield* session.updateMessage({
          id: MessageID.make(Identifier.create("message", false, boundaryTime)),
          role: "user",
          sessionID: input.sessionID,
          time: { created: boundaryTime },
          agent: input.agent,
          model: input.model,
        })

        yield* session.updatePart({
          id: PartID.make(Identifier.create("part", false, boundaryTime)),
          messageID: boundary.id,
          sessionID: input.sessionID,
          type: "compaction",
          auto: true,
          overflow: false,
          anchor: input.anchor,
          mode: input.mode,
          sourceRange: input.sourceRange,
        })

        // ── Step 4: Insert the summary (assistant message) ──
        // summary=true + finish="stop" → filterCompacted() treats this
        // as a completed boundary marker.
        const summaryMsg: MessageV2.Assistant = {
          id: MessageID.make(Identifier.create("message", false, summaryTime)),
          role: "assistant",
          parentID: boundary.id,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          path: { cwd: ctx.directory, root: ctx.worktree },
          summary: true,
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: input.model.modelID,
          providerID: input.model.providerID,
          time: { created: summaryTime, completed: summaryTime },
        }
        yield* session.updateMessage(summaryMsg)

        // ── Step 5: Write the summary text as a text part ──
        yield* session.updatePart({
          id: PartID.make(Identifier.create("part", false, summaryTime)),
          messageID: summaryMsg.id,
          sessionID: input.sessionID,
          type: "text",
          text: input.summary,
          time: { start: summaryTime, end: summaryTime },
        })

        // ── Step 6: Write a step-finish so the message is well-formed ──
        yield* session.updatePart({
          id: PartID.make(Identifier.create("part", false, summaryTime + 1)),
          messageID: summaryMsg.id,
          sessionID: input.sessionID,
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })

        // ── Step 7: Insert a synthetic continuation prompt ──
        // Prevents the model from acknowledging the compaction or
        // re-summarizing what happened. Instructs it to resume directly.
        const continueTime = summaryTime + 2
        const continueMsg = yield* session.updateMessage({
          id: MessageID.make(Identifier.create("message", false, continueTime)),
          role: "user",
          sessionID: input.sessionID,
          time: { created: continueTime },
          agent: input.agent,
          model: input.model,
        })
        yield* session.updatePart({
          id: PartID.make(Identifier.create("part", false, continueTime)),
          messageID: continueMsg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: continuationWithSession(input.sessionID) + fileReminder,
          time: { start: continueTime, end: continueTime },
        })

        log.info("merge complete", {
          sessionID: input.sessionID,
          anchor: input.anchor,
          tokens: Token.estimate(input.summary),
        })

        yield* bus.publish(Event.Merged, {
          sessionID: input.sessionID,
          anchor: input.anchor,
        })

        // At this point, the next call to filterCompacted() will see:
        //   [boundary (CompactionPart)] + [summary (assistant, summary=true, finish="stop")]
        // and drop everything before the boundary. The live buffer
        // (messages after the original anchor) remains untouched.
      })

      const pending = Effect.fn("TieredCompaction.pending")(function* (sessionID: SessionID) {
        const st = yield* InstanceState.get(state)
        const ps = st.sessions.get(sessionID)
        return ps?.anchor !== undefined
      })

      return Service.of({ enqueue: enqueue as any, check, merge: mergeImpl, pending })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(LLM.defaultLayer),
    ),
  )
}
