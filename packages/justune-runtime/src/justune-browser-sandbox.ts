import {
  applyPatch as applyUnifiedPatch,
  createPatch,
  parsePatch,
  type StructuredPatch,
} from "diff";
import { Bash, InMemoryFs, type IFileSystem } from "just-bash/browser";
import {
  type ApplyPatchResult,
  type BashCommandResult,
  type ListWorkspacePathsResult,
  type ReadFileResult,
  type ReadFileRangeResult,
  type ReplaceInFileResult,
  type RuntimeConstraints,
  type ToolCall,
  type ToolError,
  type ToolMessage,
  type ToolName,
  type ToolResult,
  type WriteFileResult,
} from "./protocol";

type Snapshot = Map<string, string>;

export interface FileChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  before?: string;
  after?: string;
}

const SENSITIVE_FILE_PATTERNS = [
  /\.env(\..+)?$/i,
  /\.npmrc$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /\.p12$/i,
  /\.kdbx$/i,
];

const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+-rf/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{/,
];

function normalizePath(path: string) {
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

  return `/${normalized.join("/")}`;
}

function dirname(path: string) {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  parts.pop();
  const joined = parts.join("/");
  return joined || "/";
}

function ensureWithinWorkspace(workspaceRoot: string, path: string) {
  const normalized = normalizePath(path.startsWith("/") ? path : `${workspaceRoot}/${path}`);
  if (normalized !== workspaceRoot && !normalized.startsWith(`${workspaceRoot}/`)) {
    throw policyError("PATH_DENIED", `Path ${normalized} is outside ${workspaceRoot}.`);
  }
  return normalized;
}

function truncateText(value: string, maxLength: number, label: string) {
  if (value.length <= maxLength) {
    return { value, truncated: false };
  }

  const removed = value.length - maxLength;
  return {
    value: `${value.slice(0, maxLength)}\n\n[${label} truncated: ${removed} characters removed]`,
    truncated: true,
  };
}

function policyError(code: string, message: string): ToolError {
  return { code, message };
}

function byteLengthOfText(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function isPositiveInteger(value: number) {
  return Number.isInteger(value) && value > 0;
}

function decodeText(value: string | Uint8Array) {
  const decoded = typeof value === "string" ? value : new TextDecoder().decode(value);
  if (!/^\d+(,\d+)*$/.test(decoded)) {
    return decoded;
  }

  const bytes = decoded.split(",").map((part) => Number(part));
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return decoded;
  }

  const candidate = new TextDecoder().decode(Uint8Array.from(bytes));
  const printableChars = Array.from(candidate).filter((char) => {
    const code = char.charCodeAt(0);
    return char === "\n" || char === "\r" || char === "\t" || (code >= 32 && code <= 126);
  }).length;

  return printableChars / Math.max(candidate.length, 1) >= 0.85 ? candidate : decoded;
}

function isSensitiveBasename(name: string) {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function stripDiffPrefix(path: string) {
  if (path === "/dev/null") {
    return path;
  }

  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }

  return path;
}

function resolvePatchedPathForWorkspace(workspaceRoot: string, patch: StructuredPatch) {
  const oldPath = stripDiffPrefix(patch.oldFileName);
  const newPath = stripDiffPrefix(patch.newFileName);
  const candidate = newPath !== "/dev/null" ? newPath : oldPath;

  if (!candidate || candidate === "/dev/null") {
    throw policyError("INVALID_INPUT", "Patch must target a workspace file.");
  }

  return ensureWithinWorkspace(workspaceRoot, candidate);
}

function previewReplaceInFile(
  workspaceFiles: Record<string, string>,
  workspaceRoot: string,
  path: string,
  find: string,
  replace: string,
  replaceAll = false,
) {
  if (!find) {
    throw policyError("INVALID_INPUT", "find must be a non-empty string.");
  }

  const resolvedPath = ensureWithinWorkspace(workspaceRoot, path);
  const current = workspaceFiles[resolvedPath];
  if (current === undefined) {
    throw policyError("FILE_NOT_FOUND", `Path ${resolvedPath} does not exist.`);
  }

  const replacements = replaceAll
    ? current.split(find).length - 1
    : current.includes(find)
      ? 1
      : 0;
  const nextContent = replacements === 0
    ? current
    : replaceAll
      ? current.split(find).join(replace)
      : current.replace(find, replace);

  return {
    path: resolvedPath,
    replacements,
    nextContent,
    bytesWritten: replacements === 0 ? 0 : byteLengthOfText(nextContent),
  };
}

function previewApplyPatch(
  workspaceFiles: Record<string, string>,
  workspaceRoot: string,
  patchText: string,
) {
  if (!patchText.trim()) {
    throw policyError("INVALID_INPUT", "Patch cannot be empty.");
  }

  let patches: StructuredPatch[];
  try {
    patches = parsePatch(patchText);
  } catch {
    throw policyError("INVALID_INPUT", "Patch must be valid unified diff text.");
  }

  if (patches.length === 0) {
    throw policyError("INVALID_INPUT", "Patch must include at least one file diff.");
  }

  const originalContents = new Map<string, string>();
  for (const patch of patches) {
    if (patch.hunks.length === 0) {
      throw policyError("INVALID_INPUT", "Patch must include at least one hunk per file.");
    }

    const resolvedPath = resolvePatchedPathForWorkspace(workspaceRoot, patch);
    if (originalContents.has(resolvedPath)) {
      throw policyError(
        "INVALID_INPUT",
        `Patch includes multiple entries for ${resolvedPath}; combine hunks into one file diff.`,
      );
    }

    if (stripDiffPrefix(patch.oldFileName) === "/dev/null") {
      originalContents.set(resolvedPath, "");
      continue;
    }

    const existing = workspaceFiles[resolvedPath];
    if (existing === undefined) {
      throw policyError("FILE_NOT_FOUND", `Path ${resolvedPath} does not exist.`);
    }

    originalContents.set(resolvedPath, existing);
  }

  const pendingWrites = new Map<string, string | null>();
  let bytesWritten = 0;

  for (const patch of patches) {
    const resolvedPath = resolvePatchedPathForWorkspace(workspaceRoot, patch);
    const current = pendingWrites.has(resolvedPath)
      ? pendingWrites.get(resolvedPath)
      : originalContents.get(resolvedPath);
    const nextContent = applyUnifiedPatch(current ?? "", patch, {
      autoConvertLineEndings: true,
    });

    if (nextContent === false) {
      throw policyError("PATCH_CONFLICT", `Patch could not be applied to ${resolvedPath}.`);
    }

    if (stripDiffPrefix(patch.newFileName) === "/dev/null") {
      pendingWrites.set(resolvedPath, null);
      continue;
    }

    pendingWrites.set(resolvedPath, nextContent);
    bytesWritten += byteLengthOfText(nextContent);
  }

  return {
    filesApplied: pendingWrites.size,
    patchedPaths: Array.from(pendingWrites.keys()).sort(),
    bytesWritten,
  };
}

export function estimateToolCallWriteBytes(
  toolCall: ToolCall,
  workspaceFiles: Record<string, string>,
  workspaceRoot: string,
) {
  switch (toolCall.tool) {
    case "writeFile":
      if ("content" in toolCall.input) {
        return byteLengthOfText(toolCall.input.content);
      }
      return null;
    case "replaceInFile":
      if ("path" in toolCall.input && "find" in toolCall.input && "replace" in toolCall.input) {
        return previewReplaceInFile(
          workspaceFiles,
          workspaceRoot,
          toolCall.input.path,
          toolCall.input.find,
          toolCall.input.replace,
          Boolean(toolCall.input.replaceAll),
        ).bytesWritten;
      }
      return null;
    case "applyPatch":
      if ("patch" in toolCall.input) {
        return previewApplyPatch(workspaceFiles, workspaceRoot, toolCall.input.patch).bytesWritten;
      }
      return null;
    default:
      return null;
  }
}

class PolicyFileSystem implements IFileSystem {
  private violation: ToolError | null = null;
  private lockedDown = false;

  constructor(
    private readonly base: IFileSystem,
    private readonly workspaceRoot: string,
  ) {}

  lockdown() {
    this.lockedDown = true;
  }

  resetViolation() {
    this.violation = null;
  }

  consumeViolation() {
    const violation = this.violation;
    this.violation = null;
    return violation;
  }

  private recordViolation(error: ToolError) {
    if (!this.violation) {
      this.violation = error;
    }
  }

  private resolveWorkspacePath(path: string) {
    return this.base.resolvePath(this.workspaceRoot, path);
  }

  private async assertSymlinksStayInWorkspace(resolvedPath: string) {
    if (!this.lockedDown) {
      return;
    }

    const normalized = normalizePath(resolvedPath);
    if (normalized === this.workspaceRoot || !normalized.startsWith(`${this.workspaceRoot}/`)) {
      return;
    }

    const parts = normalized.split("/").filter(Boolean);
    let current = "";

    for (let index = 0; index < parts.length - 1; index += 1) {
      current = `${current}/${parts[index]}`;

      let stat: Awaited<ReturnType<IFileSystem["lstat"]>>;
      try {
        stat = await this.base.lstat(current);
      } catch {
        continue;
      }

      if (!stat.isSymbolicLink) {
        continue;
      }

      let realPath: string;
      try {
        realPath = await this.base.realpath(current);
      } catch {
        continue;
      }

      try {
        ensureWithinWorkspace(this.workspaceRoot, realPath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && "message" in error) {
          this.recordViolation(error as ToolError);
        }
        throw new Error("Symlink escape denied by policy.");
      }
    }
  }

  private async resolveRealPath(path: string) {
    const resolved = this.resolveWorkspacePath(path);
    try {
      return await this.base.realpath(resolved);
    } catch {
      return resolved;
    }
  }

  private async assertAllowedRead(path: string) {
    const resolved = this.resolveWorkspacePath(path);

    if (this.lockedDown) {
      try {
        ensureWithinWorkspace(this.workspaceRoot, resolved);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && "message" in error) {
          this.recordViolation(error as ToolError);
        }
        throw new Error("Path denied by policy.");
      }
    }

    const realPath = await this.resolveRealPath(resolved);
    const basename = realPath.split("/").at(-1) ?? "";
    if (isSensitiveBasename(basename)) {
      this.recordViolation(
        policyError("POLICY_DENIED", `Reading ${realPath} is blocked by policy.`),
      );
      throw new Error("Read denied by policy.");
    }

    if (this.lockedDown) {
      try {
        ensureWithinWorkspace(this.workspaceRoot, realPath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && "message" in error) {
          this.recordViolation(error as ToolError);
        }
        throw new Error("Path denied by policy.");
      }
    }
  }

  private assertAllowedWrite(path: string) {
    if (!this.lockedDown) {
      return;
    }

    const resolved = this.resolveWorkspacePath(path);

    try {
      ensureWithinWorkspace(this.workspaceRoot, resolved);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && "message" in error) {
        this.recordViolation(error as ToolError);
      }
      throw new Error("Path denied by policy.");
    }
  }

  private async assertAllowedCopyOrMove(src: string, dest: string) {
    const resolvedSrc = this.resolveWorkspacePath(src);
    const resolvedDest = this.resolveWorkspacePath(dest);

    if (this.lockedDown) {
      try {
        ensureWithinWorkspace(this.workspaceRoot, resolvedDest);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && "message" in error) {
          this.recordViolation(error as ToolError);
        }
        throw new Error("Path denied by policy.");
      }

      await this.assertSymlinksStayInWorkspace(resolvedDest);
    }

    const realSrc = await this.resolveRealPath(resolvedSrc);
    const basename = realSrc.split("/").at(-1) ?? "";
    if (isSensitiveBasename(basename)) {
      this.recordViolation(
        policyError("POLICY_DENIED", `Reading ${realSrc} is blocked by policy.`),
      );
      throw new Error("Copy denied by policy.");
    }

    if (this.lockedDown) {
      try {
        ensureWithinWorkspace(this.workspaceRoot, realSrc);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && "message" in error) {
          this.recordViolation(error as ToolError);
        }
        throw new Error("Path denied by policy.");
      }
    }
  }

  readFile(...args: Parameters<IFileSystem["readFile"]>) {
    const [path] = args;
    return this.assertAllowedRead(path).then(() => this.base.readFile(...args));
  }

  readFileBuffer(...args: Parameters<IFileSystem["readFileBuffer"]>) {
    const [path] = args;
    return this.assertAllowedRead(path).then(() => this.base.readFileBuffer(...args));
  }

  writeFile(...args: Parameters<IFileSystem["writeFile"]>) {
    const [path] = args;
    this.assertAllowedWrite(path);
    const resolved = this.resolveWorkspacePath(path);
    return this.assertSymlinksStayInWorkspace(resolved).then(() =>
      this.base.writeFile(...args),
    );
  }

  appendFile(...args: Parameters<IFileSystem["appendFile"]>) {
    const [path] = args;
    this.assertAllowedWrite(path);
    const resolved = this.resolveWorkspacePath(path);
    return this.assertSymlinksStayInWorkspace(resolved).then(() =>
      this.base.appendFile(...args),
    );
  }

  async exists(...args: Parameters<IFileSystem["exists"]>) {
    const [path] = args;
    const resolved = this.resolveWorkspacePath(path);
    const basename = resolved.split("/").at(-1) ?? "";
    if (isSensitiveBasename(basename)) {
      this.recordViolation(
        policyError("POLICY_DENIED", `Reading ${resolved} is blocked by policy.`),
      );
      return false;
    }
    return this.base.exists(...args);
  }

  async stat(...args: Parameters<IFileSystem["stat"]>) {
    const [path] = args;
    const resolved = this.resolveWorkspacePath(path);
    const basename = resolved.split("/").at(-1) ?? "";
    if (isSensitiveBasename(basename)) {
      this.recordViolation(
        policyError("POLICY_DENIED", `Reading ${resolved} is blocked by policy.`),
      );
      throw new Error("No such file or directory.");
    }
    return this.base.stat(...args);
  }

  mkdir(...args: Parameters<IFileSystem["mkdir"]>) {
    const [path] = args;
    this.assertAllowedWrite(path);
    const resolved = this.resolveWorkspacePath(path);
    return this.assertSymlinksStayInWorkspace(resolved).then(() =>
      this.base.mkdir(...args),
    );
  }

  async readdir(...args: Parameters<IFileSystem["readdir"]>) {
    const [path] = args;
    const resolved = this.resolveWorkspacePath(path);
    const entries = await this.base.readdir(...args);

    if (resolved !== this.workspaceRoot && !resolved.startsWith(`${this.workspaceRoot}/`)) {
      return entries;
    }

    return entries.filter((entry) => !isSensitiveBasename(entry));
  }

  rm(...args: Parameters<IFileSystem["rm"]>) {
    const [path] = args;
    this.assertAllowedWrite(path);
    const resolved = this.resolveWorkspacePath(path);
    return this.assertSymlinksStayInWorkspace(resolved).then(() =>
      this.base.rm(...args),
    );
  }

  cp(...args: Parameters<IFileSystem["cp"]>) {
    const [src, dest] = args;
    return this.assertAllowedCopyOrMove(src, dest).then(() => this.base.cp(...args));
  }

  mv(...args: Parameters<IFileSystem["mv"]>) {
    const [src, dest] = args;
    return this.assertAllowedCopyOrMove(src, dest).then(() => this.base.mv(...args));
  }

  resolvePath(...args: Parameters<IFileSystem["resolvePath"]>) {
    const base = args[0] as string;
    const path = (args as unknown as [string, string | undefined])[1];
    if (path === undefined) {
      return this.base.resolvePath(this.workspaceRoot, base);
    }
    return this.base.resolvePath(base, path);
  }

  getAllPaths() {
    const paths = this.base.getAllPaths();
    return paths.filter((path) => {
      if (path === this.workspaceRoot || path.startsWith(`${this.workspaceRoot}/`)) {
        const basename = path.split("/").at(-1) ?? "";
        return !isSensitiveBasename(basename);
      }
      return true;
    });
  }

  chmod(...args: Parameters<IFileSystem["chmod"]>) {
    const [path] = args;
    this.assertAllowedWrite(path);
    const resolved = this.resolveWorkspacePath(path);
    return this.assertSymlinksStayInWorkspace(resolved).then(() =>
      this.base.chmod(...args),
    );
  }

  symlink(...args: Parameters<IFileSystem["symlink"]>) {
    const linkPath = args[1];
    this.assertAllowedWrite(linkPath);
    const resolved = this.resolveWorkspacePath(linkPath);
    return this.assertSymlinksStayInWorkspace(resolved).then(() =>
      this.base.symlink(...args),
    );
  }

  link(...args: Parameters<IFileSystem["link"]>) {
    const [existingPath, newPath] = args;
    return this.assertAllowedCopyOrMove(existingPath, newPath).then(() => this.base.link(...args));
  }

  readlink(...args: Parameters<IFileSystem["readlink"]>) {
    return this.base.readlink(...args);
  }

  async lstat(...args: Parameters<IFileSystem["lstat"]>) {
    const [path] = args;
    const resolved = this.resolveWorkspacePath(path);
    const basename = resolved.split("/").at(-1) ?? "";
    if (isSensitiveBasename(basename)) {
      this.recordViolation(
        policyError("POLICY_DENIED", `Reading ${resolved} is blocked by policy.`),
      );
      throw new Error("No such file or directory.");
    }
    return this.base.lstat(...args);
  }

  realpath(...args: Parameters<IFileSystem["realpath"]>) {
    return this.base.realpath(...args);
  }

  utimes(...args: Parameters<IFileSystem["utimes"]>) {
    const [path] = args;
    this.assertAllowedWrite(path);
    const resolved = this.resolveWorkspacePath(path);
    return this.assertSymlinksStayInWorkspace(resolved).then(() =>
      this.base.utimes(...args),
    );
  }
}

function previewResult(result: ToolResult | ToolError | undefined) {
  if (!result) {
    return "";
  }

  if ("code" in result) {
    return `${result.code}: ${result.message}`;
  }

  if ("stdout" in result) {
    return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n");
  }

  if ("content" in result) {
    return result.content;
  }

  if ("paths" in result) {
    return result.paths.join("\n");
  }

  if ("patchedPaths" in result) {
    return result.patchedPaths.join("\n");
  }

  if ("replacements" in result) {
    return `${result.path} • ${result.replacements} replacements • ${result.bytesWritten} bytes`;
  }

  if ("path" in result) {
    return `${result.path} • ${result.bytesWritten} bytes`;
  }

  return "";
}

export class JustuneBrowserSandbox {
  private readonly bash: Bash;
  private readonly fs: PolicyFileSystem;
  private readonly initialSnapshotPromise: Promise<Snapshot>;

  constructor(
    private readonly constraints: RuntimeConstraints,
    initialFiles: Record<string, string>,
  ) {
    const baseFs = new InMemoryFs();
    for (const [path, content] of Object.entries(initialFiles)) {
      baseFs.writeFileSync(path, content, "utf8");
    }
    this.fs = new PolicyFileSystem(baseFs, constraints.workspaceRoot);

    this.bash = new Bash({
      cwd: constraints.workspaceRoot,
      fs: this.fs,
      executionLimits: {
        maxCallDepth: 80,
        maxCommandCount: 500,
        maxLoopIterations: 500,
      },
    });

    this.fs.lockdown();

    this.initialSnapshotPromise = this.captureSnapshot();
  }

  async executeToolCall(toolCall: ToolCall): Promise<ToolMessage> {
    try {
      let output: ToolResult;
      switch (toolCall.tool) {
        case "bash":
          output = await this.executeCommand(
            String((toolCall.input as { command?: string }).command ?? ""),
          );
          break;
        case "listWorkspacePaths":
          output = await this.listWorkspacePaths(
            (toolCall.input as { directory?: string }).directory,
          );
          break;
        case "readFile":
          output = await this.readFile(String((toolCall.input as { path?: string }).path ?? ""));
          break;
        case "readFileRange": {
          const input = toolCall.input as {
            path?: string;
            startLine?: number;
            endLine?: number;
          };
          output = await this.readFileRange(
            String(input.path ?? ""),
            Number(input.startLine),
            Number(input.endLine),
          );
          break;
        }
        case "writeFile": {
          const writeInput = toolCall.input as { path?: string; content?: string };
          output = await this.writeFile(
            String(writeInput.path ?? ""),
            String(writeInput.content ?? ""),
          );
          break;
        }
        case "replaceInFile": {
          const replaceInput = toolCall.input as {
            path?: string;
            find?: string;
            replace?: string;
            replaceAll?: boolean;
          };
          output = await this.replaceInFile(
            String(replaceInput.path ?? ""),
            String(replaceInput.find ?? ""),
            String(replaceInput.replace ?? ""),
            Boolean(replaceInput.replaceAll),
          );
          break;
        }
        case "applyPatch":
          output = await this.applyPatch(String((toolCall.input as { patch?: string }).patch ?? ""));
          break;
        default: {
          const exhaustive: never = toolCall.tool;
          throw new Error(`Unsupported tool: ${exhaustive}`);
        }
      }

      return {
        id: crypto.randomUUID(),
        role: "tool",
        tool: toolCall.tool,
        toolCallId: toolCall.toolCallId,
        output,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        role: "tool",
        tool: toolCall.tool,
        toolCallId: toolCall.toolCallId,
        error:
          error && typeof error === "object" && "code" in error && "message" in error
            ? (error as ToolError)
            : policyError("EXECUTION_ERROR", error instanceof Error ? error.message : "Unknown tool error."),
        createdAt: new Date().toISOString(),
      };
    }
  }

  private async readWorkspaceFile(resolvedPath: string) {
    this.fs.resetViolation();
    try {
      const value = await this.fs.readFileBuffer(resolvedPath);
      return decodeText(value);
    } catch (error) {
      const violation = this.fs.consumeViolation();
      if (violation) {
        throw violation;
      }
      throw error;
    }
  }

  private async writeWorkspaceFile(resolvedPath: string, content: string) {
    const encoder = new TextEncoder();
    const byteLength = encoder.encode(content).byteLength;

    if (byteLength > this.constraints.maxWriteBytes) {
      throw policyError(
        "WRITE_TOO_LARGE",
        `Write denied: ${byteLength} bytes exceeds the ${this.constraints.maxWriteBytes} byte limit.`,
      );
    }

    this.fs.resetViolation();
    try {
      await this.fs.mkdir(dirname(resolvedPath), { recursive: true });
      await this.fs.writeFile(resolvedPath, content, "utf8");
    } catch (error) {
      const violation = this.fs.consumeViolation();
      if (violation) {
        throw violation;
      }
      throw error;
    }

    return byteLength;
  }

  private async removeWorkspacePath(resolvedPath: string) {
    this.fs.resetViolation();
    try {
      await this.fs.rm(resolvedPath);
    } catch (error) {
      const violation = this.fs.consumeViolation();
      if (violation) {
        throw violation;
      }
      throw error;
    }
  }

  private resolvePatchedPath(patch: StructuredPatch) {
    return resolvePatchedPathForWorkspace(this.constraints.workspaceRoot, patch);
  }

  private assertCommandAllowed(command: string) {
    if (!command.trim()) {
      throw policyError("INVALID_INPUT", "Command cannot be empty.");
    }

    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        throw policyError("POLICY_DENIED", `Command denied by policy: ${command}`);
      }
    }
  }

  async executeCommand(command: string): Promise<BashCommandResult> {
    this.assertCommandAllowed(command);
    this.fs.resetViolation();
    let result: Awaited<ReturnType<Bash["exec"]>>;
    try {
      result = await this.bash.exec(command, { cwd: this.constraints.workspaceRoot });
    } catch (error) {
      const violation = this.fs.consumeViolation();
      if (violation) {
        throw violation;
      }
      throw error;
    }

    const violation = this.fs.consumeViolation();
    if (violation) {
      throw violation;
    }

    const stdout = truncateText(result.stdout, this.constraints.maxOutputChars, "stdout");
    const stderr = truncateText(result.stderr, this.constraints.maxOutputChars, "stderr");

    return {
      stdout: stdout.value,
      stderr: stderr.value,
      exitCode: result.exitCode,
    };
  }

  async readFile(path: string): Promise<ReadFileResult> {
    const resolvedPath = ensureWithinWorkspace(this.constraints.workspaceRoot, path);
    if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(resolvedPath.split("/").at(-1) ?? ""))) {
      throw policyError("POLICY_DENIED", `Reading ${resolvedPath} is blocked by policy.`);
    }

    const content = await this.readWorkspaceFile(resolvedPath);

    const truncated = truncateText(content, this.constraints.maxReadChars, "file");

    return {
      path: resolvedPath,
      content: truncated.value,
      truncated: truncated.truncated,
    };
  }

  async readFileRange(
    path: string,
    startLine: number,
    endLine: number,
  ): Promise<ReadFileRangeResult> {
    if (!isPositiveInteger(startLine) || !isPositiveInteger(endLine)) {
      throw policyError("INVALID_INPUT", "Line numbers must be positive integers.");
    }

    if (startLine > endLine) {
      throw policyError("INVALID_INPUT", "startLine must be less than or equal to endLine.");
    }

    const resolvedPath = ensureWithinWorkspace(this.constraints.workspaceRoot, path);
    const content = await this.readWorkspaceFile(resolvedPath);
    const lines = content.length === 0 ? [] : content.split("\n");
    const selected = lines.slice(startLine - 1, endLine).join("\n");
    const truncated = truncateText(selected, this.constraints.maxReadChars, "file range");

    return {
      path: resolvedPath,
      content: truncated.value,
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: truncated.truncated,
    };
  }

  async writeFile(path: string, content: string): Promise<WriteFileResult> {
    const resolvedPath = ensureWithinWorkspace(this.constraints.workspaceRoot, path);
    const byteLength = await this.writeWorkspaceFile(resolvedPath, content);

    return {
      path: resolvedPath,
      success: true,
      bytesWritten: byteLength,
    };
  }

  async replaceInFile(
    path: string,
    find: string,
    replace: string,
    replaceAll = false,
  ): Promise<ReplaceInFileResult> {
    if (!find) {
      throw policyError("INVALID_INPUT", "find must be a non-empty string.");
    }

    const resolvedPath = ensureWithinWorkspace(this.constraints.workspaceRoot, path);
    const current = await this.readWorkspaceFile(resolvedPath);
    const replacements = replaceAll
      ? current.split(find).length - 1
      : current.includes(find)
        ? 1
        : 0;

    if (replacements === 0) {
      return {
        path: resolvedPath,
        replacements: 0,
        bytesWritten: 0,
      };
    }

    const nextContent = replaceAll
      ? current.split(find).join(replace)
      : current.replace(find, replace);
    const bytesWritten = await this.writeWorkspaceFile(resolvedPath, nextContent);

    return {
      path: resolvedPath,
      replacements,
      bytesWritten,
    };
  }

  async applyPatch(patchText: string): Promise<ApplyPatchResult> {
    if (!patchText.trim()) {
      throw policyError("INVALID_INPUT", "Patch cannot be empty.");
    }

    let patches: StructuredPatch[];
    try {
      patches = parsePatch(patchText);
    } catch {
      throw policyError("INVALID_INPUT", "Patch must be valid unified diff text.");
    }

    if (patches.length === 0) {
      throw policyError("INVALID_INPUT", "Patch must include at least one file diff.");
    }

    const originalContents = new Map<string, string>();
    for (const patch of patches) {
      if (patch.hunks.length === 0) {
        throw policyError("INVALID_INPUT", "Patch must include at least one hunk per file.");
      }

      const resolvedPath = this.resolvePatchedPath(patch);
      if (originalContents.has(resolvedPath)) {
        throw policyError(
          "INVALID_INPUT",
          `Patch includes multiple entries for ${resolvedPath}; combine hunks into one file diff.`,
        );
      }

      if (stripDiffPrefix(patch.oldFileName) === "/dev/null") {
        originalContents.set(resolvedPath, "");
        continue;
      }

      try {
        originalContents.set(resolvedPath, await this.readWorkspaceFile(resolvedPath));
      } catch (error) {
        if (
          error instanceof Error &&
          /no such file or directory/i.test(error.message)
        ) {
          throw policyError("FILE_NOT_FOUND", `Path ${resolvedPath} does not exist.`);
        }
        throw error;
      }
    }

    const pendingWrites = new Map<string, string | null>();
    let totalBytesWritten = 0;

    for (const patch of patches) {
      const resolvedPath = this.resolvePatchedPath(patch);
      const current = pendingWrites.has(resolvedPath)
        ? pendingWrites.get(resolvedPath)
        : originalContents.get(resolvedPath);
      const source = current ?? "";

      const nextContent = applyUnifiedPatch(source, patch, {
        autoConvertLineEndings: true,
      });

      if (nextContent === false) {
        throw policyError("PATCH_CONFLICT", `Patch could not be applied to ${resolvedPath}.`);
      }

      if (stripDiffPrefix(patch.newFileName) === "/dev/null") {
        pendingWrites.set(resolvedPath, null);
        continue;
      }

      pendingWrites.set(resolvedPath, nextContent);
      totalBytesWritten += new TextEncoder().encode(nextContent).byteLength;
    }

    if (totalBytesWritten > this.constraints.maxWriteBytes) {
      throw policyError(
        "WRITE_TOO_LARGE",
        `Write denied: ${totalBytesWritten} bytes exceeds the ${this.constraints.maxWriteBytes} byte limit.`,
      );
    }

    for (const [resolvedPath, nextContent] of pendingWrites) {
      if (nextContent === null) {
        await this.removeWorkspacePath(resolvedPath);
        continue;
      }

      await this.writeWorkspaceFile(resolvedPath, nextContent);
    }

    return {
      filesApplied: pendingWrites.size,
      patchedPaths: Array.from(pendingWrites.keys()).sort(),
      bytesWritten: totalBytesWritten,
    };
  }

  async listWorkspacePaths(directory?: string): Promise<ListWorkspacePathsResult> {
    const resolvedDirectory = ensureWithinWorkspace(
      this.constraints.workspaceRoot,
      directory && directory.trim() ? directory : this.constraints.workspaceRoot,
    );

    let stat: Awaited<ReturnType<IFileSystem["stat"]>>;
    try {
      stat = await this.fs.stat(resolvedDirectory);
    } catch {
      throw policyError("FILE_NOT_FOUND", `Path ${resolvedDirectory} does not exist.`);
    }

    if (!stat.isDirectory) {
      throw policyError("INVALID_INPUT", `${resolvedDirectory} is not a directory.`);
    }

    const visiblePaths = this.fs
      .getAllPaths()
      .filter((path) =>
        path.startsWith(`${resolvedDirectory}/`),
      )
      .sort();

    const paths: string[] = [];
    let usedChars = 0;
    let truncated = false;

    for (const path of visiblePaths) {
      const nextCost = (paths.length > 0 ? 1 : 0) + path.length;
      if (usedChars + nextCost > this.constraints.maxReadChars) {
        truncated = true;
        break;
      }
      paths.push(path);
      usedChars += nextCost;
    }

    return {
      directory: resolvedDirectory,
      paths,
      truncated,
    };
  }

  private async captureSnapshot(): Promise<Snapshot> {
    const snapshot: Snapshot = new Map();
    const workspaceRoot = this.constraints.workspaceRoot;
    const allPaths = this.fs
      .getAllPaths()
      .filter(
        (path) => path === workspaceRoot || path.startsWith(`${workspaceRoot}/`),
      )
      .sort();

    for (const path of allPaths) {
      let stat: Awaited<ReturnType<IFileSystem["stat"]>>;
      try {
        stat = await this.fs.stat(path);
      } catch {
        continue;
      }

      if (!stat.isFile) {
        continue;
      }

      try {
        snapshot.set(path, await this.readWorkspaceFile(path));
      } catch {
        continue;
      }
    }

    return snapshot;
  }

  async getChanges() {
    const [before, after] = await Promise.all([
      this.initialSnapshotPromise,
      this.captureSnapshot(),
    ]);

    const allPaths = new Set([...before.keys(), ...after.keys()]);
    const changes: FileChange[] = [];

    for (const path of Array.from(allPaths).sort()) {
      const oldValue = before.get(path);
      const newValue = after.get(path);

      if (oldValue === undefined && newValue !== undefined) {
        changes.push({ path, kind: "created", after: newValue });
      } else if (oldValue !== undefined && newValue === undefined) {
        changes.push({ path, kind: "deleted", before: oldValue });
      } else if (oldValue !== newValue) {
        changes.push({ path, kind: "modified", before: oldValue, after: newValue });
      }
    }

    return changes;
  }

  async exportPatch() {
    const changes = await this.getChanges();
    if (changes.length === 0) {
      return "";
    }

    return changes
      .map((change) =>
        createPatch(
          change.path,
          change.before ?? "",
          change.after ?? "",
          "original",
          "current",
        ),
      )
      .join("\n");
  }

  async exportChangeSetJson() {
    const changes = await this.getChanges();
    return JSON.stringify(changes, null, 2);
  }

  async exportWorkspaceFiles() {
    const snapshot = await this.captureSnapshot();
    return Object.fromEntries(snapshot.entries());
  }

  async getWorkspacePaths() {
    return this.fs
      .getAllPaths()
      .filter((path) => path.startsWith(`${this.constraints.workspaceRoot}/`))
      .sort();
  }
}

export function formatToolMessagePreview(message: ToolMessage) {
  return previewResult(message.error ?? message.output);
}

export function summarizeTool(kind: ToolName, message: ToolMessage) {
  if (message.error) {
    return `${kind} failed`;
  }

  if (kind === "bash" && message.output && "exitCode" in message.output) {
    return `bash → exit ${message.output.exitCode}`;
  }

  if (kind === "readFile" && message.output && "path" in message.output) {
    return `read ${message.output.path}`;
  }

  if (kind === "readFileRange" && message.output && "path" in message.output) {
    return `read range ${message.output.path}`;
  }

  if (kind === "writeFile" && message.output && "path" in message.output) {
    return `write ${message.output.path}`;
  }

  if (kind === "replaceInFile" && message.output && "path" in message.output) {
    return `replace ${message.output.path}`;
  }

  if (kind === "applyPatch" && message.output && "patchedPaths" in message.output) {
    return `patch ${message.output.filesApplied} files`;
  }

  if (kind === "listWorkspacePaths" && message.output && "paths" in message.output) {
    return `list ${message.output.directory}`;
  }

  return kind;
}
