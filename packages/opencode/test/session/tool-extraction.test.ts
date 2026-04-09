import { describe, test, expect } from "bun:test"
import { ToolExtraction } from "../../src/session/tool-extraction"
import { MessageV2 } from "../../src/session/message-v2"
import { PartID, SessionID, MessageID } from "../../src/session/schema"

const sid = SessionID.zod.parse("sess_01")

function makePart(overrides: {
  output: string
  tool?: string
  metadata?: Record<string, any>
  time?: { compacted?: number }
}): MessageV2.ToolPart {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: sid,
    type: "tool",
    callID: "call_1",
    tool: overrides.tool ?? "bash",
    state: {
      status: "completed" as const,
      input: {},
      output: overrides.output,
      title: "test",
      metadata: overrides.metadata ?? {},
      time: {
        start: Date.now() - 1000,
        end: Date.now(),
        ...(overrides.time?.compacted ? { compacted: overrides.time.compacted } : {}),
      },
    },
  }
}

describe("ToolExtraction", () => {
  describe("shouldExtract", () => {
    test("returns false for pending tool state", () => {
      const part: MessageV2.ToolPart = {
        id: PartID.ascending(),
        messageID: MessageID.ascending(),
        sessionID: sid,
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: { status: "pending", input: {}, raw: "" },
      }
      expect(ToolExtraction.shouldExtract(part)).toBe(false)
    })

    test("returns false for already compacted output", () => {
      const part = makePart({ output: "x".repeat(10000), time: { compacted: Date.now() } })
      expect(ToolExtraction.shouldExtract(part)).toBe(false)
    })

    test("returns false for protected tools", () => {
      const part = makePart({ output: "x".repeat(10000), tool: "skill" })
      expect(ToolExtraction.shouldExtract(part)).toBe(false)
    })

    test("returns false for short output", () => {
      const part = makePart({ output: "short output" })
      expect(ToolExtraction.shouldExtract(part)).toBe(false)
    })

    test("returns true for large output that meets all criteria", () => {
      const part = makePart({ output: "x ".repeat(10000) })
      expect(ToolExtraction.shouldExtract(part)).toBe(true)
    })

    test("respects custom threshold", () => {
      const part = makePart({ output: "x ".repeat(100) })
      expect(ToolExtraction.shouldExtract(part, 50)).toBe(true)
      expect(ToolExtraction.shouldExtract(part, 50000)).toBe(false)
    })
  })

  describe("structuredPreviewSync", () => {
    test("returns fallback for non-completed state", () => {
      const part: MessageV2.ToolPart = {
        id: PartID.ascending(),
        messageID: MessageID.ascending(),
        sessionID: sid,
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: { status: "pending", input: {}, raw: "" },
      }
      expect(ToolExtraction.structuredPreviewSync(part)).toBe("[Old tool result content cleared]")
    })

    test("includes tool name in preview", () => {
      const part = makePart({ output: "line1\nline2\nline3" })
      const result = ToolExtraction.structuredPreviewSync(part)
      expect(result).toContain("Tool: bash")
    })

    test("includes args when present", () => {
      const part = makePart({ output: "output" })
      part.state.input = { cmd: "ls -la" }
      const result = ToolExtraction.structuredPreviewSync(part)
      expect(result).toContain("Args:")
      expect(result).toContain("cmd")
    })

    test("includes disk path when metadata has outputPath", () => {
      const part = makePart({
        output: "output",
        metadata: { outputPath: "/tmp/tool_abc123" },
      })
      const result = ToolExtraction.structuredPreviewSync(part)
      expect(result).toContain("Full output: /tmp/tool_abc123")
    })

    test("extracts error lines", () => {
      const output = "building...\nError: cannot find module\n  at line 42\nbuilding...\nFAIL src/test.ts\nDone"
      const part = makePart({ output })
      const result = ToolExtraction.structuredPreviewSync(part)
      expect(result).toContain("Errors:")
      expect(result).toContain("Error: cannot find module")
    })

    test("includes last N lines", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
      const part = makePart({ output: lines.join("\n") })
      const result = ToolExtraction.structuredPreviewSync(part)
      expect(result).toContain("Last 5 lines:")
      expect(result).toContain("line 16")
      expect(result).toContain("line 20")
    })

    test("wraps everything in compacted marker", () => {
      const part = makePart({ output: "simple output" })
      const result = ToolExtraction.structuredPreviewSync(part)
      expect(result).toMatch(/^\[Compacted tool result\./)
    })
  })
})
