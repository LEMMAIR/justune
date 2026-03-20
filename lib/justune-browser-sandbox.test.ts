import { createPatch } from "diff";
import { describe, expect, it } from "vitest";
import { JustuneBrowserSandbox } from "@/lib/justune-browser-sandbox";
import { getDefaultRuntimeConstraints } from "@/lib/runtime-constraints";

describe("JustuneBrowserSandbox", () => {
  it("blocks reads of sensitive files", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {
      "/workspace/.env": "SECRET=value",
    });

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_sensitive",
      tool: "readFile",
      input: { path: ".env" },
    });

    expect(result.error).toEqual({
      code: "POLICY_DENIED",
      message: "Reading /workspace/.env is blocked by policy.",
    });
  });

  it("blocks reads of sensitive files via bash", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {
      "/workspace/.env": "SECRET=value",
    });

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_sensitive_bash",
      tool: "bash",
      input: { command: "cat .env" },
    });

    expect(result.error).toEqual({
      code: "POLICY_DENIED",
      message: "Reading /workspace/.env is blocked by policy.",
    });
  });

  it("blocks copying sensitive files via bash", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {
      "/workspace/.env": "SECRET=value",
    });

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_sensitive_copy",
      tool: "bash",
      input: { command: "cp .env copied.txt" },
    });

    expect(result.error).toEqual({
      code: "POLICY_DENIED",
      message: "Reading /workspace/.env is blocked by policy.",
    });
  });

  it("rejects writes outside the workspace via bash", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {});

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_bash_outside",
      tool: "bash",
      input: { command: "echo hi > /tmp/out.txt" },
    });

    expect(result.error).toEqual({
      code: "PATH_DENIED",
      message: "Path /tmp/out.txt is outside /workspace.",
    });
  });

  it("rejects writes outside the workspace", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {});

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_outside",
      tool: "writeFile",
      input: { path: "../escape.txt", content: "nope" },
    });

    expect(result.error).toEqual({
      code: "PATH_DENIED",
      message: "Path /escape.txt is outside /workspace.",
    });
  });

  it("truncates large read results", async () => {
    const constraints = {
      ...getDefaultRuntimeConstraints(),
      maxReadChars: 10,
    };
    const sandbox = new JustuneBrowserSandbox(constraints, {
      "/workspace/notes.txt": "abcdefghijklmnopqrstuvwxyz",
    });

    const result = await sandbox.readFile("notes.txt");

    expect(result.content).toContain("[file truncated:");
    expect(result.truncated).toBe(true);
  });

  it("lists visible workspace paths without sensitive files", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {
      "/workspace/.env": "SECRET=value",
      "/workspace/docs/notes.md": "hello",
      "/workspace/src/app.ts": "export {};",
    });

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_list_paths",
      tool: "listWorkspacePaths",
      input: {},
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toMatchObject({
      directory: "/workspace",
      truncated: false,
      paths: ["/workspace/docs", "/workspace/docs/notes.md", "/workspace/src", "/workspace/src/app.ts"],
    });
  });

  it("reads a line range from a file", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {
      "/workspace/notes.txt": "line 1\nline 2\nline 3\nline 4",
    });

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_read_range",
      tool: "readFileRange",
      input: { path: "notes.txt", startLine: 2, endLine: 3 },
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toMatchObject({
      path: "/workspace/notes.txt",
      content: "line 2\nline 3",
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      truncated: false,
    });
  });

  it("replaces exact text in a file", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {
      "/workspace/notes.txt": "alpha beta alpha",
    });

    const replaceResult = await sandbox.executeToolCall({
      toolCallId: "tc_replace",
      tool: "replaceInFile",
      input: { path: "notes.txt", find: "alpha", replace: "gamma", replaceAll: true },
    });

    expect(replaceResult.error).toBeUndefined();
    expect(replaceResult.output).toMatchObject({
      path: "/workspace/notes.txt",
      replacements: 2,
    });

    const readResult = await sandbox.readFile("notes.txt");
    expect(readResult.content).toBe("gamma beta gamma");
  });

  it("applies a unified diff patch across multiple files", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {
      "/workspace/notes.txt": "alpha\nbeta\ngamma\ndelta\n",
      "/workspace/todo.md": "- one\n- two\n",
    });
    const notesPatch = createPatch(
      "/workspace/notes.txt",
      "alpha\nbeta\ngamma\ndelta\n",
      "alpha\nBETA\ngamma\nDELTA\n",
      "original",
      "current",
    );
    const todoPatch = createPatch(
      "/workspace/todo.md",
      "- one\n- two\n",
      "- one\n- two\n- three\n",
      "original",
      "current",
    );

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_apply_patch",
      tool: "applyPatch",
      input: { patch: `${notesPatch}\n${todoPatch}` },
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toMatchObject({
      filesApplied: 2,
      patchedPaths: ["/workspace/notes.txt", "/workspace/todo.md"],
    });
    expect((await sandbox.readFile("notes.txt")).content).toBe("alpha\nBETA\ngamma\nDELTA\n");
    expect((await sandbox.readFile("todo.md")).content).toBe("- one\n- two\n- three\n");
  });

  it("creates a file from a /dev/null patch", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {});
    const patch = [
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_create_patch",
      tool: "applyPatch",
      input: { patch },
    });

    expect(result.error).toBeUndefined();
    expect((await sandbox.readFile("new.txt")).content).toBe("hello\nworld\n");
  });

  it("rejects multiple patch entries for the same file", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {
      "/workspace/notes.txt": "alpha\nbeta\n",
    });
    const firstPatch = createPatch(
      "/workspace/notes.txt",
      "alpha\nbeta\n",
      "ALPHA\nbeta\n",
      "original",
      "current",
    );
    const secondPatch = createPatch(
      "/workspace/notes.txt",
      "alpha\nbeta\n",
      "alpha\nBETA\n",
      "original",
      "current",
    );

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_duplicate_patch_entries",
      tool: "applyPatch",
      input: { patch: `${firstPatch}\n${secondPatch}` },
    });

    expect(result.error).toEqual({
      code: "INVALID_INPUT",
      message:
        "Patch includes multiple entries for /workspace/notes.txt; combine hunks into one file diff.",
    });
  });

  it("returns a patch conflict when hunks do not match", async () => {
    const sandbox = new JustuneBrowserSandbox(getDefaultRuntimeConstraints(), {
      "/workspace/notes.txt": "alpha\nbeta\n",
    });
    const patch = createPatch(
      "/workspace/notes.txt",
      "different\ncontent\n",
      "different\nupdated\n",
      "original",
      "current",
    );

    const result = await sandbox.executeToolCall({
      toolCallId: "tc_patch_conflict",
      tool: "applyPatch",
      input: { patch },
    });

    expect(result.error).toEqual({
      code: "PATCH_CONFLICT",
      message: "Patch could not be applied to /workspace/notes.txt.",
    });
  });
});
