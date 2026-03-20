import type { FileChange } from "./justune-browser-sandbox";
import type {
  RuntimeConstraints,
  ToolCall,
  ToolMessage,
} from "./protocol";

export type SandboxWorkerRequest =
  | {
      id: string;
      type: "init";
      constraints: RuntimeConstraints;
      initialFiles: Record<string, string>;
    }
  | {
      id: string;
      type: "executeToolCall";
      toolCall: ToolCall;
    }
  | {
      id: string;
      type: "getChanges";
    }
  | {
      id: string;
      type: "getWorkspacePaths";
    }
  | {
      id: string;
      type: "exportPatch";
    }
  | {
      id: string;
      type: "exportChangeSetJson";
    }
  | {
      id: string;
      type: "exportWorkspaceFiles";
    };

export interface SandboxWorkerErrorPayload {
  message: string;
  name?: string;
  stack?: string;
}

export type SandboxWorkerResponse =
  | {
      id: string;
      success: true;
      result:
        | null
        | string
        | string[]
        | Record<string, string>
        | FileChange[]
        | ToolMessage;
    }
  | {
      id: string;
      success: false;
      error: SandboxWorkerErrorPayload;
    };
