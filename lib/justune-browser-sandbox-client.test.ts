import { describe, expect, it, vi } from "vitest";
import { JustuneBrowserSandboxClient } from "@/lib/justune-browser-sandbox-client";
import type {
  SandboxWorkerRequest,
  SandboxWorkerResponse,
} from "@/lib/justune-browser-sandbox-worker-protocol";
import { getDefaultRuntimeConstraints } from "@/lib/runtime-constraints";

class MockWorker extends EventTarget {
  public readonly requests: SandboxWorkerRequest[] = [];
  public terminated = false;

  postMessage(message: SandboxWorkerRequest) {
    this.requests.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  respond(response: SandboxWorkerResponse) {
    this.dispatchEvent(new MessageEvent("message", { data: response }));
  }
}

describe("JustuneBrowserSandboxClient", () => {
  it("rejects in-flight requests when terminated", async () => {
    const worker = new MockWorker();
    const client = new JustuneBrowserSandboxClient(
      getDefaultRuntimeConstraints(),
      {},
      {
        workerFactory: () => worker as unknown as Worker,
      },
    );

    const initRequest = worker.requests[0];
    worker.respond({
      id: initRequest.id,
      success: true,
      result: null,
    });

    const pendingResult = client.executeToolCall({
      toolCallId: "tc_sleep",
      tool: "bash",
      input: { command: "sleep 5" },
    });

    await Promise.resolve();

    client.terminate("Sandbox worker terminated.");

    await expect(pendingResult).rejects.toThrow("Sandbox worker terminated.");
    expect(worker.terminated).toBe(true);
  });

  it("forwards successful responses after initialization", async () => {
    const worker = new MockWorker();
    const client = new JustuneBrowserSandboxClient(
      getDefaultRuntimeConstraints(),
      {},
      {
        workerFactory: () => worker as unknown as Worker,
      },
    );

    const initRequest = worker.requests[0];
    worker.respond({
      id: initRequest.id,
      success: true,
      result: null,
    });

    const resultPromise = client.executeToolCall({
      toolCallId: "tc_pwd",
      tool: "bash",
      input: { command: "pwd" },
    });

    await Promise.resolve();

    const request = worker.requests.at(-1);
    if (!request || request.type !== "executeToolCall") {
      throw new Error("Expected executeToolCall request.");
    }

    worker.respond({
      id: request.id,
      success: true,
      result: {
        id: "tool_message",
        role: "tool",
        tool: "bash",
        toolCallId: "tc_pwd",
        output: {
          stdout: "/workspace\n",
          stderr: "",
          exitCode: 0,
        },
        createdAt: new Date().toISOString(),
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      toolCallId: "tc_pwd",
      output: {
        exitCode: 0,
      },
    });
  });

  it("terminates the worker when a request times out", async () => {
    vi.useFakeTimers();

    const worker = new MockWorker();
    const client = new JustuneBrowserSandboxClient(
      { ...getDefaultRuntimeConstraints(), timeoutMs: 5 },
      {},
      {
        workerFactory: () => worker as unknown as Worker,
      },
    );

    const initRequest = worker.requests[0];
    worker.respond({
      id: initRequest.id,
      success: true,
      result: null,
    });

    const pendingResult = client.executeToolCall({
      toolCallId: "tc_timeout",
      tool: "bash",
      input: { command: "sleep 5" },
    });

    await Promise.resolve();
    vi.advanceTimersByTime(5);
    await Promise.resolve();

    await expect(pendingResult).rejects.toThrow("Tool call timed out after 5ms.");
    expect(worker.terminated).toBe(true);

    vi.useRealTimers();
  });
});
