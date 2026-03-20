import type { FileChange } from "./justune-browser-sandbox";
import type {
  RuntimeConstraints,
  ToolCall,
  ToolMessage,
} from "./protocol";
import type {
  SandboxWorkerRequest,
  SandboxWorkerResponse,
} from "./justune-browser-sandbox-worker-protocol";

type SandboxWorkerRequestPayload = SandboxWorkerRequest extends infer T
  ? T extends { id: string }
    ? Omit<T, "id">
    : never
  : never;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export interface JustuneBrowserSandboxClientOptions {
  workerFactory?: () => Worker;
}

export class JustuneBrowserSandboxClient {
  private readonly worker: Worker;
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>();
  private readonly readyPromise: Promise<void>;
  private readonly requestTimeoutMs: number;
  private terminated = false;

  constructor(
    constraints: RuntimeConstraints,
    initialFiles: Record<string, string>,
    options: JustuneBrowserSandboxClientOptions = {},
  ) {
    this.requestTimeoutMs = constraints.timeoutMs;
    this.worker =
      options.workerFactory?.() ??
      new Worker(new URL("./justune-browser-sandbox.worker.ts", import.meta.url), {
        type: "module",
      });

    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);

    this.readyPromise = this.dispatchRequest<void>({
      type: "init",
      constraints,
      initialFiles,
    });
  }

  async executeToolCall(toolCall: ToolCall): Promise<ToolMessage> {
    await this.readyPromise;
    return this.dispatchRequest<ToolMessage>({
      type: "executeToolCall",
      toolCall,
    }, this.requestTimeoutMs);
  }

  async getChanges(): Promise<FileChange[]> {
    await this.readyPromise;
    return this.dispatchRequest<FileChange[]>({
      type: "getChanges",
    });
  }

  async getWorkspacePaths(): Promise<string[]> {
    await this.readyPromise;
    return this.dispatchRequest<string[]>({
      type: "getWorkspacePaths",
    });
  }

  async exportPatch(): Promise<string> {
    await this.readyPromise;
    return this.dispatchRequest<string>({
      type: "exportPatch",
    });
  }

  async exportChangeSetJson(): Promise<string> {
    await this.readyPromise;
    return this.dispatchRequest<string>({
      type: "exportChangeSetJson",
    });
  }

  async exportWorkspaceFiles(): Promise<Record<string, string>> {
    await this.readyPromise;
    return this.dispatchRequest<Record<string, string>>({
      type: "exportWorkspaceFiles",
    });
  }

  terminate(reason: string | Error = "Sandbox worker terminated.") {
    if (this.terminated) {
      return;
    }

    this.terminated = true;
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.terminate();
    const error = typeof reason === "string" ? new Error(reason) : reason;
    this.rejectPendingRequests(error);
  }

  private dispatchRequest<T>(
    request: SandboxWorkerRequestPayload,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.terminated) {
      return Promise.reject(new Error("Sandbox worker terminated."));
    }

    const id = crypto.randomUUID();
    const payload: SandboxWorkerRequest = { ...request, id };

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      this.worker.postMessage(payload);

      if (timeoutMs && timeoutMs > 0) {
        globalThis.setTimeout(() => {
          if (!this.pendingRequests.has(id)) {
            return;
          }

          const timeoutError = new Error(`Tool call timed out after ${timeoutMs}ms.`);
          timeoutError.name = "TimeoutError";
          this.terminate(timeoutError);
        }, timeoutMs);
      }
    });
  }

  private rejectPendingRequests(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private readonly handleMessage = (
    event: MessageEvent<SandboxWorkerResponse>,
  ) => {
    const response = event.data;
    const pending = this.pendingRequests.get(response.id);

    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.id);

    if (response.success) {
      pending.resolve(response.result);
      return;
    }

    const error = new Error(response.error.message);
    error.name = response.error.name ?? "Error";
    if (response.error.stack) {
      error.stack = response.error.stack;
    }
    pending.reject(error);
  };

  private readonly handleError = (event: ErrorEvent) => {
    const message = event.message || "Sandbox worker crashed.";
    this.terminate(message);
  };
}
