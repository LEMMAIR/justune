import { describe, expect, it } from "vitest";
import {
  clampRuntimeConstraints,
  getDefaultRuntimeConstraints,
} from "@/lib/runtime-constraints";

describe("runtime constraints", () => {
  it("returns the hard defaults when input is missing", () => {
    expect(clampRuntimeConstraints(undefined)).toEqual(getDefaultRuntimeConstraints());
  });

  it("clamps oversized client values back to server limits", () => {
    expect(
      clampRuntimeConstraints({
        workspaceRoot: "/tmp",
        maxOutputChars: 999_999,
        maxReadChars: 999_999,
        maxWriteBytes: 999_999,
        timeoutMs: 999_999,
      }),
    ).toEqual(getDefaultRuntimeConstraints());
  });

  it("clamps undersized values up to the minimum guardrails", () => {
    expect(
      clampRuntimeConstraints({
        maxOutputChars: 1,
        maxReadChars: 1,
        maxWriteBytes: 1,
        timeoutMs: 1,
      }),
    ).toEqual({
      workspaceRoot: "/workspace",
      maxOutputChars: 2_000,
      maxReadChars: 4_000,
      maxWriteBytes: 1_024,
      timeoutMs: 1_000,
    });
  });
});
