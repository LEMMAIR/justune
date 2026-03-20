/// <reference lib="webworker" />

import { JustuneBrowserSandbox } from "./justune-browser-sandbox";
import type {
  SandboxWorkerErrorPayload,
  SandboxWorkerRequest,
  SandboxWorkerResponse,
} from "./justune-browser-sandbox-worker-protocol";

let sandbox: JustuneBrowserSandbox | null = null;

function serializeError(error: unknown): SandboxWorkerErrorPayload {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: typeof error === "string" ? error : "Unknown worker error.",
  };
}

function getSandbox() {
  if (!sandbox) {
    throw new Error("Sandbox worker is not initialized.");
  }

  return sandbox;
}

async function handleRequest(request: SandboxWorkerRequest) {
  switch (request.type) {
    case "init":
      sandbox = new JustuneBrowserSandbox(request.constraints, request.initialFiles);
      return null;
    case "executeToolCall":
      return getSandbox().executeToolCall(request.toolCall);
    case "getChanges":
      return getSandbox().getChanges();
    case "getWorkspacePaths":
      return getSandbox().getWorkspacePaths();
    case "exportPatch":
      return getSandbox().exportPatch();
    case "exportChangeSetJson":
      return getSandbox().exportChangeSetJson();
    case "exportWorkspaceFiles":
      return getSandbox().exportWorkspaceFiles();
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

self.addEventListener("message", (event: MessageEvent<SandboxWorkerRequest>) => {
  const request = event.data;

  void handleRequest(request)
    .then((result) => {
      const response: SandboxWorkerResponse = {
        id: request.id,
        success: true,
        result,
      };
      self.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: SandboxWorkerResponse = {
        id: request.id,
        success: false,
        error: serializeError(error),
      };
      self.postMessage(response);
    });
});

export {};
