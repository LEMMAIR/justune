import { afterEach, describe, expect, it, vi } from "vitest";
import { JustuneRuntime, type JustuneRuntimeSandbox } from "@/lib/justune-runtime";
import type { LlmResponseBody, ToolCall, ToolMessage } from "@/lib/protocol";
import { getDefaultRuntimeConstraints } from "@/lib/runtime-constraints";

class FakeSandbox implements JustuneRuntimeSandbox {
  private readonly files: Record<string, string>;
  private changes: Array<{
    path: string;
    kind: "created" | "modified" | "deleted";
    before?: string;
    after?: string;
  }> = [];

  constructor(initialFiles: Record<string, string>) {
    this.files = { ...initialFiles };
  }

  async executeToolCall(toolCall: ToolCall): Promise<ToolMessage> {
    if (toolCall.tool === "writeFile" && "path" in toolCall.input && "content" in toolCall.input) {
      const path = toolCall.input.path.startsWith("/")
        ? toolCall.input.path
        : `/workspace/${toolCall.input.path.replace(/^\.\//, "")}`;
      this.files[path] = toolCall.input.content;
      this.changes = [
        {
          path,
          kind: "created",
          after: toolCall.input.content,
        },
      ];

      return {
        id: crypto.randomUUID(),
        role: "tool",
        tool: "writeFile",
        toolCallId: toolCall.toolCallId,
        output: {
          path,
          success: true,
          bytesWritten: new TextEncoder().encode(toolCall.input.content).byteLength,
        },
        createdAt: new Date().toISOString(),
      };
    }

    throw new Error(`Unexpected tool in runtime test: ${toolCall.tool}`);
  }

  async getChanges() {
    return this.changes;
  }

  async getWorkspacePaths() {
    return Object.keys(this.files).sort();
  }

  async exportPatch() {
    return "mock patch";
  }

  async exportChangeSetJson() {
    return JSON.stringify(this.changes, null, 2);
  }

  async exportWorkspaceFiles() {
    return { ...this.files };
  }

  terminate() {}
}

async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for condition.");
}

describe("JustuneRuntime", () => {
  let runtime: JustuneRuntime | null = null;

  afterEach(() => {
    runtime?.dispose();
    runtime = null;
  });

  it("boots a headless runtime and executes a prompt", async () => {
    const sandboxes: FakeSandbox[] = [];
    const llmResponses: LlmResponseBody[] = [
      {
        assistantText: "Writing a file.",
        toolCalls: [
          {
            toolCallId: "tc_write",
            tool: "writeFile",
            input: {
              path: "result.txt",
              content: "hello from runtime",
            },
          },
        ],
        mode: "demo",
      },
      {
        assistantText: "Done.",
        toolCalls: [],
        mode: "demo",
      },
    ];
    const requestLlm = vi.fn(async () => llmResponses.shift() ?? llmResponses[0]);

    runtime = new JustuneRuntime({
      constraints: getDefaultRuntimeConstraints(),
      createSandbox: (_constraints, initialFiles) => {
        const sandbox = new FakeSandbox(initialFiles);
        sandboxes.push(sandbox);
        return sandbox;
      },
      createSession: vi.fn(async (clientId) => ({
        clientId,
        sessionId: "session_test",
        sessionSecret: "secret_test",
        csrfToken: "csrf_test",
        providerReady: false,
        providerLabel: "Demo mode",
        resumed: false,
      })),
      requestLlm,
    });

    await runtime.boot();
    await runtime.submitPrompt("make a file");

    expect(requestLlm).toHaveBeenCalledTimes(2);
    expect(runtime.getState().runStatus).toBe("idle");
    expect(runtime.getState().workspaceFiles["/workspace/result.txt"]).toBe("hello from runtime");
    expect(runtime.exportRunLog()).toContain("/workspace/result.txt");
    expect(sandboxes).toHaveLength(1);
  });

  it("queues follow-up prompts and resumes after stop", async () => {
    const sandboxes: FakeSandbox[] = [];
    let llmResponseIndex = 0;
    const requestLlm = vi.fn(async (_body, signal: AbortSignal) => {
      if (llmResponseIndex === 0) {
        llmResponseIndex += 1;
        return await new Promise<LlmResponseBody>((_, reject) => {
          if (signal.aborted) {
            reject(new DOMException("Run stopped.", "AbortError"));
            return;
          }

          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Run stopped.", "AbortError")),
            { once: true },
          );
        });
      }

      if (llmResponseIndex === 1) {
        llmResponseIndex += 1;
        return {
          assistantText: "Writing queued changes.",
          toolCalls: [
            {
              toolCallId: "tc_queue_write",
              tool: "writeFile" as const,
              input: {
                path: "queue.txt",
                content: "hello from queue",
              },
            },
          ],
          mode: "demo" as const,
        } satisfies LlmResponseBody;
      }

      llmResponseIndex += 1;
      return {
        assistantText: "Queued run complete.",
        toolCalls: [],
        mode: "demo" as const,
      } satisfies LlmResponseBody;
    });

    runtime = new JustuneRuntime({
      constraints: getDefaultRuntimeConstraints(),
      createSandbox: (_constraints, initialFiles) => {
        const sandbox = new FakeSandbox(initialFiles);
        sandboxes.push(sandbox);
        return sandbox;
      },
      createSession: vi.fn(async (clientId) => ({
        clientId,
        sessionId: "session_test",
        sessionSecret: "secret_test",
        csrfToken: "csrf_test",
        providerReady: false,
        providerLabel: "Demo mode",
        resumed: false,
      })),
      requestLlm,
    });

    await runtime.boot();

    const firstRun = runtime.submitPrompt("first run");
    await waitFor(() => runtime?.getState().runStatus === "running");

    await runtime.submitPrompt("queued follow-up");
    expect(runtime.getState().queuedPrompts).toEqual(["queued follow-up"]);

    runtime.stop();
    await firstRun;
    await waitFor(() => runtime?.getState().resumePending === true);
    await waitFor(() => sandboxes.length >= 2);

    await runtime.resume();

    await waitFor(
      () =>
        runtime?.getState().runStatus === "idle" &&
        runtime?.getState().workspaceFiles["/workspace/queue.txt"] === "hello from queue",
    );

    expect(runtime.getState().queuedPrompts).toEqual([]);
    expect(runtime.getState().resumePending).toBe(false);
    expect(sandboxes.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces session bootstrap failures with subsystem context", async () => {
    runtime = new JustuneRuntime({
      constraints: getDefaultRuntimeConstraints(),
      createSandbox: (_constraints, initialFiles) => new FakeSandbox(initialFiles),
      createSession: vi.fn(async () => {
        throw new Error("Origin validation failed.");
      }),
      requestLlm: vi.fn(),
    });

    await runtime.boot();

    expect(runtime.getState().runStatus).toBe("error");
    expect(runtime.getState().error).toBe(
      "Session bootstrap failed: Origin validation failed.",
    );
  });
});
