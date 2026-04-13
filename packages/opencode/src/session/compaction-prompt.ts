/**
 * Strip model-generated metadata from compaction summary text.
 *
 * Models may produce <analysis>...</analysis> scratchpad blocks (chain-of-thought
 * prompting per Wei et al. 2022) and/or provider-specific thinking tags. This
 * function removes those and extracts the <summary> content.
 *
 * References:
 * - Wei et al. (2022) "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models"
 *
 * @param text - Raw model output
 * @returns Cleaned summary text with metadata stripped
 */
export function stripSummaryMeta(text: string): string {
  // Strip <analysis>...</analysis> blocks (DOTALL)
  let result = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim()

  // Extract <summary>...</summary> content if present
  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch) return summaryMatch[1].trim()

  // Strip <thinking>...</thinking> blocks (extended-thinking models)
  result = result.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim()

  return result
}

/** Preamble prepended to every compaction prompt to prevent tool use */
export const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need.
- Tool calls will be REJECTED and will waste your only turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.`

/** Trailer appended after every compaction prompt to reinforce the no-tools rule */
export const NO_TOOLS_TRAILER = `Remember: respond with <analysis> then <summary> tags only. No tool calls.`

/** Continuation message inserted after compaction to prevent acknowledgement waste */
export const CONTINUATION_PROMPT = `Continue the conversation from where it left off without asking further questions. Resume directly — do not acknowledge the compaction, do not recap what happened, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`

export function continuationWithSession(sessionID: string): string {
  return (
    CONTINUATION_PROMPT +
    `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or file contents), the full conversation history is preserved in session ${sessionID}.`
  )
}

const FILE_TOOLS = new Set(["read", "edit", "write", "multiedit", "lsp"])
const FILE_PATH_KEYS = ["filePath", "path"] as const

const MAX_REATTACH_FILES = 5
const MAX_TOKENS_PER_FILE = 5_000
const MAX_TOKENS_TOTAL = 50_000
const CHARS_PER_TOKEN = 4

import type { MessageV2 } from "./message-v2"

export function extractRecentFiles(msgs: MessageV2.WithParts[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (let i = msgs.length - 1; i >= 0 && paths.length < MAX_REATTACH_FILES; i--) {
    for (const part of msgs[i].parts) {
      if (paths.length >= MAX_REATTACH_FILES) break
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (!FILE_TOOLS.has(part.tool)) continue
      const input = part.state.input
      for (const key of FILE_PATH_KEYS) {
        const val = input[key]
        if (typeof val === "string" && val.startsWith("/") && !seen.has(val)) {
          seen.add(val)
          paths.push(val)
        }
      }
    }
  }
  return paths
}

export function formatFileReminders(entries: { path: string; content: string }[]): string {
  if (entries.length === 0) return ""
  const blocks = entries.map((e) => `<system-reminder>\nFile: ${e.path}\n${e.content}\n</system-reminder>`)
  return `\n\nThe following files were recently in context before compaction:\n${blocks.join("\n")}`
}

export function truncateToTokens(text: string, max: number): string {
  const maxChars = max * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + "\n... (truncated)"
}

export const REATTACH_LIMITS = {
  maxFiles: MAX_REATTACH_FILES,
  maxPerFile: MAX_TOKENS_PER_FILE,
  maxTotal: MAX_TOKENS_TOTAL,
} as const
