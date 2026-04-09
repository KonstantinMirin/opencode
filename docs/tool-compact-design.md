# Sieve: Context-Aware Tool Output Extraction

## Problem

Tool outputs (bash commands, grep results, file reads) are the primary source of context bloat. A single `grep -r` can produce 50K+ tokens. Current approaches:

- **Truncate** (existing): Caps output at 2000 lines / 50KB at execution time. Saves full output to disk, injects preview + file path. Zero LLM calls. Works but the preview is just the first ~2KB — often the least relevant part.
- **Prune** (existing): Marks old tool outputs as `[Old tool result content cleared]`. Zero cost but total information loss. The model can't even tell what tool was run.
- **Full compaction** (existing): Summarizes the entire conversation at ~100% capacity. Expensive LLM call. Paraphrases specifics (file paths, error messages, line numbers).

## Research Context

- **JetBrains** (NeurIPS 2025): Observation masking matched or beat LLM summarization on SWE-bench while being 52% cheaper. Tool outputs are the bloat source, not reasoning traces.
- **Factory.ai**: LLM summarization retains only 37% of information across sessions. 1 in 5 facts gets distorted.
- **ACON framework**: Aggressive compression of tool outputs preserved 95%+ accuracy with 26-54% token reduction.
- **Morph**: Verbatim compaction (delete tokens, never rewrite) achieves 98% accuracy at 3300 tok/s. Zero hallucination risk.
- **The re-reading loop**: Summarization causes model to re-search for specifics lost in paraphrase, refilling context, triggering another summary. Extraction breaks this loop.

## Design: Three Tiers

### Tier 0 — Truncate (existing, no changes)

At tool execution time. Caps output at 2000 lines / 50KB. Saves full output to `~/.opencode/tool-output/<tool_id>`. Injects preview (first ~2KB) + file path.

This already works. No changes needed.

### Tier 1 — Enhanced observation masking (enhanced prune)

Replaces `[Old tool result content cleared]` with a structured extraction that preserves what tool was run, what arguments, exit code, error patterns, and the last few lines. **No LLM call.** Pure string manipulation.

Example output:

```
[Compacted tool result. Tool: bash. Command: "npm test". Full output: ~/.opencode/tool-output/tool_abc123]
Exit code: 1. 47 tests passed, 3 failed.
Failed tests: auth.test.ts::login_redirect, session.test.ts::compact_overflow, api.test.ts::rate_limit
Last 3 lines:
  FAIL src/auth.test.ts
  Test suite failed: 3 tests failed
  npm error code ELIFECYCLE
```

Preserves:

- What tool was run (name, arguments)
- Exit code / status
- Error patterns (failed test names, error strings)
- Last N lines of output
- Pointer to full output on disk

### Tier 2 — Context-aware extraction (new, background)

When a tool output crosses a threshold (5,000+ tokens estimated), use a cheap model with conversation context to extract relevant specifics. **This is extraction, not summarization.** The model is instructed to preserve exact strings and omit only clearly irrelevant content.

The extraction prompt:

- Provides the last 6 messages (user requests, assistant reasoning, tool calls) as context
- Provides the full tool output (or disk path if already truncated)
- Instructs the model to preserve exact file paths, line numbers, error messages, config values
- Explicitly forbids paraphrasing

Runs in a forked fiber, non-blocking. If extraction completes before the next LLM call, the compacted version is used. If not, the original (or Tier 0 preview) version is used.

### Tier 3 — Full compaction (existing, safety net at ~95% capacity)

The existing sync compaction. Narrative summary of entire conversation. No changes.

## Data Flow

```
Tool executes → output stored in ToolPart
                      ↓
              output > 50KB? (Tier 0)
                 Yes          No
                  ↓             ↓
           Truncate.output   Normal flow
           (save to disk,
            inject preview)
                  ↓
         output > 5000 tokens? (Tier 2 check)
            Yes          No
             ↓             ↓
      Queue for        Normal flow
      extraction
             ↓
      Fork fiber with:
        - last 6 messages (context)
        - tool name + args
        - full output (or path)
             ↓
      Cheap model extracts
      relevant facts
             ↓
      Update ToolPart:
        state.output = extraction
        state.time.compacted = now
        state.metadata.compactedPath = disk_path
             ↓
      Next LLM call sees
      the extraction instead

      ... later, when prune runs (Tier 1) ...

      If part is already compacted (Tier 2):
        Generate structured preview from extraction
      If part is NOT compacted:
        Generate structured preview from original output
```

## Integration with Existing Systems

**With `prune` (Tier 1):** Prune runs after the loop ends. If a tool output has already been extracted (Tier 2), prune's token counting will find it takes fewer tokens, so it may not need to mask it. If prune still decides to mask it, the enhanced preview (Tier 1) includes the extraction content, not just `[cleared]`.

**With `filterCompacted` (Tier 3):** No changes needed. The existing boundary/summary system handles full conversation compaction. Tool output extractions are stored in-place in `ToolPart.state.output`, so they're part of the normal message stream.

**With `Truncate.output` (Tier 0):** This already saves full output to disk and replaces with a preview. Tier 2 extraction uses the same disk path. The extraction model reads from the disk file if the in-memory output was already truncated.

## Implementation Plan

### 1. `src/session/tool-extraction.ts` — New file

```
extractionPrompt(context, toolCall, toolOutput)  — Builds the prompt
shouldExtract(part)                                — Threshold check (>5k tokens, not compacted, not protected)
extract(part, context)                             — Calls the LLM, returns extraction
runExtraction(sessionID, partID)                   — Orchestrates: load context → build prompt → call LLM → update part
```

### 2. `src/session/message-v2.ts` — Modify `toModelMessages`

- Replace `[Old tool result content cleared]` with structured preview when `compacted` timestamp is set
- If `state.metadata.extraction` exists, render it instead of the preview

### 3. `src/session/tiered-compaction.ts` — Modify `enqueue`/`watchLoop`

- `enqueue` now queues for Tier 2 extraction instead of LLM compression
- `watchLoop` calls `extract()` instead of `compress()`
- Keep the existing queue/fiber infrastructure

### 4. `src/session/compaction.ts` — Modify `prune`

- Instead of just setting `time.compacted`, also generate a Tier 1 structured preview from the tool metadata
- Store the preview in `state.metadata.preview`

### 5. `src/agent/prompt/tool-extraction.txt` — New prompt file

### 6. `src/session/prompt.ts` — Wire `enqueue` call after tool results

- After each turn with tool results, call `tiered.enqueue()` for each large tool output

## Key Design Decisions

| Decision                   | Choice                          | Rationale                                                |
| -------------------------- | ------------------------------- | -------------------------------------------------------- |
| Extraction vs summary      | Extraction                      | Preserves exact strings; avoids re-reading loop          |
| Context window size        | Last 6 messages                 | Enough to understand task; cheap to pass                 |
| Model                      | Cheapest available              | Extraction is pattern matching, not creative work        |
| Token threshold for Tier 2 | >5k tokens                      | Balances cost vs benefit                                 |
| Storage                    | Same disk path as Truncate      | Reuses existing infrastructure                           |
| Tier 1 vs Tier 2           | Both                            | Tier 1 is free; Tier 2 adds fidelity when worth the cost |
| Blocking?                  | No — forked fiber, non-blocking | Conversation continues; extraction catches up            |
| Protected tools            | `["skill"]`                     | Same as existing prune protection                        |
