import { describe, expect, it, vi } from "vitest";
import {
  MAX_RUN_STEPS,
  runAgentLoop,
} from "@/lib/agent-runner";
import type { ConversationMessage, ToolCall, ToolMessage } from "@/lib/protocol";

function createAbortSignal() {
  return new AbortController().signal;
}

describe("agent runner", () => {
  it("de-dupes repeated tool calls by toolCallId", async () => {
    const executeToolCall = vi.fn(async (toolCall: ToolCall) => {
      return {
        id: crypto.randomUUID(),
        role: "tool",
        tool: toolCall.tool,
        toolCallId: toolCall.toolCallId,
        output: {
          stdout: "done",
          stderr: "",
          exitCode: 0,
        },
        createdAt: new Date().toISOString(),
      } satisfies ToolMessage;
    });

    const result = await runAgentLoop({
      initialMessages: [],
      promptText: "inspect",
      runId: "run_12345678-1234-1234-1234-123456789abc",
      signal: createAbortSignal(),
      requestLlm: vi
        .fn()
        .mockResolvedValueOnce({
          assistantText: "Need one tool.",
          mode: "demo",
          toolCalls: [
            { toolCallId: "tc_repeat", tool: "bash", input: { command: "pwd" } },
            { toolCallId: "tc_repeat", tool: "bash", input: { command: "pwd" } },
          ],
        })
        .mockResolvedValueOnce({
          assistantText: "Done.",
          mode: "demo",
          toolCalls: [],
        }),
      executeToolCall,
    });

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(
      result.messages.filter(
        (message) => message.role === "tool" && message.toolCallId === "tc_repeat",
      ),
    ).toHaveLength(1);
  });

  it("fails when the step limit is exceeded", async () => {
    const requestLlm = vi.fn(async () => ({
      assistantText: "Keep going.",
      mode: "demo" as const,
      toolCalls: [{ toolCallId: crypto.randomUUID(), tool: "bash" as const, input: { command: "pwd" } }],
    }));
    const executeToolCall = vi.fn(async (toolCall: ToolCall) => {
      return {
        id: crypto.randomUUID(),
        role: "tool",
        tool: toolCall.tool,
        toolCallId: toolCall.toolCallId,
        output: { stdout: "", stderr: "", exitCode: 0 },
        createdAt: new Date().toISOString(),
      } satisfies ToolMessage;
    });

    await expect(
      runAgentLoop({
        initialMessages: [] satisfies ConversationMessage[],
        runId: "run_99999999-1234-1234-1234-123456789abc",
        signal: createAbortSignal(),
        requestLlm,
        executeToolCall,
      }),
    ).rejects.toThrow("Run reached the 20 step limit.");

    expect(requestLlm).toHaveBeenCalledTimes(MAX_RUN_STEPS);
  });

  it("returns a budget error when the write budget is exceeded", async () => {
    const requestLlm = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: "Write something.",
        mode: "demo" as const,
        toolCalls: [
          {
            toolCallId: "tc_write",
            tool: "writeFile" as const,
            input: { path: "a.txt", content: "hello" },
          },
        ],
      })
      .mockResolvedValueOnce({
        assistantText: "Done.",
        mode: "demo" as const,
        toolCalls: [],
      });

    const executeToolCall = vi.fn(async (toolCall: ToolCall) => {
      return {
        id: crypto.randomUUID(),
        role: "tool",
        tool: toolCall.tool,
        toolCallId: toolCall.toolCallId,
        output: { path: "a.txt", success: true, bytesWritten: 5 },
        createdAt: new Date().toISOString(),
      } satisfies ToolMessage;
    });

    const result = await runAgentLoop({
      initialMessages: [],
      runId: "run_budget_write",
      signal: createAbortSignal(),
      requestLlm,
      executeToolCall,
      budgets: { maxReadChars: 100, maxOutputChars: 100, maxWriteBytes: 1 },
    });

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(
      result.messages.find(
        (message) => message.role === "tool" && message.toolCallId === "tc_write",
      ),
    ).toMatchObject({
      error: { code: "BUDGET_EXCEEDED" },
    });
  });

  it("preflights replaceInFile writes against the run budget", async () => {
    const requestLlm = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: "Replace some text.",
        mode: "demo" as const,
        toolCalls: [
          {
            toolCallId: "tc_replace_budget",
            tool: "replaceInFile" as const,
            input: { path: "a.txt", find: "old", replace: "new" },
          },
        ],
      })
      .mockResolvedValueOnce({
        assistantText: "Done.",
        mode: "demo" as const,
        toolCalls: [],
      });

    const executeToolCall = vi.fn();
    const estimateToolCallWriteBytes = vi.fn(async () => 12);

    const result = await runAgentLoop({
      initialMessages: [],
      runId: "run_budget_replace",
      signal: createAbortSignal(),
      requestLlm,
      executeToolCall,
      estimateToolCallWriteBytes,
      budgets: { maxReadChars: 100, maxOutputChars: 100, maxWriteBytes: 10 },
    });

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(estimateToolCallWriteBytes).toHaveBeenCalledTimes(1);
    expect(
      result.messages.find(
        (message) => message.role === "tool" && message.toolCallId === "tc_replace_budget",
      ),
    ).toMatchObject({
      error: { code: "BUDGET_EXCEEDED" },
    });
  });

  it("truncates tool output when the output budget is reached", async () => {
    const requestLlm = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: "Run a command.",
        mode: "demo" as const,
        toolCalls: [
          {
            toolCallId: "tc_stdout",
            tool: "bash" as const,
            input: { command: "echo big" },
          },
        ],
      })
      .mockResolvedValueOnce({
        assistantText: "Done.",
        mode: "demo" as const,
        toolCalls: [],
      });

    const executeToolCall = vi.fn(async (toolCall: ToolCall) => {
      return {
        id: crypto.randomUUID(),
        role: "tool",
        tool: toolCall.tool,
        toolCallId: toolCall.toolCallId,
        output: {
          stdout: "x".repeat(200),
          stderr: "y".repeat(200),
          exitCode: 0,
        },
        createdAt: new Date().toISOString(),
      } satisfies ToolMessage;
    });

    const result = await runAgentLoop({
      initialMessages: [],
      runId: "run_budget_output",
      signal: createAbortSignal(),
      requestLlm,
      executeToolCall,
      budgets: { maxReadChars: 1000, maxOutputChars: 80, maxWriteBytes: 1000 },
    });

    const toolMessage = result.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "tc_stdout",
    );
    if (!toolMessage || toolMessage.role !== "tool") {
      throw new Error("Expected tool message.");
    }
    if (!toolMessage.output || !("stdout" in toolMessage.output)) {
      throw new Error("Expected bash output.");
    }

    expect(toolMessage.output.stdout).toContain("[run output budget truncated]");
    expect(toolMessage.output.stdout.length + toolMessage.output.stderr.length).toBeLessThanOrEqual(80);
  });

  it("truncates listed paths when the read budget is reached", async () => {
    const requestLlm = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: "List the workspace.",
        mode: "demo" as const,
        toolCalls: [
          {
            toolCallId: "tc_paths",
            tool: "listWorkspacePaths" as const,
            input: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        assistantText: "Done.",
        mode: "demo" as const,
        toolCalls: [],
      });

    const executeToolCall = vi.fn(async (toolCall: ToolCall) => {
      return {
        id: crypto.randomUUID(),
        role: "tool",
        tool: toolCall.tool,
        toolCallId: toolCall.toolCallId,
        output: {
          directory: "/workspace",
          paths: ["/workspace/a.txt", "/workspace/long-name.txt", "/workspace/z.txt"],
          truncated: false,
        },
        createdAt: new Date().toISOString(),
      } satisfies ToolMessage;
    });

    const result = await runAgentLoop({
      initialMessages: [],
      runId: "run_budget_paths",
      signal: createAbortSignal(),
      requestLlm,
      executeToolCall,
      budgets: { maxReadChars: 20, maxOutputChars: 1000, maxWriteBytes: 1000 },
    });

    const toolMessage = result.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "tc_paths",
    );
    if (!toolMessage || toolMessage.role !== "tool") {
      throw new Error("Expected tool message.");
    }
    if (!toolMessage.output || !("paths" in toolMessage.output)) {
      throw new Error("Expected path list output.");
    }

    expect(toolMessage.output.paths).toEqual(["/workspace/a.txt"]);
    expect(toolMessage.output.truncated).toBe(true);
  });

  it("returns a budget error when applyPatch writes exceed the run budget", async () => {
    const requestLlm = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: "Apply a patch.",
        mode: "demo" as const,
        toolCalls: [
          {
            toolCallId: "tc_patch_budget",
            tool: "applyPatch" as const,
            input: { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n" },
          },
        ],
      })
      .mockResolvedValueOnce({
        assistantText: "Done.",
        mode: "demo" as const,
        toolCalls: [],
      });

    const executeToolCall = vi.fn();
    const estimateToolCallWriteBytes = vi.fn(async () => 20);

    const result = await runAgentLoop({
      initialMessages: [],
      runId: "run_budget_patch",
      signal: createAbortSignal(),
      requestLlm,
      executeToolCall,
      estimateToolCallWriteBytes,
      budgets: { maxReadChars: 1000, maxOutputChars: 1000, maxWriteBytes: 10 },
    });

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(estimateToolCallWriteBytes).toHaveBeenCalledTimes(1);
    const toolMessage = result.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "tc_patch_budget",
    );

    expect(toolMessage).toMatchObject({
      error: {
        code: "BUDGET_EXCEEDED",
        message: "Run write budget exceeded: 20 bytes exceeds the 10 byte limit.",
      },
    });
  });
});
