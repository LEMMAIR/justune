export interface RuntimeConstraints {
  workspaceRoot: string;
  maxOutputChars: number;
  maxReadChars: number;
  maxWriteBytes: number;
  timeoutMs: number;
}

export type ToolName =
  | "bash"
  | "readFile"
  | "writeFile"
  | "listWorkspacePaths"
  | "readFileRange"
  | "replaceInFile"
  | "applyPatch";

export interface BashToolInput {
  command: string;
}

export interface ReadFileToolInput {
  path: string;
}

export interface WriteFileToolInput {
  path: string;
  content: string;
}

export interface ListWorkspacePathsToolInput {
  directory?: string;
}

export interface ReadFileRangeToolInput {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ReplaceInFileToolInput {
  path: string;
  find: string;
  replace: string;
  replaceAll?: boolean;
}

export interface ApplyPatchToolInput {
  patch: string;
}

export type ToolInput =
  | BashToolInput
  | ReadFileToolInput
  | WriteFileToolInput
  | ListWorkspacePathsToolInput
  | ReadFileRangeToolInput
  | ReplaceInFileToolInput
  | ApplyPatchToolInput;

export interface ToolCall {
  toolCallId: string;
  tool: ToolName;
  input: ToolInput;
}

export interface ToolError {
  code: string;
  message: string;
}

export interface BashCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  truncated: boolean;
}

export interface WriteFileResult {
  path: string;
  success: true;
  bytesWritten: number;
}

export interface ListWorkspacePathsResult {
  directory: string;
  paths: string[];
  truncated: boolean;
}

export interface ReadFileRangeResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface ReplaceInFileResult {
  path: string;
  replacements: number;
  bytesWritten: number;
}

export interface ApplyPatchResult {
  filesApplied: number;
  patchedPaths: string[];
  bytesWritten: number;
}

export type ToolResult =
  | BashCommandResult
  | ReadFileResult
  | WriteFileResult
  | ListWorkspacePathsResult
  | ReadFileRangeResult
  | ReplaceInFileResult
  | ApplyPatchResult;

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  createdAt: string;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  text: string;
  toolCalls?: ToolCall[];
  createdAt: string;
}

export interface ToolMessage {
  id: string;
  role: "tool";
  tool: ToolName;
  toolCallId: string;
  output?: ToolResult;
  error?: ToolError;
  createdAt: string;
}

export type ConversationMessage = UserMessage | AssistantMessage | ToolMessage;

export interface LlmRequestBody {
  clientId: string;
  sessionId: string;
  sessionSecret: string;
  runId: string;
  messages: ConversationMessage[];
  constraints: RuntimeConstraints;
}

export interface LlmResponseBody {
  assistantText: string;
  toolCalls: ToolCall[];
  mode: "provider" | "demo";
}

export interface SessionResponse {
  clientId: string;
  sessionId: string;
  sessionSecret: string;
  csrfToken: string;
  providerReady: boolean;
  providerLabel: string;
  resumed: boolean;
}
