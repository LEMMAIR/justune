import {
  type ApplyPatchToolInput,
  type BashToolInput,
  type ConversationMessage,
  type ListWorkspacePathsToolInput,
  type LlmRequestBody,
  type LlmResponseBody,
  type ReadFileToolInput,
  type ReadFileRangeToolInput,
  type ReplaceInFileToolInput,
  type RuntimeConstraints,
  type ToolCall,
  type ToolInput,
  type ToolName,
  type WriteFileToolInput,
} from "@/lib/protocol";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const MAX_TOOL_CALLS_PER_TURN = 4;
const MAX_CONVERSATION_MESSAGES = 80;
const MAX_ASSISTANT_TOOL_CALLS_PER_MESSAGE = 8;
const MAX_MESSAGE_TEXT_CHARS = 120_000;
const MAX_TOOL_ARGUMENT_CHARS = 80_000;
const MAX_TOOL_RESULT_CHARS = 160_000;
const MAX_TOTAL_CONVERSATION_CHARS = 400_000;

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a bash command inside the browser workspace. Prefer focused read/search commands before editing files.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute from /workspace.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listWorkspacePaths",
      description:
        "List visible files and directories inside the browser workspace. Use this instead of broad shell listing when you only need paths.",
      parameters: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description: "Optional relative or absolute directory inside /workspace.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "readFile",
      description: "Read a UTF-8 text file from the browser workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative or absolute path within /workspace.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "readFileRange",
      description:
        "Read a line range from a UTF-8 text file. Prefer this for large files when you only need a specific section.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative or absolute path within /workspace.",
          },
          startLine: {
            type: "integer",
            description: "1-based inclusive start line.",
          },
          endLine: {
            type: "integer",
            description: "1-based inclusive end line.",
          },
        },
        required: ["path", "startLine", "endLine"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "writeFile",
      description:
        "Write a full UTF-8 text file to the browser workspace. Use it for creating or replacing files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative or absolute path within /workspace.",
          },
          content: {
            type: "string",
            description: "The complete file contents.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "applyPatch",
      description:
        "Apply a unified diff patch inside the browser workspace. Prefer this for multi-hunk or multi-file edits that are awkward to express as exact string replacement.",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description: "Unified diff patch text. Keep edits inside /workspace only.",
          },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replaceInFile",
      description:
        "Replace exact text in a UTF-8 text file without rewriting it manually. Use precise matches and set replaceAll only when every occurrence should change.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative or absolute path within /workspace.",
          },
          find: {
            type: "string",
            description: "Exact text to replace.",
          },
          replace: {
            type: "string",
            description: "Replacement text.",
          },
          replaceAll: {
            type: "boolean",
            description: "Replace every exact occurrence instead of only the first.",
          },
        },
        required: ["path", "find", "replace"],
        additionalProperties: false,
      },
    },
  },
] as const;

function formatSystemPrompt(constraints: RuntimeConstraints) {
  return [
    "You are justune, a browser-hosted coding agent runtime.",
    "Your job is to reason on the server, but every tool executes inside the user's browser workspace.",
    "The user cannot approve or reject individual tool calls, so you must stay inside the hard limits below.",
    "",
    "Rules:",
    `- Only operate inside ${constraints.workspaceRoot}.`,
    "- Use tools serially and keep commands concise.",
    "- Prefer `listWorkspacePaths`, `readFile`, and `readFileRange` before writing.",
    "- Prefer `replaceInFile` for focused edits, `applyPatch` for multi-hunk edits, and `writeFile` for full rewrites.",
    "- Never request network access, package installs, or real system changes.",
    "- If a tool returns a policy error, adapt instead of retrying the same unsafe action.",
    `- stdout/stderr may be truncated after ${constraints.maxOutputChars} characters.`,
    `- file reads may be truncated after ${constraints.maxReadChars} characters.`,
    `- single writes larger than ${constraints.maxWriteBytes} bytes are rejected.`,
    `- each bash execution is capped at ${constraints.timeoutMs}ms.`,
    "",
    "When finished, respond with a concise final answer.",
  ].join("\n");
}

function flattenAssistantContent(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }

        if (
          entry &&
          typeof entry === "object" &&
          "type" in entry &&
          "text" in entry &&
          entry.type === "text"
        ) {
          return String(entry.text);
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function safeParseJson(input: string) {
  try {
    return JSON.parse(input);
  } catch {
  return {};
  }
}

export function normalizeToolName(name: string): ToolName | null {
  if (
    name === "bash" ||
    name === "listWorkspacePaths" ||
    name === "readFile" ||
    name === "readFileRange" ||
    name === "writeFile" ||
    name === "replaceInFile" ||
    name === "applyPatch"
  ) {
    return name;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function parseToolInput(tool: ToolName, input: unknown): ToolInput | null {
  if (!isRecord(input)) {
    return null;
  }

  if (tool === "bash" && typeof input.command === "string") {
    return { command: input.command } satisfies BashToolInput;
  }

  if (
    tool === "listWorkspacePaths" &&
    (input.directory === undefined || typeof input.directory === "string")
  ) {
    return { directory: input.directory } satisfies ListWorkspacePathsToolInput;
  }

  if (tool === "readFile" && typeof input.path === "string") {
    return { path: input.path } satisfies ReadFileToolInput;
  }

  if (
    tool === "readFileRange" &&
    typeof input.path === "string" &&
    typeof input.startLine === "number" &&
    Number.isInteger(input.startLine) &&
    typeof input.endLine === "number" &&
    Number.isInteger(input.endLine)
  ) {
    return {
      path: input.path,
      startLine: input.startLine,
      endLine: input.endLine,
    } satisfies ReadFileRangeToolInput;
  }

  if (
    tool === "writeFile" &&
    typeof input.path === "string" &&
    typeof input.content === "string"
  ) {
    return {
      path: input.path,
      content: input.content,
    } satisfies WriteFileToolInput;
  }

  if (
    tool === "replaceInFile" &&
    typeof input.path === "string" &&
    typeof input.find === "string" &&
    typeof input.replace === "string" &&
    (input.replaceAll === undefined || typeof input.replaceAll === "boolean")
  ) {
    return {
      path: input.path,
      find: input.find,
      replace: input.replace,
      replaceAll: input.replaceAll,
    } satisfies ReplaceInFileToolInput;
  }

  if (tool === "applyPatch" && typeof input.patch === "string") {
    return { patch: input.patch } satisfies ApplyPatchToolInput;
  }

  return null;
}

function isToolError(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isValidToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value) || typeof value.toolCallId !== "string") {
    return false;
  }

  const tool = normalizeToolName(typeof value.tool === "string" ? value.tool : "");
  if (!tool) {
    return false;
  }

  return parseToolInput(tool, value.input) !== null;
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.role !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return false;
  }

  if (value.role === "user") {
    return typeof value.text === "string";
  }

  if (value.role === "assistant") {
    return (
      typeof value.text === "string" &&
      (value.toolCalls === undefined ||
        (Array.isArray(value.toolCalls) && value.toolCalls.every(isValidToolCall)))
    );
  }

  if (value.role === "tool") {
    const tool = normalizeToolName(typeof value.tool === "string" ? value.tool : "");
    if (!tool || typeof value.toolCallId !== "string") {
      return false;
    }

    return (
      (value.output === undefined || isRecord(value.output)) &&
      (value.error === undefined || isToolError(value.error))
    );
  }

  return false;
}

export function validateConversationMessages(messages: unknown): messages is ConversationMessage[] {
  return Array.isArray(messages) && messages.every(isConversationMessage);
}

function measureJsonChars(value: unknown) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function getConversationMessagesValidationError(
  messages: ConversationMessage[],
): string | null {
  if (messages.length > MAX_CONVERSATION_MESSAGES) {
    return `Conversation exceeds the ${MAX_CONVERSATION_MESSAGES} message limit.`;
  }

  let totalChars = 0;

  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      totalChars += message.text.length;
      if (message.text.length > MAX_MESSAGE_TEXT_CHARS) {
        return `Conversation message ${message.id} exceeds the ${MAX_MESSAGE_TEXT_CHARS} character limit.`;
      }
    }

    if (message.role === "assistant" && message.toolCalls) {
      if (message.toolCalls.length > MAX_ASSISTANT_TOOL_CALLS_PER_MESSAGE) {
        return `Assistant message ${message.id} exceeds the ${MAX_ASSISTANT_TOOL_CALLS_PER_MESSAGE} tool-call limit.`;
      }

      for (const toolCall of message.toolCalls) {
        totalChars += toolCall.toolCallId.length + toolCall.tool.length;
        const inputChars = measureJsonChars(toolCall.input);
        if (inputChars > MAX_TOOL_ARGUMENT_CHARS) {
          return `Tool call ${toolCall.toolCallId} exceeds the ${MAX_TOOL_ARGUMENT_CHARS} character argument limit.`;
        }
        totalChars += inputChars;
      }
    }

    if (message.role === "tool") {
      const resultChars = measureJsonChars(
        message.error ? { error: message.error } : message.output,
      );
      if (resultChars > MAX_TOOL_RESULT_CHARS) {
        return `Tool message ${message.id} exceeds the ${MAX_TOOL_RESULT_CHARS} character result limit.`;
      }
      totalChars += resultChars;
    }

    if (totalChars > MAX_TOTAL_CONVERSATION_CHARS) {
      return `Conversation exceeds the ${MAX_TOTAL_CONVERSATION_CHARS} character limit.`;
    }
  }

  return null;
}

export function getConversationMessagesCharacterCount(messages: ConversationMessage[]) {
  let totalChars = 0;

  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      totalChars += message.text.length;
    }

    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        totalChars += toolCall.toolCallId.length + toolCall.tool.length;
        totalChars += measureJsonChars(toolCall.input);
      }
    }

    if (message.role === "tool") {
      totalChars += measureJsonChars(message.error ? { error: message.error } : message.output);
    }
  }

  return totalChars;
}

function mapMessages(messages: ConversationMessage[], constraints: RuntimeConstraints) {
  return [
    { role: "system", content: formatSystemPrompt(constraints) },
    ...messages.map((message) => {
      if (message.role === "user") {
        return {
          role: "user" as const,
          content: message.text,
        };
      }

      if (message.role === "assistant") {
        return {
          role: "assistant" as const,
          content: message.text || "",
          tool_calls: message.toolCalls?.map((toolCall) => ({
            id: toolCall.toolCallId,
            type: "function",
            function: {
              name: toolCall.tool,
              arguments: JSON.stringify(toolCall.input),
            },
          })),
        };
      }

      return {
        role: "tool" as const,
        tool_call_id: message.toolCallId,
        content: JSON.stringify(message.error ? { error: message.error } : message.output),
      };
    }),
  ];
}

function createToolCall(tool: ToolName, input: ToolInput, toolCallId: string): ToolCall {
  return {
    toolCallId,
    tool,
    input,
  };
}

function buildDemoToolCallId(seed: number, tool: ToolName) {
  return `demo_${seed}_${tool}`;
}

function pickLikelyFile(stdout: string) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    lines.find((line) => /README|todo|notes|config/i.test(line)) ??
    lines.find((line) => /\.(md|ts|tsx|json)$/i.test(line)) ??
    lines[0]
  );
}

function runDemoModel(body: LlmRequestBody): LlmResponseBody {
  const toolMessages = body.messages.filter((message) => message.role === "tool");
  const lastTool = toolMessages.at(-1);

  if (!lastTool) {
    return {
      mode: "demo",
      assistantText:
        "Demo mode is active because `JUSTUNE_LLM_API_KEY` is not configured. I’ll still inspect the local workspace so you can exercise the runner.",
      toolCalls: [
        createToolCall(
          "listWorkspacePaths",
          {},
          buildDemoToolCallId(body.messages.length, "listWorkspacePaths"),
        ),
      ],
    };
  }

  if (
    lastTool.tool === "listWorkspacePaths" &&
    lastTool.output &&
    "paths" in lastTool.output
  ) {
    const candidate = pickLikelyFile(lastTool.output.paths.join("\n"));
    if (candidate) {
      return {
        mode: "demo",
        assistantText: "I found a representative file. I’ll open it next.",
        toolCalls: [
          createToolCall(
            "readFile",
            { path: candidate },
            buildDemoToolCallId(body.messages.length, "readFile"),
          ),
        ],
      };
    }
  }

  if (lastTool.tool === "readFile") {
    const path =
      lastTool.output && "path" in lastTool.output ? lastTool.output.path : "the file";
    const content =
      lastTool.output && "content" in lastTool.output ? lastTool.output.content : "";

    return {
      mode: "demo",
      assistantText: [
        `Demo mode summary for ${path}:`,
        "",
        content.slice(0, 480).trim() || "The file was empty.",
        content.length > 480 ? "\n…\nConfigure a provider key for full reasoning." : "",
      ]
        .join("\n")
        .trim(),
      toolCalls: [],
    };
  }

  if (lastTool.tool === "readFileRange") {
    const path =
      lastTool.output && "path" in lastTool.output ? lastTool.output.path : "the file";
    const content =
      lastTool.output && "content" in lastTool.output ? lastTool.output.content : "";

    return {
      mode: "demo",
      assistantText: [
        `Demo mode range summary for ${path}:`,
        "",
        content.slice(0, 480).trim() || "The selected range was empty.",
        content.length > 480 ? "\n…\nConfigure a provider key for full reasoning." : "",
      ]
        .join("\n")
        .trim(),
      toolCalls: [],
    };
  }

  if (lastTool.tool === "writeFile") {
    const path =
      lastTool.output && "path" in lastTool.output ? lastTool.output.path : "the file";

    return {
      mode: "demo",
      assistantText: `Demo mode wrote ${path}. Configure a live LLM provider to continue autonomous reasoning across more complex tasks.`,
      toolCalls: [],
    };
  }

  if (lastTool.tool === "replaceInFile") {
    const path =
      lastTool.output && "path" in lastTool.output ? lastTool.output.path : "the file";

    return {
      mode: "demo",
      assistantText: `Demo mode updated ${path} with a focused replacement. Configure a live LLM provider to continue autonomous reasoning across more complex tasks.`,
      toolCalls: [],
    };
  }

  if (lastTool.tool === "applyPatch") {
    return {
      mode: "demo",
      assistantText:
        "Demo mode applied the requested patch. Configure a live LLM provider to continue autonomous reasoning across more complex tasks.",
      toolCalls: [],
    };
  }

  return {
    mode: "demo",
    assistantText:
      "Demo mode completed the current tool sequence. Add `JUSTUNE_LLM_API_KEY` and `JUSTUNE_LLM_MODEL` for live model calls.",
    toolCalls: [],
  };
}

function isProviderConfigured() {
  return Boolean(process.env.JUSTUNE_LLM_API_KEY && process.env.JUSTUNE_LLM_MODEL);
}

export function getProviderLabel() {
  if (!isProviderConfigured()) {
    return "Demo mode";
  }

  return process.env.JUSTUNE_LLM_MODEL ?? "OpenAI-compatible";
}

export function getProviderReady() {
  return isProviderConfigured();
}

export async function runLlmTurn(body: LlmRequestBody): Promise<LlmResponseBody> {
  if (!isProviderConfigured()) {
    return runDemoModel(body);
  }

  const baseUrl = (process.env.JUSTUNE_LLM_BASE_URL ?? OPENAI_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.JUSTUNE_LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.JUSTUNE_LLM_MODEL,
      temperature: 0.2,
      messages: mapMessages(body.messages, body.constraints),
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM proxy failed with ${response.status}.`);
  }

  const data = await response.json();
  const firstChoice = data?.choices?.[0]?.message;

  if (!firstChoice) {
    throw new Error("LLM proxy returned no choices.");
  }

  const toolCalls: ToolCall[] = [];
  for (const toolCall of (firstChoice.tool_calls ?? []).slice(0, MAX_TOOL_CALLS_PER_TURN)) {
    if (!isRecord(toolCall) || typeof toolCall.id !== "string" || !isRecord(toolCall.function)) {
      throw new Error("LLM proxy returned a malformed tool call.");
    }

    const functionName =
      typeof toolCall.function.name === "string" ? toolCall.function.name : "";
    const functionArguments =
      typeof toolCall.function.arguments === "string"
        ? toolCall.function.arguments
        : "{}";

    const name = normalizeToolName(functionName);
    if (!name) {
      throw new Error(`LLM proxy returned an unsupported tool name: ${functionName}.`);
    }

    const parsedInput = parseToolInput(
      name,
      safeParseJson(functionArguments),
    );
    if (!parsedInput) {
      throw new Error(`LLM proxy returned invalid arguments for ${name}.`);
    }

    toolCalls.push(createToolCall(name, parsedInput, toolCall.id));
  }

  return {
    mode: "provider",
    assistantText: flattenAssistantContent(firstChoice.content),
    toolCalls,
  };
}
