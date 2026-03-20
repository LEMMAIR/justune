import type {
  AssistantMessage,
  ConversationMessage,
  LlmResponseBody,
  ToolCall,
  ToolMessage,
} from "./protocol";

export const MAX_RUN_STEPS = 20;
export const MAX_RUN_WALL_TIME_MS = 120_000;

export interface RunDataBudgets {
  maxReadChars: number;
  maxOutputChars: number;
  maxWriteBytes: number;
}

interface RunLoopCallbacks {
  onAssistantMessage?: (
    assistantMessage: AssistantMessage,
    messages: ConversationMessage[],
  ) => void;
  onToolMessage?: (
    toolCall: ToolCall,
    toolMessage: ToolMessage,
    messages: ConversationMessage[],
  ) => void;
  onModeChange?: (mode: LlmResponseBody["mode"]) => void;
}

export interface RunAgentLoopOptions extends RunLoopCallbacks {
  initialMessages: ConversationMessage[];
  requestLlm: (
    messages: ConversationMessage[],
    runId: string,
    signal: AbortSignal,
  ) => Promise<LlmResponseBody>;
  executeToolCall: (toolCall: ToolCall) => Promise<ToolMessage>;
  estimateToolCallWriteBytes?: (toolCall: ToolCall) => Promise<number | null>;
  signal: AbortSignal;
  runId: string;
  promptText?: string;
  now?: () => number;
  budgets?: RunDataBudgets;
}

export interface RunAgentLoopResult {
  messages: ConversationMessage[];
  lastMode: LlmResponseBody["mode"] | null;
}

function nowIso() {
  return new Date().toISOString();
}

function buildAbortError() {
  return new DOMException("Run stopped.", "AbortError");
}

function truncateWithSuffix(value: string, maxLength: number, suffix: string) {
  if (value.length <= maxLength) {
    return { value, truncated: false };
  }

  if (maxLength <= suffix.length) {
    return { value: suffix.slice(0, maxLength), truncated: true };
  }

  return {
    value: `${value.slice(0, maxLength - suffix.length)}${suffix}`,
    truncated: true,
  };
}

function truncatePathList(paths: string[], maxLength: number) {
  const kept: string[] = [];
  let usedChars = 0;

  for (const path of paths) {
    const nextCost = (kept.length > 0 ? 1 : 0) + path.length;
    if (usedChars + nextCost > maxLength) {
      return { paths: kept, truncated: true };
    }
    kept.push(path);
    usedChars += nextCost;
  }

  return { paths: kept, truncated: false };
}

function createBudgetError(toolCall: ToolCall, message: string): ToolMessage {
  return {
    id: crypto.randomUUID(),
    role: "tool",
    tool: toolCall.tool,
    toolCallId: toolCall.toolCallId,
    error: { code: "BUDGET_EXCEEDED", message },
    createdAt: nowIso(),
  };
}

export function buildToolCache(messages: ConversationMessage[]) {
  const cache = new Map<string, ToolMessage>();

  for (const message of messages) {
    if (message.role === "tool") {
      cache.set(message.toolCallId, message);
    }
  }

  return cache;
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const now = options.now ?? Date.now;
  let workingMessages = [...options.initialMessages];
  let lastMode: LlmResponseBody["mode"] | null = null;
  const budgets = options.budgets;
  const encoder = budgets ? new TextEncoder() : null;
  const budgetState = budgets
    ? { readChars: 0, outputChars: 0, writeBytes: 0 }
    : null;

  if (options.promptText) {
    workingMessages = [
      ...workingMessages,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: options.promptText,
        createdAt: nowIso(),
      },
    ];
  }

  const startedAt = now();
  const toolCache = buildToolCache(workingMessages);

  for (let step = 0; step < MAX_RUN_STEPS; step += 1) {
    if (options.signal.aborted) {
      throw buildAbortError();
    }

    if (now() - startedAt > MAX_RUN_WALL_TIME_MS) {
      throw new Error("Run exceeded the 2 minute wall-time limit.");
    }

    const llmResponse = await options.requestLlm(
      workingMessages,
      options.runId,
      options.signal,
    );
    lastMode = llmResponse.mode;
    options.onModeChange?.(llmResponse.mode);

    const assistantMessage: AssistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: llmResponse.assistantText || "",
      toolCalls: llmResponse.toolCalls,
      createdAt: nowIso(),
    };

    workingMessages = [...workingMessages, assistantMessage];
    options.onAssistantMessage?.(assistantMessage, workingMessages);

    if (llmResponse.toolCalls.length === 0) {
      return { messages: workingMessages, lastMode };
    }

    for (const toolCall of llmResponse.toolCalls) {
      if (options.signal.aborted) {
        throw buildAbortError();
      }

      const cachedMessage = toolCache.get(toolCall.toolCallId);

      if (!cachedMessage && budgets && budgetState) {
        let estimatedWriteBytes: number | null = null;

        if (
          encoder &&
          toolCall.tool === "writeFile" &&
          "content" in toolCall.input
        ) {
          estimatedWriteBytes = encoder.encode(toolCall.input.content).byteLength;
        } else if (options.estimateToolCallWriteBytes) {
          estimatedWriteBytes = await options.estimateToolCallWriteBytes(toolCall);
        }

        if (
          estimatedWriteBytes !== null &&
          budgetState.writeBytes + estimatedWriteBytes > budgets.maxWriteBytes
        ) {
          const toolMessage = createBudgetError(
            toolCall,
            `Run write budget exceeded: ${budgetState.writeBytes + estimatedWriteBytes} bytes exceeds the ${budgets.maxWriteBytes} byte limit.`,
          );
          toolCache.set(toolCall.toolCallId, toolMessage);

          const hasToolMessage = workingMessages.some(
            (message) =>
              message.role === "tool" && message.toolCallId === toolCall.toolCallId,
          );

          if (!hasToolMessage) {
            workingMessages = [...workingMessages, toolMessage];
            options.onToolMessage?.(toolCall, toolMessage, workingMessages);
          }

          continue;
        }
      }

      const toolMessage = cachedMessage ?? (await options.executeToolCall(toolCall));
      toolCache.set(toolCall.toolCallId, toolMessage);

      const hasToolMessage = workingMessages.some(
        (message) =>
          message.role === "tool" && message.toolCallId === toolCall.toolCallId,
      );

      if (!hasToolMessage) {
        let nextToolMessage = toolMessage;

        if (budgets && budgetState && toolMessage.output && !toolMessage.error) {
          if ("content" in toolMessage.output) {
            const remaining = budgets.maxReadChars - budgetState.readChars;
            if (remaining <= 0) {
              nextToolMessage = createBudgetError(toolCall, "Run read budget exceeded.");
            } else {
              const truncated = truncateWithSuffix(
                toolMessage.output.content,
                remaining,
                "\n\n[run read budget truncated]",
              );
              budgetState.readChars += truncated.value.length;
              nextToolMessage = {
                ...toolMessage,
                output: {
                  ...toolMessage.output,
                  content: truncated.value,
                  truncated: toolMessage.output.truncated || truncated.truncated,
                },
              };
            }
          } else if ("paths" in toolMessage.output) {
            const remaining = budgets.maxReadChars - budgetState.readChars;
            if (remaining <= 0) {
              nextToolMessage = createBudgetError(toolCall, "Run read budget exceeded.");
            } else {
              const truncated = truncatePathList(toolMessage.output.paths, remaining);
              budgetState.readChars += truncated.paths.join("\n").length;
              nextToolMessage = {
                ...toolMessage,
                output: {
                  ...toolMessage.output,
                  paths: truncated.paths,
                  truncated: toolMessage.output.truncated || truncated.truncated,
                },
              };
            }
          } else if ("stdout" in toolMessage.output) {
            const remaining = budgets.maxOutputChars - budgetState.outputChars;
            if (remaining <= 0) {
              nextToolMessage = createBudgetError(toolCall, "Run output budget exceeded.");
            } else {
              const stdoutBudget = Math.min(toolMessage.output.stdout.length, remaining);
              const stdout = truncateWithSuffix(
                toolMessage.output.stdout,
                stdoutBudget,
                "\n\n[run output budget truncated]",
              );
              const remainingAfterStdout =
                remaining - stdout.value.length;
              const stderrBudget = Math.max(0, remainingAfterStdout);
              const stderr = truncateWithSuffix(
                toolMessage.output.stderr,
                stderrBudget,
                "\n\n[run output budget truncated]",
              );

              budgetState.outputChars += stdout.value.length + stderr.value.length;
              nextToolMessage = {
                ...toolMessage,
                output: {
                  ...toolMessage.output,
                  stdout: stdout.value,
                  stderr: stderr.value,
                },
              };
            }
          } else if ("bytesWritten" in toolMessage.output) {
            if (budgetState.writeBytes + toolMessage.output.bytesWritten > budgets.maxWriteBytes) {
              nextToolMessage = createBudgetError(toolCall, "Run write budget exceeded.");
            } else {
              budgetState.writeBytes += toolMessage.output.bytesWritten;
            }
          }
        }

        workingMessages = [...workingMessages, nextToolMessage];
        options.onToolMessage?.(toolCall, nextToolMessage, workingMessages);
      }
    }
  }

  throw new Error("Run reached the 20 step limit.");
}
