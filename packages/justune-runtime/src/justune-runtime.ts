import { runAgentLoop } from "./agent-runner";
import { getOrCreateClientId } from "./client-identity";
import {
  DEFAULT_RUNTIME_CONSTRAINTS,
  DEFAULT_WORKSPACE_FILES,
} from "./default-workspace";
import {
  estimateToolCallWriteBytes,
  formatToolMessagePreview,
  type FileChange,
} from "./justune-browser-sandbox";
import { JustuneBrowserSandboxClient } from "./justune-browser-sandbox-client";
import type {
  ConversationMessage,
  LlmRequestBody,
  LlmResponseBody,
  RuntimeConstraints,
  SessionResponse,
  ToolCall,
  ToolInput,
  ToolName,
  ToolMessage,
} from "./protocol";

export type JustuneRuntimeRunStatus = "booting" | "idle" | "running" | "error";

export interface JustuneRuntimeToolLogEntry {
  id: string;
  tool: ToolName;
  toolCallId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  input: ToolInput;
  resultPreview?: string;
  status: "running" | "completed" | "failed";
}

export interface JustuneRuntimeSessionCredentials {
  clientId: string;
  sessionId: string;
  sessionSecret: string;
  csrfToken: string;
}

export interface JustuneRuntimeState {
  session: SessionResponse | null;
  messages: ConversationMessage[];
  logs: JustuneRuntimeToolLogEntry[];
  changes: FileChange[];
  workspaceFiles: Record<string, string>;
  workspacePaths: string[];
  queuedPrompts: string[];
  resumePending: boolean;
  runStatus: JustuneRuntimeRunStatus;
  error: string | null;
  lastMode: LlmResponseBody["mode"] | null;
  runCount: number;
}

export interface JustuneRuntimeBootstrapState {
  messages?: ConversationMessage[];
  logs?: JustuneRuntimeToolLogEntry[];
  changes?: FileChange[];
  workspaceFiles?: Record<string, string>;
  workspacePaths?: string[];
  queuedPrompts?: string[];
  resumePending?: boolean;
  runCount?: number;
  lastMode?: LlmResponseBody["mode"] | null;
  session?: JustuneRuntimeSessionCredentials | null;
  introMessageText?: string;
}

export interface JustuneRuntimeSandbox {
  executeToolCall(toolCall: ToolCall): Promise<ToolMessage>;
  getChanges(): Promise<FileChange[]>;
  getWorkspacePaths(): Promise<string[]>;
  exportPatch(): Promise<string>;
  exportChangeSetJson(): Promise<string>;
  exportWorkspaceFiles(): Promise<Record<string, string>>;
  terminate(reason?: string | Error): void;
}

export interface JustuneRuntimeOptions {
  constraints?: RuntimeConstraints;
  defaultWorkspaceFiles?: Record<string, string>;
  createSandbox?: (
    constraints: RuntimeConstraints,
    initialFiles: Record<string, string>,
  ) => JustuneRuntimeSandbox;
  getClientId?: () => string;
  createSession?: (
    clientId: string,
    existingSession: JustuneRuntimeSessionCredentials | null,
  ) => Promise<SessionResponse>;
  requestLlm?: (
    body: LlmRequestBody,
    signal: AbortSignal,
    csrfToken?: string,
  ) => Promise<LlmResponseBody>;
}

type StateListener = (state: JustuneRuntimeState) => void;

const INTRO_MESSAGE_ID = "intro_message";
const INTRO_MESSAGE_CREATED_AT = "";

function nowIso() {
  return new Date().toISOString();
}

export function createIntroMessage(text?: string): ConversationMessage {
  return {
    id: INTRO_MESSAGE_ID,
    role: "assistant",
    text:
      text ??
      "Browser sandbox ready. Ask me to inspect, edit, or summarize the in-memory workspace and I’ll route precise path, range, patch, and file-edit tool calls locally.",
    createdAt: INTRO_MESSAGE_CREATED_AT,
  };
}

export function createInitialMessages(text?: string) {
  return [createIntroMessage(text)];
}

export function createInitialJustuneRuntimeState(
  workspaceFiles: Record<string, string> = DEFAULT_WORKSPACE_FILES,
  text?: string,
): JustuneRuntimeState {
  return {
    session: null,
    messages: createInitialMessages(text),
    logs: [],
    changes: [],
    workspaceFiles,
    workspacePaths: [],
    queuedPrompts: [],
    resumePending: false,
    runStatus: "booting",
    error: null,
    lastMode: null,
    runCount: 0,
  };
}

export function buildRunLogJsonl(
  messages: ConversationMessage[],
  logs: JustuneRuntimeToolLogEntry[],
  changes: FileChange[],
) {
  const records = [
    ...messages.map((message) => ({ type: "message", message })),
    ...logs.map((log) => ({ type: "tool_log", log })),
    ...changes.map((change) => ({ type: "file_change", change })),
  ];

  return records.map((record) => JSON.stringify(record)).join("\n");
}

async function defaultCreateSession(
  clientId: string,
  existingSession: JustuneRuntimeSessionCredentials | null,
) {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId,
      sessionId: existingSession?.sessionId,
      sessionSecret: existingSession?.sessionSecret,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Session bootstrap failed with ${response.status}.`);
  }

  return (await response.json()) as SessionResponse;
}

async function defaultRequestLlm(
  body: LlmRequestBody,
  signal: AbortSignal,
  csrfToken?: string,
) {
  const response = await fetch("/api/justune/llm", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-Justune-CSRF": csrfToken } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "LLM request failed.");
  }

  return (await response.json()) as LlmResponseBody;
}

export class JustuneRuntime {
  private readonly constraints: RuntimeConstraints;
  private readonly defaultWorkspaceFiles: Record<string, string>;
  private readonly createSandbox: JustuneRuntimeOptions["createSandbox"];
  private readonly getClientId: () => string;
  private readonly createSessionImpl: NonNullable<JustuneRuntimeOptions["createSession"]>;
  private readonly requestLlmImpl: NonNullable<JustuneRuntimeOptions["requestLlm"]>;
  private readonly listeners = new Set<StateListener>();

  private state: JustuneRuntimeState;
  private sandbox: JustuneRuntimeSandbox | null = null;
  private abortController: AbortController | null = null;
  private clientId: string | null = null;

  constructor(options: JustuneRuntimeOptions = {}) {
    this.constraints = options.constraints ?? DEFAULT_RUNTIME_CONSTRAINTS;
    this.defaultWorkspaceFiles = options.defaultWorkspaceFiles ?? DEFAULT_WORKSPACE_FILES;
    this.createSandbox =
      options.createSandbox ??
      ((constraints, initialFiles) =>
        new JustuneBrowserSandboxClient(constraints, initialFiles));
    this.getClientId = options.getClientId ?? getOrCreateClientId;
    this.createSessionImpl = options.createSession ?? defaultCreateSession;
    this.requestLlmImpl = options.requestLlm ?? defaultRequestLlm;
    this.state = createInitialJustuneRuntimeState(this.defaultWorkspaceFiles);
  }

  getState() {
    return this.state;
  }

  subscribe(listener: StateListener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async boot(bootstrap: JustuneRuntimeBootstrapState = {}) {
    const restoredMessages = Array.isArray(bootstrap.messages)
      ? bootstrap.messages
      : createInitialMessages(bootstrap.introMessageText);
    const restoredWorkspaceFiles =
      bootstrap.workspaceFiles && Object.keys(bootstrap.workspaceFiles).length > 0
        ? bootstrap.workspaceFiles
        : this.defaultWorkspaceFiles;

    this.clientId = bootstrap.session?.clientId ?? this.getClientId();

    this.setState({
      session: null,
      messages: restoredMessages,
      logs: bootstrap.logs ?? [],
      changes: bootstrap.changes ?? [],
      workspaceFiles: restoredWorkspaceFiles,
      workspacePaths: bootstrap.workspacePaths ?? [],
      queuedPrompts: bootstrap.queuedPrompts ?? [],
      resumePending: Boolean(bootstrap.resumePending),
      runStatus: "booting",
      error: bootstrap.resumePending
        ? "Recovered the previous workspace. Resume when ready."
        : null,
      lastMode: bootstrap.lastMode ?? null,
      runCount: bootstrap.runCount ?? 0,
    });

    const results = await Promise.allSettled([
      this.bootSandbox(restoredWorkspaceFiles),
      this.bootSession(bootstrap.session ?? null),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) =>
        result.reason instanceof Error ? result.reason.message : "Failed to boot justune.",
      );

    if (failures.length === 0) {
      this.updateState((current) => ({
        ...current,
        runStatus: "idle",
      }));
      return;
    }

    this.updateState((current) => ({
      ...current,
      error: failures.join(" "),
      runStatus: "error",
    }));
  }

  async reset(options?: {
    workspaceFiles?: Record<string, string>;
    introMessageText?: string;
  }) {
    const nextWorkspaceFiles = options?.workspaceFiles ?? this.defaultWorkspaceFiles;
    this.abortController?.abort();
    this.abortController = null;

    this.setState({
      session: null,
      messages: createInitialMessages(
        options?.introMessageText ??
          "Workspace reset. The browser sandbox is fresh again and ready for another run.",
      ),
      logs: [],
      changes: [],
      workspaceFiles: nextWorkspaceFiles,
      workspacePaths: [],
      queuedPrompts: [],
      resumePending: false,
      runStatus: "booting",
      error: null,
      lastMode: null,
      runCount: 0,
    });

    try {
      await this.bootSandbox(nextWorkspaceFiles);
      await this.bootSession(null);
      this.updateState((current) => ({
        ...current,
        runStatus: "idle",
      }));
    } catch (error) {
      this.updateState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Failed to reset justune.",
        runStatus: "error",
      }));
    }
  }

  async submitPrompt(promptText: string) {
    const nextPrompt = promptText.trim();
    if (!nextPrompt) {
      return;
    }

    if (this.state.runStatus === "running") {
      this.updateState((current) => ({
        ...current,
        queuedPrompts: [...current.queuedPrompts, nextPrompt],
      }));
      return;
    }

    await this.drainRuns({ promptText: nextPrompt });
  }

  async resume() {
    await this.drainRuns({ continueInterrupted: this.state.resumePending });
  }

  stop() {
    this.abortController?.abort();
    void this.bootSandbox(this.state.workspaceFiles).catch((bootError) => {
      this.updateState((current) => ({
        ...current,
        error:
          bootError instanceof Error
            ? bootError.message
            : "Failed to restart the sandbox worker.",
        runStatus: "error",
      }));
    });
  }

  async exportPatch() {
    if (!this.sandbox) {
      return "";
    }

    return this.sandbox.exportPatch();
  }

  async exportChangeSetJson() {
    if (!this.sandbox) {
      return "[]";
    }

    return this.sandbox.exportChangeSetJson();
  }

  async exportWorkspaceFiles() {
    if (!this.sandbox) {
      return { ...this.state.workspaceFiles };
    }

    return this.sandbox.exportWorkspaceFiles();
  }

  async importWorkspacePatch(patch: string, introMessageText?: string) {
    const sandbox = this.sandbox;
    if (!sandbox) {
      throw new Error("Sandbox is unavailable.");
    }

    const toolMessage = await sandbox.executeToolCall({
      toolCallId: crypto.randomUUID(),
      tool: "applyPatch",
      input: { patch },
    });

    if (toolMessage.error) {
      throw new Error(toolMessage.error.message);
    }

    const workspaceFiles = await sandbox.exportWorkspaceFiles();
    await this.reset({
      workspaceFiles,
      introMessageText:
        introMessageText ??
        "Imported a workspace patch. The browser sandbox is ready to inspect the updated files.",
    });
  }

  exportRunLog() {
    return buildRunLogJsonl(this.state.messages, this.state.logs, this.state.changes);
  }

  dispose() {
    this.abortController?.abort();
    this.abortController = null;
    this.sandbox?.terminate("Runtime disposed.");
    this.sandbox = null;
  }

  private emit() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private setState(state: JustuneRuntimeState) {
    this.state = state;
    this.emit();
  }

  private updateState(updater: (state: JustuneRuntimeState) => JustuneRuntimeState) {
    this.state = updater(this.state);
    this.emit();
  }

  private async refreshWorkspaceState(sandbox = this.sandbox) {
    if (!sandbox) {
      return;
    }

    const [nextChanges, nextPaths, nextFiles] = await Promise.all([
      sandbox.getChanges(),
      sandbox.getWorkspacePaths(),
      sandbox.exportWorkspaceFiles(),
    ]);

    if (this.sandbox !== sandbox) {
      return;
    }

    this.updateState((current) => ({
      ...current,
      changes: nextChanges,
      workspacePaths: nextPaths,
      workspaceFiles: nextFiles,
    }));
  }

  private async bootSandbox(initialFiles: Record<string, string>) {
    this.sandbox?.terminate("Sandbox worker replaced.");
    try {
      const sandbox = this.createSandbox?.(this.constraints, initialFiles);
      if (!sandbox) {
        throw new Error("Sandbox factory is unavailable.");
      }
      this.sandbox = sandbox;

      await this.refreshWorkspaceState(sandbox);
    } catch (error) {
      if (this.sandbox) {
        this.sandbox.terminate("Sandbox worker boot failed.");
        this.sandbox = null;
      }
      throw new Error(
        `Sandbox boot failed: ${error instanceof Error ? error.message : "unknown error."}`,
      );
    }
  }

  private async bootSession(existingSession: JustuneRuntimeSessionCredentials | null) {
    if (!this.clientId) {
      throw new Error("Client identity is unavailable.");
    }

    try {
      const session = await this.createSessionImpl(this.clientId, existingSession);
      this.updateState((current) => ({
        ...current,
        session,
      }));
      return session;
    } catch (error) {
      throw new Error(
        `Session bootstrap failed: ${error instanceof Error ? error.message : "unknown error."}`,
      );
    }
  }

  private async requestLlm(
    messagesForRun: ConversationMessage[],
    runId: string,
    signal: AbortSignal,
  ) {
    const session = this.state.session;
    if (!session || !this.clientId) {
      throw new Error("Session is not ready yet.");
    }

    return this.requestLlmImpl(
      {
        clientId: this.clientId,
        sessionId: session.sessionId,
        sessionSecret: session.sessionSecret,
        runId,
        messages: messagesForRun,
        constraints: this.constraints,
      },
      signal,
      session.csrfToken,
    );
  }

  private async executeToolCall(toolCall: ToolCall) {
    const sandbox = this.sandbox;
    if (!sandbox) {
      throw new Error("Sandbox is unavailable.");
    }

    const workspaceSnapshot = { ...this.state.workspaceFiles };
    const startedAt = Date.now();
    const logEntry: JustuneRuntimeToolLogEntry = {
      id: crypto.randomUUID(),
      tool: toolCall.tool,
      toolCallId: toolCall.toolCallId,
      startedAt: new Date(startedAt).toISOString(),
      input: toolCall.input,
      status: "running",
    };

    this.updateState((current) => ({
      ...current,
      logs: [logEntry, ...current.logs],
    }));

    try {
      const toolMessage = await sandbox.executeToolCall(toolCall);
      const finishedAt = Date.now();

      this.updateState((current) => ({
        ...current,
        logs: current.logs.map((entry) =>
          entry.id === logEntry.id
            ? {
                ...entry,
                status: toolMessage.error ? "failed" : "completed",
                finishedAt: new Date(finishedAt).toISOString(),
                durationMs: finishedAt - startedAt,
                resultPreview: formatToolMessagePreview(toolMessage),
              }
            : entry,
        ),
      }));

      await this.refreshWorkspaceState(sandbox);
      return toolMessage;
    } catch (error) {
      const finishedAt = Date.now();
      const message =
        error instanceof Error ? error.message : "Tool execution interrupted.";
      const isTimeout = error instanceof Error && error.name === "TimeoutError";

      this.updateState((current) => ({
        ...current,
        logs: current.logs.map((entry) =>
          entry.id === logEntry.id
            ? {
                ...entry,
                status: "failed",
                finishedAt: new Date(finishedAt).toISOString(),
                durationMs: finishedAt - startedAt,
                resultPreview: message,
              }
            : entry,
        ),
      }));

      if (isTimeout) {
        try {
          await this.bootSandbox(workspaceSnapshot);
        } catch {
          // Preserve the timeout tool error even if reboot fails.
        }
      }

      return {
        id: crypto.randomUUID(),
        role: "tool" as const,
        tool: toolCall.tool,
        toolCallId: toolCall.toolCallId,
        error: {
          code: isTimeout ? "TOOL_TIMEOUT" : "EXECUTION_ERROR",
          message,
        },
        createdAt: nowIso(),
      };
    }
  }

  private async estimateWriteBytes(toolCall: ToolCall) {
    try {
      return estimateToolCallWriteBytes(
        toolCall,
        this.state.workspaceFiles,
        this.constraints.workspaceRoot,
      );
    } catch {
      return null;
    }
  }

  private async drainRuns(options?: {
    promptText?: string;
    continueInterrupted?: boolean;
  }) {
    if (this.state.runStatus === "running") {
      return;
    }

    if (!this.state.session || !this.sandbox) {
      this.updateState((current) => ({
        ...current,
        error: "Session is not ready yet.",
      }));
      return;
    }

    this.updateState((current) => ({
      ...current,
      error: null,
      runStatus: "running",
    }));

    const controller = new AbortController();
    this.abortController = controller;

    let currentMessages = [...this.state.messages];
    const pendingQueue = [...this.state.queuedPrompts];
    let nextPrompt = options?.promptText;
    let continueInterrupted = options?.continueInterrupted ?? false;

    try {
      while (continueInterrupted || nextPrompt || pendingQueue.length > 0) {
        const promptForRun = continueInterrupted
          ? undefined
          : (nextPrompt ?? pendingQueue.shift());

        this.updateState((current) => ({
          ...current,
          queuedPrompts: [...pendingQueue],
          runCount: current.runCount + 1,
        }));

        const result = await runAgentLoop({
          initialMessages: currentMessages,
          promptText: promptForRun,
          requestLlm: (messages, runId, signal) => this.requestLlm(messages, runId, signal),
          executeToolCall: (toolCall) => this.executeToolCall(toolCall),
          estimateToolCallWriteBytes: (toolCall) => this.estimateWriteBytes(toolCall),
          signal: controller.signal,
          runId: `run_${crypto.randomUUID()}`,
          budgets: {
            maxReadChars: this.constraints.maxReadChars * 3,
            maxOutputChars: this.constraints.maxOutputChars * 6,
            maxWriteBytes: this.constraints.maxWriteBytes * 10,
          },
          onModeChange: (mode) => {
            this.updateState((current) => ({
              ...current,
              lastMode: mode,
            }));
          },
          onAssistantMessage: (_assistantMessage, nextMessages) => {
            currentMessages = nextMessages;
            this.updateState((current) => ({
              ...current,
              messages: nextMessages,
            }));
          },
          onToolMessage: (_toolCall, _toolMessage, nextMessages) => {
            currentMessages = nextMessages;
            this.updateState((current) => ({
              ...current,
              messages: nextMessages,
            }));
          },
        });

        currentMessages = result.messages;
        this.updateState((current) => ({
          ...current,
          messages: result.messages,
          lastMode: result.lastMode,
          resumePending: false,
        }));
        continueInterrupted = false;
        nextPrompt = undefined;
      }

      this.updateState((current) => ({
        ...current,
        runStatus: "idle",
      }));
    } catch (runError) {
      if (controller.signal.aborted) {
        this.updateState((current) => ({
          ...current,
          error: "Run stopped.",
          resumePending: true,
          runStatus: "idle",
        }));
        if (this.abortController === controller) {
          this.abortController = null;
        }
        return;
      }

      this.updateState((current) => ({
        ...current,
        error: runError instanceof Error ? runError.message : "Run failed.",
        resumePending: true,
        runStatus: "error",
      }));
      if (this.abortController === controller) {
        this.abortController = null;
      }
      return;
    }

    if (this.abortController === controller) {
      this.abortController = null;
    }
  }
}
