// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChange } from "@/lib/justune-browser-sandbox";
import type { LlmResponseBody, ToolCall, ToolMessage } from "@justune/runtime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const testState = vi.hoisted(() => ({
  persistence: {
    loadPersistedWorkbenchState: vi.fn(async () => null),
    savePersistedWorkbenchState: vi.fn(async () => {}),
    clearPersistedWorkbenchState: vi.fn(async () => {}),
  },
  sandboxInstances: [] as Array<{
    executeToolCall(toolCall: ToolCall): Promise<ToolMessage>;
    getChanges(): Promise<FileChange[]>;
    getWorkspacePaths(): Promise<string[]>;
    exportWorkspaceFiles(): Promise<Record<string, string>>;
    exportPatch(): Promise<string>;
    exportChangeSetJson(): Promise<string>;
    terminate(): void;
  }>,
}));

vi.mock("@justune/runtime/client-identity", () => ({
  getOrCreateClientId: () => "client_test",
}));

vi.mock("@/lib/workbench-persistence", () => testState.persistence);

vi.mock("@justune/runtime/justune-browser-sandbox-client", () => {
  class MockSandboxClient {
    private files: Record<string, string>;
    private changes: FileChange[] = [];

    constructor(_constraints: unknown, initialFiles: Record<string, string>) {
      this.files = { ...initialFiles };
      testState.sandboxInstances.push(this);
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

      throw new Error(`Unexpected tool in integration test: ${toolCall.tool}`);
    }

    async getChanges() {
      return this.changes;
    }

    async getWorkspacePaths() {
      return Object.keys(this.files).sort();
    }

    async exportWorkspaceFiles() {
      return { ...this.files };
    }

    async exportPatch() {
      return "mock patch";
    }

    async exportChangeSetJson() {
      return JSON.stringify(this.changes, null, 2);
    }

    terminate() {}
  }

  return {
    JustuneBrowserSandboxClient: MockSandboxClient,
  };
});

import { JustuneWorkbench } from "@/components/justune-workbench";

function createJsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await act(async () => {
      await Promise.resolve();
    });

    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for condition.");
}

function getButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === label,
  );

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  return button as HTMLButtonElement;
}

function click(element: HTMLElement) {
  element.click();
}

function setFileInputFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: files,
  });
}

function setTextareaValue(container: HTMLElement, value: string) {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("Textarea not found.");
  }

  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  );
  descriptor?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("JustuneWorkbench browser flows", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let llmResponseIndex: number;
  let createObjectUrlMock: ReturnType<typeof vi.fn>;
  let revokeObjectUrlMock: ReturnType<typeof vi.fn>;
  let anchorClickMock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testState.sandboxInstances.length = 0;
    llmResponseIndex = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    createObjectUrlMock = vi.fn(() => "blob:mock");
    revokeObjectUrlMock = vi.fn();
    anchorClickMock = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(globalThis.URL, {
      createObjectURL: createObjectUrlMock,
      revokeObjectURL: revokeObjectUrlMock,
    });

    const llmResponses: LlmResponseBody[] = [
      {
        assistantText: "Recovered after stop.",
        toolCalls: [],
        mode: "demo",
      },
      {
        assistantText: "Writing queued changes.",
        toolCalls: [
          {
            toolCallId: "tc_queue_write",
            tool: "writeFile",
            input: {
              path: "queue.txt",
              content: "hello from queue",
            },
          },
        ],
        mode: "demo",
      },
      {
        assistantText: "Queued run complete.",
        toolCalls: [],
        mode: "demo",
      },
    ];

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/api/session")) {
        return createJsonResponse({
          clientId: "client_test",
          sessionId: "session_test",
          sessionSecret: "secret_test",
          csrfToken: "csrf_test",
          providerReady: false,
          providerLabel: "Demo mode",
          resumed: false,
        });
      }

      if (url.endsWith("/api/justune/llm")) {
        if (llmResponseIndex === 0) {
          llmResponseIndex += 1;
          return await new Promise((_, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("Expected abort signal."));
              return;
            }

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

        const response = llmResponses[llmResponseIndex - 1];
        llmResponseIndex += 1;
        return createJsonResponse(response);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<JustuneWorkbench />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });

    container.remove();
    anchorClickMock.mockRestore();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("queues, resumes, and exports after a stopped run", async () => {
    await waitFor(() => !getButton(container, "Run agent").disabled);

    await act(async () => {
      setTextareaValue(container, "first run");
    });
    await act(async () => {
      click(getButton(container, "Run agent"));
    });

    await waitFor(() => getButton(container, "Stop").disabled === false);

    await act(async () => {
      setTextareaValue(container, "queued follow-up");
    });
    await act(async () => {
      click(getButton(container, "Queue run"));
    });

    await waitFor(() => container.textContent?.includes("queued follow-up") ?? false);

    await act(async () => {
      click(getButton(container, "Stop"));
    });

    await waitFor(() => container.textContent?.includes("Run stopped.") ?? false);
    await waitFor(() => getButton(container, "Resume").disabled === false);

    await act(async () => {
      click(getButton(container, "Resume"));
    });

    await waitFor(() => getButton(container, "Run queue").disabled === true);
    await waitFor(() => container.textContent?.includes("/workspace/queue.txt") ?? false);

    const exportJsonl = getButton(container, "Export JSONL");
    const exportWorkspace = getButton(container, "Export workspace");
    const exportPatch = getButton(container, "Export patch");
    const exportJson = getButton(container, "Export JSON");

    expect(exportPatch.disabled).toBe(false);
    expect(exportJson.disabled).toBe(false);

    await act(async () => {
      click(exportJsonl);
      click(exportWorkspace);
      click(exportPatch);
      click(exportJson);
    });

    expect(createObjectUrlMock).toHaveBeenCalledTimes(4);
    expect(anchorClickMock).toHaveBeenCalledTimes(4);

    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      const importedJson = JSON.stringify({ "/workspace/imported.md": "# imported workspace\n" });
      const file = new File(
        [importedJson],
        "workspace.json",
        { type: "application/json" },
      );
      Object.defineProperty(file, "text", {
        configurable: true,
        value: async () => importedJson,
      });
      setFileInputFiles(fileInput as HTMLInputElement, [file]);
      fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("/workspace/imported.md") ?? false);
    expect(
      container.textContent?.includes("Imported 1 files from workspace.json.") ?? false,
    ).toBe(true);

    await act(async () => {
      const changeSetJson = JSON.stringify([
        {
          path: "/workspace/from-change-set.md",
          kind: "created",
          after: "# change set import\n",
        },
      ]);
      const file = new File([changeSetJson], "changes.json", { type: "application/json" });
      Object.defineProperty(file, "text", {
        configurable: true,
        value: async () => changeSetJson,
      });
      setFileInputFiles(fileInput as HTMLInputElement, [file]);
      fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => container.textContent?.includes("/workspace/from-change-set.md") ?? false);
    expect(
      container.textContent?.includes("Imported change set with 1 file operations from changes.json.") ?? false,
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(testState.sandboxInstances.length).toBeGreaterThanOrEqual(2);
  });
});
