"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  DEFAULT_RUNTIME_CONSTRAINTS,
  DEFAULT_WORKSPACE_FILES,
  type FileChange,
  createInitialJustuneRuntimeState,
  JustuneRuntime,
  type JustuneRuntimeRunStatus,
  type JustuneRuntimeState,
} from "@lemmair/justune-runtime";
import { MAX_RUN_STEPS, MAX_RUN_WALL_TIME_MS } from "@lemmair/justune-runtime/agent-runner";
import {
  formatToolMessagePreview,
  summarizeTool,
} from "../lib/justune-browser-sandbox";
import type { ConversationMessage, LlmResponseBody } from "@lemmair/justune-runtime";
import {
  clearPersistedWorkbenchState,
  loadPersistedWorkbenchState,
  savePersistedWorkbenchState,
} from "../lib/workbench-persistence";

const STARTER_PROMPTS = [
  "Summarize the workspace and identify the files worth editing first.",
  "Open docs/launch-brief.md and turn it into a crisp release checklist.",
  "Create CHANGELOG.md with one concise entry for the browser runtime MVP.",
  "Compare README.md and docs/launch-brief.md, then suggest one product-copy improvement.",
];

function downloadText(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "pending";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "pending";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTimestampSsrSafe(value?: string) {
  if (!value) {
    return "pending";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "pending";
  }

  return date.toISOString().slice(11, 19);
}

function formatDuration(durationMs?: number) {
  if (durationMs === undefined) {
    return "running";
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function getModeBadge(providerReady: boolean, lastMode: LlmResponseBody["mode"] | null) {
  if (!providerReady || lastMode === "demo") {
    return { label: "Demo mode", className: "badge badge-warn" };
  }

  return { label: "Live provider", className: "badge badge-accent" };
}

function normalizeImportedWorkspacePath(path: string) {
  const parts = path.split("/");
  const normalized: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      normalized.pop();
      continue;
    }

    normalized.push(part);
  }

  const joined = normalized.join("/");
  const absolutePath = joined.startsWith("workspace/") ? `/${joined}` : `/workspace/${joined}`;

  if (absolutePath !== "/workspace" && !absolutePath.startsWith("/workspace/")) {
    throw new Error(`Imported path ${path} is outside /workspace.`);
  }

  return absolutePath;
}

function parseWorkspaceBundle(raw: string) {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Workspace import must be valid JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace import must be a JSON object of path-to-content entries.");
  }

  const workspaceFiles: Record<string, string> = {};

  for (const [path, contents] of Object.entries(value)) {
    if (typeof contents !== "string") {
      throw new Error(`Imported file ${path} must contain string content.`);
    }

    workspaceFiles[normalizeImportedWorkspacePath(path)] = contents;
  }

  if (Object.keys(workspaceFiles).length === 0) {
    throw new Error("Workspace import did not include any files.");
  }

  return workspaceFiles;
}

function isFileChange(value: unknown): value is FileChange {
  return value !== null && typeof value === "object" && "path" in value && "kind" in value;
}

function applyImportedChangeSet(
  currentWorkspaceFiles: Record<string, string>,
  changes: FileChange[],
) {
  const nextWorkspaceFiles = { ...currentWorkspaceFiles };

  for (const change of changes) {
    const path = normalizeImportedWorkspacePath(change.path);
    if (change.kind === "deleted") {
      delete nextWorkspaceFiles[path];
      continue;
    }

    nextWorkspaceFiles[path] = change.after ?? "";
  }

  if (Object.keys(nextWorkspaceFiles).length === 0) {
    throw new Error("Imported change set removed every workspace file.");
  }

  return nextWorkspaceFiles;
}

function isPatchImport(fileName: string, raw: string) {
  const lowerName = fileName.toLowerCase();
  return (
    lowerName.endsWith(".patch") ||
    lowerName.endsWith(".diff") ||
    raw.startsWith("--- ") ||
    raw.startsWith("diff --git")
  );
}

export function JustuneWorkbench() {
  const runtimeRef = useRef<JustuneRuntime | null>(null);
  const persistenceReadyRef = useRef(false);
  const lastPersistedStateRef = useRef<string | null>(null);
  const workspaceImportRef = useRef<HTMLInputElement | null>(null);

  const constraints = DEFAULT_RUNTIME_CONSTRAINTS;
  const [hydrated, setHydrated] = useState(false);
  const [prompt, setPrompt] = useState(STARTER_PROMPTS[0]);
  const [workspaceTransferNotice, setWorkspaceTransferNotice] = useState<string | null>(null);
  const [runtimeState, setRuntimeState] = useState<JustuneRuntimeState>(
    createInitialJustuneRuntimeState(DEFAULT_WORKSPACE_FILES),
  );
  const {
    session,
    messages,
    logs,
    changes,
    workspaceFiles,
    workspacePaths,
    queuedPrompts,
    resumePending,
    runStatus,
    error,
    lastMode,
    runCount,
  } = runtimeState;

  const modeBadge = getModeBadge(Boolean(session?.providerReady), lastMode);

  const metrics = useMemo(
    () => [
      { label: "Runs", value: String(runCount) },
      { label: "Tool calls", value: String(logs.length) },
      { label: "Changed files", value: String(changes.length) },
      { label: "Workspace files", value: String(workspacePaths.length) },
    ],
    [changes.length, logs.length, runCount, workspacePaths.length],
  );

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    const runtime = new JustuneRuntime({
      constraints,
      defaultWorkspaceFiles: DEFAULT_WORKSPACE_FILES,
    });
    runtimeRef.current = runtime;
    const unsubscribe = runtime.subscribe(setRuntimeState);
    let cancelled = false;

    async function boot() {
      const persisted = await loadPersistedWorkbenchState();
      if (cancelled) {
        return;
      }

      setPrompt(persisted?.prompt ?? STARTER_PROMPTS[0]);
      await runtime.boot({
        messages: Array.isArray(persisted?.messages)
          ? (persisted.messages as ConversationMessage[])
          : undefined,
        logs: persisted?.logs ?? [],
        changes: persisted?.changes ?? [],
        workspaceFiles: persisted?.workspaceFiles,
        workspacePaths: persisted?.workspacePaths ?? [],
        queuedPrompts: persisted?.queuedPrompts ?? [],
        resumePending: Boolean(persisted?.interruptedRun),
        runCount: persisted?.runCount ?? 0,
        lastMode: persisted?.lastMode ?? null,
        session: persisted?.session ?? null,
      });

      if (!cancelled) {
        persistenceReadyRef.current = true;
      }
    }

    void boot();

    return () => {
      cancelled = true;
      unsubscribe();
      runtime.dispose();
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
    };
  }, [constraints]);

  useEffect(() => {
    if (!persistenceReadyRef.current) {
      return;
    }

    const snapshot = {
      version: 1,
      prompt,
      messages,
      logs,
      changes,
      workspaceFiles,
      workspacePaths,
      runCount,
      lastMode,
      queuedPrompts,
      interruptedRun: runStatus === "running" || resumePending,
          session: session
            ? {
                clientId: session.clientId,
                sessionId: session.sessionId,
                sessionSecret: session.sessionSecret,
                csrfToken: session.csrfToken,
              }
            : null,
    } satisfies Parameters<typeof savePersistedWorkbenchState>[0];
    const serializedSnapshot = JSON.stringify(snapshot);

    if (serializedSnapshot === lastPersistedStateRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      lastPersistedStateRef.current = serializedSnapshot;
      void savePersistedWorkbenchState(snapshot);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    changes,
    lastMode,
    logs,
    messages,
    prompt,
    queuedPrompts,
    resumePending,
    runCount,
    runStatus,
    session,
    workspaceFiles,
    workspacePaths,
  ]);

  async function resetWorkspace() {
    setPrompt(STARTER_PROMPTS[0]);
    setWorkspaceTransferNotice(null);
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    await clearPersistedWorkbenchState();
    await runtime.reset({ workspaceFiles: DEFAULT_WORKSPACE_FILES });
  }

  function queuePrompt() {
    const nextPrompt = prompt.trim();
    if (!nextPrompt) {
      return;
    }

    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    if (runStatus === "running") {
      setPrompt("");
    }

    void runtime.submitPrompt(nextPrompt);
  }

  function stopRun() {
    runtimeRef.current?.stop();
  }

  async function exportPatch() {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    const patch = await runtime.exportPatch();
    downloadText("justune.patch", patch || "# No file changes recorded.\n");
  }

  async function exportChangesJson() {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    const json = await runtime.exportChangeSetJson();
    downloadText("justune-changes.json", json);
  }

  async function exportWorkspaceJson() {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    const files = await runtime.exportWorkspaceFiles();
    downloadText("justune-workspace.json", `${JSON.stringify(files, null, 2)}\n`);
    setWorkspaceTransferNotice(`Exported ${Object.keys(files).length} workspace files.`);
  }

  function exportRunLog() {
    const jsonl = runtimeRef.current?.exportRunLog() ?? "";
    downloadText("justune-run-log.jsonl", jsonl || "");
  }

  function resumeRun() {
    void runtimeRef.current?.resume();
  }

  function startWorkspaceImport() {
    workspaceImportRef.current?.click();
  }

  async function importWorkspace(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    try {
      const raw = await file.text();

      if (isPatchImport(file.name, raw)) {
        await clearPersistedWorkbenchState();
        setPrompt("Summarize the patched workspace and identify the files worth editing first.");
        setWorkspaceTransferNotice(`Imported patch from ${file.name}.`);
        await runtime.importWorkspacePatch(
          raw,
          "Imported a workspace patch. The browser sandbox is ready to inspect and edit the updated files.",
        );
        return;
      }

      let workspaceFiles: Record<string, string>;
      let notice: string;
      let promptText: string;
      let introMessageText: string;

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        throw new Error("Workspace import must be a JSON workspace snapshot, change set, or unified diff patch.");
      }

      if (Array.isArray(parsedJson) && parsedJson.every(isFileChange)) {
        workspaceFiles = applyImportedChangeSet(runtimeState.workspaceFiles, parsedJson);
        notice = `Imported change set with ${parsedJson.length} file operations from ${file.name}.`;
        promptText = "Summarize the imported change set result and identify the files worth editing first.";
        introMessageText =
          "Imported a workspace change set. The browser sandbox is ready to inspect and edit the updated files.";
      } else {
        workspaceFiles = parseWorkspaceBundle(raw);
        notice = `Imported ${Object.keys(workspaceFiles).length} files from ${file.name}.`;
        promptText = "Summarize the imported workspace and identify the files worth editing first.";
        introMessageText = `Imported ${Object.keys(workspaceFiles).length} workspace files. The browser sandbox is ready to inspect and edit them.`;
      }

      await clearPersistedWorkbenchState();
      setPrompt(promptText);
      setWorkspaceTransferNotice(notice);
      await runtime.reset({
        workspaceFiles,
        introMessageText,
      });
    } catch (error) {
      setWorkspaceTransferNotice(
        error instanceof Error ? error.message : "Workspace import failed.",
      );
    }
  }

  return (
    <main className="shell">
      <div className="frame">
        <input
          accept="application/json,.json,.patch,.diff,text/x-diff,text/x-patch,text/plain"
          hidden
          onChange={(event) => void importWorkspace(event)}
          ref={workspaceImportRef}
          type="file"
        />
        <section className="hero">
          <div className="hero-grid">
            <div className="split">
              <span className="eyebrow">Browser-local agent runtime</span>
              <h1>justune</h1>
              <p>
                A tight, observable MVP for client-scheduled tool calling. The
                server only brokers LLM turns; every `bash`,
                `listWorkspacePaths`, `readFile`, `readFileRange`,
                `replaceInFile`, `applyPatch`, and `writeFile` action runs inside an
                in-browser `just-bash` workspace.
              </p>
            </div>
            <div className="split">
              <div className="badge-row">
                <span className={modeBadge.className}>
                  <span className={session?.providerReady ? "status-dot" : "status-dot warn"} />
                  <strong>{modeBadge.label}</strong>
                </span>
                <span className="badge">
                  <strong>{session?.providerLabel ?? "Starting…"}</strong>
                </span>
                <span className="badge">
                  <strong>{runStatus}</strong>
                </span>
                {queuedPrompts.length > 0 ? (
                  <span className="badge">
                    queue <strong>{queuedPrompts.length}</strong>
                  </span>
                ) : null}
                {session?.resumed ? (
                  <span className="badge">
                    <strong>session restored</strong>
                  </span>
                ) : null}
              </div>
              <div className="metric-row">
                <span className="badge">
                  root <strong>{constraints.workspaceRoot}</strong>
                </span>
                <span className="badge">
                  timeout <strong>{constraints.timeoutMs}ms</strong>
                </span>
                <span className="badge">
                  steps <strong>{MAX_RUN_STEPS}</strong>
                </span>
                <span className="badge">
                  wall time <strong>{MAX_RUN_WALL_TIME_MS / 1000}s</strong>
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="dashboard">
          <article className="panel">
            <div className="panel-header">
              <div>
                <h2>Conversation</h2>
                <p>Runs until the model returns a final answer or the run limits trip.</p>
              </div>
              <div className="badge-row">
                <span className="badge">
                  session <strong>{session ? session.sessionId.slice(0, 12) : "…"}</strong>
                </span>
              </div>
            </div>
            <div className="stack">
              <div className="chat-list">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`message ${
                      message.role === "user"
                        ? "message-user"
                        : message.role === "tool"
                          ? "message-tool"
                          : ""
                    }`}
                  >
                    <div className="message-head">
                      <span>{message.role}</span>
                      <span>{hydrated ? formatTimestamp(message.createdAt) : formatTimestampSsrSafe(message.createdAt)}</span>
                    </div>
                    <div className="message-body">
                      {message.role === "tool"
                        ? formatToolMessagePreview(message)
                        : message.text || "Waiting on tool execution…"}
                    </div>
                    {message.role === "assistant" && message.toolCalls?.length ? (
                      <div className="tool-pill">
                        {message.toolCalls.map((toolCall) => toolCall.tool).join(" → ")}
                      </div>
                    ) : null}
                    {message.role === "tool" ? (
                      <div className="tool-pill">{summarizeTool(message.tool, message)}</div>
                    ) : null}
                  </div>
                ))}
              </div>

              <div className="composer">
                <div className="chips">
                  {STARTER_PROMPTS.map((starter) => (
                    <button
                      key={starter}
                      className="chip"
                      onClick={() => setPrompt(starter)}
                      type="button"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
                <textarea
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Ask justune to inspect, edit, or summarize the in-browser workspace…"
                  value={prompt}
                />
                <div className="actions">
                  <div className="button-row">
                    <button
                      className="btn btn-primary"
                      disabled={runStatus === "booting" || runStatus === "running" || !session || !prompt.trim()}
                      onClick={() => void runtimeRef.current?.submitPrompt(prompt.trim())}
                      type="button"
                    >
                      Run agent
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={runStatus === "booting" || !session || !prompt.trim()}
                      onClick={queuePrompt}
                      type="button"
                    >
                      {runStatus === "running" ? "Queue run" : "Run or queue"}
                    </button>
                    <button
                      className="btn btn-danger"
                      disabled={runStatus !== "running"}
                      onClick={stopRun}
                      type="button"
                    >
                      Stop
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={(!resumePending && queuedPrompts.length === 0) || !session}
                      onClick={resumeRun}
                      type="button"
                    >
                      {resumePending ? "Resume" : "Run queue"}
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={runStatus === "running"}
                      onClick={() => void resetWorkspace()}
                      type="button"
                    >
                      Reset workspace
                    </button>
                  </div>
                  {error ? <span className="badge badge-warn">{error}</span> : null}
                  {workspaceTransferNotice ? (
                    <span className="badge">{workspaceTransferNotice}</span>
                  ) : null}
                </div>
              </div>

              {queuedPrompts.length > 0 ? (
                <div className="file-list">
                  {queuedPrompts.map((queuedPrompt, index) => (
                    <div className="file-card" key={`${queuedPrompt}-${index}`}>
                      <div className="file-head">
                        <strong>queued</strong>
                        <span className="meta">run {index + 1}</span>
                      </div>
                      <div className="preview">{queuedPrompt}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </article>

          <aside className="panel">
            <div className="panel-header">
              <div>
                <h3>Tool log</h3>
                <p>Full local execution audit with timings, inputs, and previews.</p>
              </div>
              <div className="button-row">
                <button
                  className="btn btn-ghost"
                  disabled={logs.length === 0 && messages.length === 0}
                  onClick={exportRunLog}
                  type="button"
                >
                  Export JSONL
                </button>
              </div>
            </div>
            <div className="stack">
              <div className="metric-grid">
                {metrics.map((metric) => (
                  <div className="metric-card" key={metric.label}>
                    <strong>{metric.value}</strong>
                    <span>{metric.label}</span>
                  </div>
                ))}
              </div>

              <div className="log-list">
                {logs.length === 0 ? (
                  <div className="empty">
                    No tool calls yet. Start a run to watch the browser sandbox
                    execute commands and file operations in sequence.
                  </div>
                ) : (
                  logs.map((log) => (
                    <div className="log-card" key={log.id}>
                      <div className="log-head">
                        <strong>{log.tool}</strong>
                        <span className="meta">
                          {hydrated ? formatTimestamp(log.startedAt) : formatTimestampSsrSafe(log.startedAt)} · {formatDuration(log.durationMs)}
                        </span>
                      </div>
                      <div className="code">{JSON.stringify(log.input, null, 2)}</div>
                      {log.resultPreview ? (
                        <>
                          <div className="meta" style={{ marginTop: 12, marginBottom: 8 }}>
                            {log.status}
                          </div>
                          <div className="preview">{log.resultPreview}</div>
                        </>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>

          <aside className="panel">
            <div className="panel-header">
              <div>
                <h3>Workspace</h3>
                <p>Changed files are computed from the initial in-browser snapshot.</p>
              </div>
              <div className="button-row">
                <button
                  className="btn btn-ghost"
                  disabled={runStatus === "running"}
                  onClick={startWorkspaceImport}
                  type="button"
                >
                  Import JSON
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={runStatus === "running"}
                  onClick={() => void exportWorkspaceJson()}
                  type="button"
                >
                  Export workspace
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={changes.length === 0}
                  onClick={() => void exportPatch()}
                  type="button"
                >
                  Export patch
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={changes.length === 0}
                  onClick={() => void exportChangesJson()}
                  type="button"
                >
                  Export JSON
                </button>
              </div>
            </div>
            <div className="stack">
              <div className="file-list">
                {changes.length === 0 ? (
                  <div className="empty">
                    No file mutations yet. The starter workspace is loaded and
                    ready for local reads, searches, and writes.
                  </div>
                ) : (
                  changes.map((change) => (
                    <div className="file-card" key={change.path}>
                      <div className="file-head">
                        <strong>{change.kind}</strong>
                        <span className="meta">{change.path}</span>
                      </div>
                      <div className="preview">{change.after ?? ""}</div>
                    </div>
                  ))
                )}
              </div>

              <div className="file-list">
                {workspacePaths.slice(0, 8).map((path) => (
                  <div className="file-card" key={path}>
                    <div className="file-head">
                      <strong>workspace</strong>
                      <span className="meta">{path}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="footer-note">
                Safety is enforced through path scoping, read/write size caps,
                command deny-lists, per-call timeouts, persisted run logs, and
                recoverable browser state. You can import and export workspace
                snapshots as JSON, but the demo never writes back to the host
                filesystem.
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
