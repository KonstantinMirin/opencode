# Tiered Context Compaction

OpenCode uses a three-layer compaction system to keep sessions running indefinitely without hitting context limits. Each layer operates independently at a different timescale and token scale, so the user never waits for compaction and the main loop never blocks.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Session Loop (prompt.ts)                                │
│                                                          │
│  After each step:                                        │
│    1. Sieve.enqueue()   — background, non-blocking       │
│    2. Horizon.check()   — forks summarizer if threshold   │
│    3. Prune.run()       — synchronous, fast              │
│                                                          │
│  On next step:                                           │
│    4. filterCompacted() picks up Seam boundary if ready   │
└──────────────────────────────────────────────────────────┘
```

### Sieve — data-tier compression

Background tool-output extractor. After each step, large completed tool outputs are enqueued for asynchronous LLM extraction. A background fiber processes them one at a time:

1. **Enqueue**: `Sieve.enqueue()` checks whether a tool part qualifies (completed, not protected, above `extract_threshold` tokens). Deduplicates by part ID.
2. **Extract**: The watcher fiber dequeues payloads and calls `ToolExtraction.extract()`, which asks a cheaper model to summarize the output. The original output is replaced in-place with the extracted summary, and `state.time.compacted` is set.
3. **Preview**: For outputs below the extraction threshold, `structuredPreviewSync()` produces a compact preview (tool name, args, errors, last 5 lines) that replaces the full output when `compacted` is set.

Sieve runs on a lazy fiber — it starts when the first payload is enqueued and shuts down when the instance is disposed.

### Horizon — context-tier compression

Narrative summarizer. After each step, `Horizon.check()` evaluates whether token usage has crossed the narrative threshold (default: 50% of usable context). If so, it forks a background fiber that:

1. **Snapshots** the current message window up to the anchor point (preserving the last N turns as a live buffer).
2. **Routes** between three compaction modes (see Incremental Summarization below).
3. **Streams** the LLM response and strips metadata tags.
4. **Merges** via Seam when done.

The main loop never awaits this fiber. If a second compaction triggers while one is in-flight, it's skipped.

### Seam — boundary merge

When Horizon finishes, Seam inserts a pointer-based merge — three synthetic messages placed right after the anchor in the message stream:

```
BEFORE: [Turn 0 … Turn X]  [Turn X+1 … X+Y]  (live buffer)
AFTER:  [Turn 0 … Turn X]  [Boundary] [Summary] [Continue]  [Turn X+1 … X+Y]
```

On the next `filterCompacted()` call, everything before the boundary is dropped, leaving only:

```
[Boundary] [Summary] [Continue]  [Turn X+1 … X+Y]
```

The merge is idempotent — if called twice with the same anchor, the second call is a no-op. It uses timestamp-ordered IDs so the boundary messages sort into position without moving existing messages.

### Prune — synchronous fast path

Runs synchronously after each step. Walks backwards through messages, erasing old tool output that exceeds the `PRUNE_PROTECT` threshold (40K tokens). Only erases if total savings exceed `PRUNE_MINIMUM` (20K tokens). Outputs above the Sieve threshold are enqueued for LLM extraction instead of being bluntly compacted.

## Incremental Summarization

Horizon routes between three modes automatically:

| Mode                | When                                                 | Input                                                | Cost        |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------- | ----------- |
| **Initial**         | First compaction, no existing summary                | Full message history                                 | High        |
| **Delta**           | Subsequent compactions, < MAX_DELTAS (3) accumulated | Previous summary + new messages since last anchor    | ~4x cheaper |
| **Full re-summary** | MAX_DELTAS exceeded                                  | Full message history from source (via `sourceRange`) | High        |

### State machine

```
                     First compaction
                           |
                           v
                    +-------------+
                    |   INITIAL    |
                    +------+------+
                           |
                           v
                    +-------------+
               +--->|    IDLE     |<--+
               |    +------+------+   |
               |           |          |
               |     Threshold hit    |
               |           |          |
               |           v          |
               |    +-------------+   |  deltas < MAX_DELTAS
               |    |    DELTA     |---+
               |    +------+------+   |
               |           |          |
               |           | deltas >= MAX_DELTAS
               |           v          |
               |    +-------------+   |
               |    |  RE-SUMMARY  |---+
               |    +------+------+
               |           |
               +-----------+
```

### Delta cycle

1. The delta prompt receives the existing summary + new messages since the last anchor. It produces ONLY sections with new information.
2. If nothing meaningful changed, the LLM outputs `[NO_CHANGES]` and the entire cycle is skipped deterministically — no merge, no boundary insertion.
3. Otherwise, the merge prompt combines the existing summary with the delta. It preserves structure verbatim, updates changed sections, and enforces conciseness.
4. After `MAX_DELTAS` (3) consecutive delta cycles, the next compaction does a full re-summary from the original source messages (using `sourceRange`), which resets the delta counter.

### Data model

Each compaction boundary stores metadata on the `CompactionPart`:

```ts
type: "compaction"
anchor: MessageID              // boundary user message ID
mode?: "initial" | "delta" | "full"  // how this summary was produced
sourceRange?: {                // which source messages this covers
  from: MessageID              // first message ID in the summarized span
  to: MessageID                // last message ID (the anchor)
}
```

`sourceRange` enables full re-summary from source — we fetch `msgs[from..to]` from the database even though they've been filtered from the live context. This is the key invariant: we can always reconstruct from originals, so delta summaries don't need to be perfect.

Both `mode` and `sourceRange` are optional. Old compaction parts default to `mode: "initial"` with no `sourceRange`.

### Cost comparison

| Mode            | Input tokens                       | Output tokens | LLM calls         |
| --------------- | ---------------------------------- | ------------- | ----------------- |
| Full re-summary | ~50K                               | ~2K           | 1                 |
| Delta           | ~12K (new msgs + existing summary) | ~1K           | 2 (delta + merge) |

Delta+merge is ~4x cheaper per cycle. Full re-summary happens only every N cycles.

### Lifecycle example

```
Cycle 1: msgs[0..100] -> summary1 (mode: initial, sourceRange: {from: msg0, to: msg100})
Cycle 2: summary1 + msgs[101..200] -> delta2 -> merge(summary1, delta2) -> summary2
         (mode: delta, sourceRange: {from: msg0, to: msg200})
Cycle 3: summary2 + msgs[201..300] -> delta3 -> merge(summary2, delta3) -> summary3
         (mode: delta, sourceRange: {from: msg0, to: msg300})
Cycle 4: deltas >= MAX_DELTAS (3)
         -> re-read msgs[0..400] from sourceRange
         -> summary4 (mode: full, sourceRange: {from: msg0, to: msg400})
         -> reset delta counter
```

## Quality Improvements

Research-grounded improvements applied across the compaction pipeline.

References:

- Wei et al. (2022) "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models"
- Liu et al. (2024) "Lost in the Middle: How Language Models Use Long Contexts"
- Beltagy et al. (2020) "Longformer: The Long-Document Transformer"
- ShrinkPrompt (2024) — placeholder tokens for truncated tool output
- Factory.ai anchored iterative summarization (2024) — delta+merge with periodic full rebuild

### Anti-drift preamble and analysis scratchpad

**Problem:** LLMs sometimes call tools during compaction (wasting the turn) or produce unstructured rambling summaries.

**Solution:** Every compaction prompt is wrapped with a no-tools preamble/trailer. The model is instructed to produce `<analysis>` (scratchpad for reasoning) followed by `<summary>` (structured output). After the LLM responds, `stripSummaryMeta()` removes `<analysis>` blocks and extracts `<summary>` content. Provider-specific `<thinking>` tags are also stripped. Falls back to raw text if no structured tags are found.

### Stronger continuation message

**Problem:** After compaction, the model wastes tokens acknowledging the summary or re-summarizing.

**Solution:** A synthetic user message is inserted after the summary with explicit anti-acknowledgement instructions:

> Continue the conversation from where it left off without asking further questions. Resume directly — do not acknowledge the compaction, do not recap what happened, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.

### Circuit breaker

**Problem:** Failed compactions retry indefinitely, burning API credits.

**Solution:** Each session tracks `consecutiveFailures`. Incremented on summarization failure, reset on success. `Horizon.check()` skips when `consecutiveFailures >= max_consecutive_failures` (default 3). Configurable via `compaction.max_consecutive_failures`.

### Prune-Sieve integration

**Problem:** `prune()` marks outputs as compacted but doesn't leverage Sieve for LLM extraction. Outputs above the extract threshold still get bluntly cleared instead of intelligently summarized.

**Solution:** `prune()` now splits eligible outputs:

- **Above extract_threshold** (default 5K tokens): enqueued to Sieve for background LLM extraction
- **Below extract_threshold**: marked as compacted immediately, with `structuredPreviewSync()` providing the display fallback

### Post-compaction file re-attachment

**Problem:** After compaction, the agent loses awareness of files it was actively working on, causing unnecessary re-reads.

**Solution:** After Seam merge, `extractRecentFiles()` scans compacted messages for the 5 most recently referenced file paths (from `read`, `edit`, `write`, `multiedit`, `lsp` tool inputs). Their contents are re-read and injected as `<system-reminder>` blocks in the continuation message. Capped at 5K tokens per file, 50K total. Files that no longer exist are skipped silently.

Works with Sieve-extracted outputs because `extractRecentFiles` reads `part.state.input` (tool call args), which Sieve preserves — Sieve only replaces `part.state.output`.

### Prompt-too-long retry

**Problem:** If the compaction prompt itself exceeds the model's context window, compaction fails permanently and the session is stuck.

**Solution:** `streamWithRetry()` wraps every LLM call in Horizon. On context overflow errors (detected via `APICallError` + `ProviderError.parseAPICallError`), it drops the oldest message rounds from the input, prepends a synthetic marker (`[Earlier conversation truncated for compaction retry]`), and retries up to 3 times. Follows the "lost in the middle" approach: truncate from the front rather than failing entirely.

### Idle-aware stale result clearing

**Problem:** After idle periods (e.g., overnight), stale tool results sit in context even though their prompt cache has expired.

**Solution:** `prune()` detects idle sessions and clears stale results aggressively, but only when it makes sense:

1. **Time gate**: Session is idle when `Date.now() - lastAssistantMessage.time > idle_threshold_minutes * 60_000`
2. **Pressure gate**: Idle clearing only activates when total staleable tool output exceeds `IDLE_PRESSURE_FLOOR` (20K tokens = 50% of PRUNE_PROTECT). No point clearing if context is barely used.
3. **Staleness filter**: Only outputs from staleable tools are cleared (`read`, `bash`, `grep`, `glob`, `list`, `write`, `edit`, `multiedit`). Analysis, skill, and other tool outputs are preserved regardless of age.

Configurable via `compaction.idle_threshold_minutes` (default 60).

### Transcript reference

**Problem:** After compaction, the agent has no way to recover specific details lost in the summary.

**Solution:** The continuation message includes the session ID so the agent can reference the full conversation history:

> If you need specific details from before compaction (like exact code snippets, error messages, or file contents), the full conversation history is preserved in session {sessionID}.

## Configuration

All compaction settings live under `compaction` in `opencode.json`:

| Key                        | Type    | Default | Description                                             |
| -------------------------- | ------- | ------- | ------------------------------------------------------- |
| `auto`                     | boolean | true    | Enable automatic compaction when context is full        |
| `prune`                    | boolean | true    | Enable pruning of old tool outputs                      |
| `reserved`                 | number  | —       | Token buffer to avoid overflow during compaction        |
| `extract_threshold`        | number  | 5000    | Token threshold for Sieve background extraction         |
| `narrative_threshold`      | number  | 0.5     | Fraction of context at which Horizon triggers (50%)     |
| `preserve_turns`           | number  | 4       | Recent turns Horizon preserves from summarization       |
| `max_deltas`               | number  | 3       | Consecutive delta cycles before forcing full re-summary |
| `max_consecutive_failures` | number  | 3       | Failed compaction attempts before pausing auto-compact  |
| `idle_threshold_minutes`   | number  | 60      | Minutes of inactivity before aggressive stale clearing  |
| `truncate_lines`           | number  | 2000    | Max lines for tool output before truncation             |
| `truncate_bytes`           | number  | 51200   | Max bytes for tool output before truncation             |

## Internal constants

| Constant              | Value  | Where                | Purpose                                                    |
| --------------------- | ------ | -------------------- | ---------------------------------------------------------- |
| `PRUNE_PROTECT`       | 40,000 | compaction.ts        | Token budget of recent tool outputs protected from pruning |
| `PRUNE_MINIMUM`       | 20,000 | compaction.ts        | Minimum token savings required to actually prune           |
| `IDLE_PRESSURE_FLOOR` | 20,000 | compaction.ts        | Minimum staleable tool output to trigger idle clearing     |
| `WATCHER_THRESHOLD`   | 2,000  | tiered-compaction.ts | Token threshold for Sieve auto-enqueue from processor      |
| `PRESERVE_TURNS`      | 5      | tiered-compaction.ts | Default turns preserved by Horizon                         |
| `MAX_PTL_RETRIES`     | 3      | tiered-compaction.ts | Retries on context overflow during summarization           |
| `PTL_DROP_PER_RETRY`  | 2      | tiered-compaction.ts | Model messages dropped per PTL retry round                 |
| `MAX_REATTACH_FILES`  | 5      | compaction-prompt.ts | Max files re-attached after compaction                     |
| `MAX_TOKENS_PER_FILE` | 5,000  | compaction-prompt.ts | Token cap per re-attached file                             |
| `MAX_TOKENS_TOTAL`    | 50,000 | compaction-prompt.ts | Total token cap for re-attached files                      |

## Key files

| File                                              | Role                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `src/session/tiered-compaction.ts`                | Sieve, Horizon, Seam — async compaction service                    |
| `src/session/compaction.ts`                       | Prune, sync compaction, `/compact` handler                         |
| `src/session/compaction-prompt.ts`                | Prompt helpers: stripSummaryMeta, continuation, file re-attachment |
| `src/session/tool-extraction.ts`                  | Sieve's LLM extraction logic                                       |
| `src/session/message-v2.ts`                       | CompactionPart schema, filterCompacted, streamRange                |
| `src/session/overflow.ts`                         | isOverflow threshold logic                                         |
| `src/agent/prompt/narrative-compaction.txt`       | Initial/full summary prompt                                        |
| `src/agent/prompt/narrative-compaction-delta.txt` | Delta prompt                                                       |
| `src/agent/prompt/narrative-compaction-merge.txt` | Merge prompt                                                       |
