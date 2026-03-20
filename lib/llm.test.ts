import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConversationMessagesValidationError,
  runLlmTurn,
  validateConversationMessages,
} from "@/lib/llm";
import type { LlmRequestBody } from "@/lib/protocol";
import { getDefaultRuntimeConstraints } from "@/lib/runtime-constraints";

function createRequestBody(): LlmRequestBody {
  return {
    clientId: "client_test",
    sessionId: "session_test",
    sessionSecret: "secret_test",
    runId: "run_test",
    constraints: getDefaultRuntimeConstraints(),
    messages: [
      {
        id: "msg_user",
        role: "user",
        text: "inspect the workspace",
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

describe("llm proxy validation", () => {
  const originalApiKey = process.env.JUSTUNE_LLM_API_KEY;
  const originalModel = process.env.JUSTUNE_LLM_MODEL;

  beforeEach(() => {
    process.env.JUSTUNE_LLM_API_KEY = "test-key";
    process.env.JUSTUNE_LLM_MODEL = "test-model";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.JUSTUNE_LLM_API_KEY;
    } else {
      process.env.JUSTUNE_LLM_API_KEY = originalApiKey;
    }

    if (originalModel === undefined) {
      delete process.env.JUSTUNE_LLM_MODEL;
    } else {
      process.env.JUSTUNE_LLM_MODEL = originalModel;
    }

    vi.unstubAllGlobals();
  });

  it("rejects conversation messages with unsupported assistant tool calls", () => {
    expect(
      validateConversationMessages([
        {
          id: "msg_assistant",
          role: "assistant",
          text: "calling a tool",
          createdAt: new Date().toISOString(),
          toolCalls: [
            {
              toolCallId: "tc_invalid",
              tool: "unknownTool",
              input: {},
            },
          ],
        },
      ]),
    ).toBe(false);
  });

  it("rejects oversized client-supplied tool results", () => {
    expect(
      getConversationMessagesValidationError([
        {
          id: "msg_tool",
          role: "tool",
          tool: "readFile",
          toolCallId: "tc_large",
          output: {
            path: "/workspace/large.txt",
            content: "x".repeat(170_000),
            truncated: false,
          },
          createdAt: new Date().toISOString(),
        },
      ]),
    ).toBe("Tool message msg_tool exceeds the 160000 character result limit.");
  });

  it("rejects oversized total conversation history", () => {
    expect(
      getConversationMessagesValidationError(
        Array.from({ length: 5 }, (_, index) => ({
          id: `msg_user_${index}`,
          role: "user" as const,
          text: "x".repeat(90_000),
          createdAt: new Date().toISOString(),
        })),
      ),
    ).toBe("Conversation exceeds the 400000 character limit.");
  });

  it("fails closed when the provider returns an unsupported tool name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tc_invalid",
                    function: {
                      name: "unknownTool",
                      arguments: "{}",
                    },
                  },
                ],
              },
            },
          ],
        }),
      })),
    );

    await expect(runLlmTurn(createRequestBody())).rejects.toThrow(
      "LLM proxy returned an unsupported tool name: unknownTool.",
    );
  });

  it("fails closed when the provider returns invalid tool arguments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tc_invalid_args",
                    function: {
                      name: "readFile",
                      arguments: JSON.stringify({ wrong: "shape" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      })),
    );

    await expect(runLlmTurn(createRequestBody())).rejects.toThrow(
      "LLM proxy returned invalid arguments for readFile.",
    );
  });
});
