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

import PROMPT_NARRATIVE from "@/agent/prompt/narrative-compaction.txt"
import { ToolExtraction } from "./tool-extraction"

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

  /** Sieve: minimum token count to qualify for background extraction */
  const WATCHER_THRESHOLD = 2_000

  /** Sieve: tools that should never be compressed */
  const PROTECTED_TOOLS = ["skill"]

  /** Horizon: trigger compaction at this fraction of usable context */
  const NARRATIVE_THRESHOLD = 0.5

  /** Horizon: preserve the N most recent turns from compaction */
  const PRESERVE_TURNS = 4

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
        const fresh: PerSession = { anchor: undefined, fiber: undefined }
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
       * Fork background narrative summarization. Selects messages up to
       * (but excluding the most recent preserveTurns turns), creates the
       * anchor, and runs the summarizer in a detached fiber.
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
        // Count user turns to decide if there's enough history to summarize
        const userTurns = msgs.filter(
          (m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"),
        ).length
        if (userTurns < 1) {
          log.info("summarize: no user turns to summarize", { msgCount: msgs.length })
          return
        }

        // Find the anchor: the user message that marks the boundary between
        // what gets summarized and what gets preserved. With N user turns, we
        // preserve the last preserveTurns and anchor on the one before that.
        // If userTurns <= preserveTurns, anchor on the first user message,
        // summarizing everything up to (but excluding) the last turn.
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
        // If all user turns fit within the preserved window, anchor on the first user turn
        if (anchorIdx < 0) {
          anchorIdx = msgs.findIndex((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        }
        if (anchorIdx < 0) {
          log.info("summarize: no anchor found")
          const st = yield* InstanceState.get(state)
          const ps = getPerSession(st, input.sessionID)
          if (ps) {
            ps.anchor = undefined
            ps.fiber = undefined
          }
          return
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

        // Snapshot: everything from the start through the anchor user message,
        // including all assistant responses that follow the anchor.
        // When userTurns <= preserveTurns, we summarize everything up to
        // (but excluding) the last user turn + its assistant response.
        let snapshotEnd = msgs.length
        if (userTurns <= preserveTurns) {
          // Preserve the last user turn and its response: find the last
          // user turn and include everything before it in the snapshot.
          let lastUserIdx = -1
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].info.role === "user" && !msgs[i].parts.some((p) => p.type === "compaction")) {
              lastUserIdx = i
              break
            }
          }
          if (lastUserIdx > 0) {
            // Include all messages before the last user turn in the snapshot.
            // Also include any assistant responses to the anchor that are
            // before the last user turn.
            snapshotEnd = lastUserIdx
          }
        }
        const snapshot = msgs.slice(0, Math.max(anchorIdx + 1, snapshotEnd))

        log.info("summarize: starting", {
          sessionID: input.sessionID,
          anchorID: anchor.id,
          snapshotSize: snapshot.length,
          totalMsgs: msgs.length,
          preserveTurns,
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
        const prompt = compacting.prompt ?? [PROMPT_NARRATIVE, ...compacting.context].join("\n\n")

        // Build model messages from the snapshot (strip media to save tokens)
        const cloned = structuredClone(snapshot)
        const modelMsgs = yield* MessageV2.toModelMessagesEffect(cloned, model, { stripMedia: true })

        // Fork the actual LLM call as a detached background fiber
        const scope = yield* Scope.make()
        const fiber = yield* Effect.gen(function* () {
          const text = yield* Effect.promise(async (signal) => {
            const result = await LLM.stream({
              agent: agent!,
              user: anchorMsg.info as MessageV2.User,
              system: [],
              tools: {},
              model,
              abort: signal,
              sessionID: input.sessionID,
              messages: [...modelMsgs, { role: "user", content: prompt }],
            })
            let out = ""
            for await (const event of result.fullStream) {
              if (event.type === "text-delta") out += event.text
            }
            return out
          })

          if (!text.trim()) {
            log.error("narrative summarizer produced empty output")
            return
          }

          // ── Seam merge ──
          yield* mergeImpl({
            sessionID: input.sessionID,
            anchor: anchor.id,
            summary: text,
            agent: input.agent,
            model: input.model,
          })
        }).pipe(
          Effect.catch(() => Effect.void),
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

        // Record state
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

        // ── Step 3: Insert the compaction boundary (user message) ──
        // Synthetic user message with a CompactionPart marking the
        // anchor point. filterCompacted finds the latest completed
        // compaction boundary and returns everything from that point
        // to the newest message, so the boundary can appear at any
        // position in the stream — even after live-buffer messages
        // that were added during the summarization window.
        const boundary = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: input.agent,
          model: input.model,
        })

        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: boundary.id,
          sessionID: input.sessionID,
          type: "compaction",
          auto: true,
          overflow: false,
          anchor: input.anchor,
        })

        // ── Step 4: Insert the summary (assistant message) ──
        // summary=true + finish="stop" → filterCompacted() treats this
        // as a completed boundary marker.
        const summaryMsg: MessageV2.Assistant = {
          id: MessageID.ascending(),
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
          time: { created: Date.now(), completed: Date.now() },
        }
        yield* session.updateMessage(summaryMsg)

        // ── Step 5: Write the summary text as a text part ──
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: summaryMsg.id,
          sessionID: input.sessionID,
          type: "text",
          text: input.summary,
          time: { start: Date.now(), end: Date.now() },
        })

        // ── Step 6: Write a step-finish so the message is well-formed ──
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: summaryMsg.id,
          sessionID: input.sessionID,
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
