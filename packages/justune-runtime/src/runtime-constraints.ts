import type { RuntimeConstraints } from "./protocol";

const DEFAULT_WORKSPACE_ROOT = "/workspace";

const HARD_LIMITS = {
  maxOutputChars: 30_000,
  maxReadChars: 200_000,
  maxWriteBytes: 120_000,
  timeoutMs: 30_000,
} as const;

const MIN_LIMITS = {
  maxOutputChars: 2_000,
  maxReadChars: 4_000,
  maxWriteBytes: 1_024,
  timeoutMs: 1_000,
} as const;

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return Math.min(maximum, Math.max(minimum, normalized));
}

export function getDefaultRuntimeConstraints(): RuntimeConstraints {
  return {
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    maxOutputChars: HARD_LIMITS.maxOutputChars,
    maxReadChars: HARD_LIMITS.maxReadChars,
    maxWriteBytes: HARD_LIMITS.maxWriteBytes,
    timeoutMs: HARD_LIMITS.timeoutMs,
  };
}

export function clampRuntimeConstraints(
  constraints: Partial<RuntimeConstraints> | null | undefined,
): RuntimeConstraints {
  return {
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    maxOutputChars: clampNumber(
      constraints?.maxOutputChars,
      MIN_LIMITS.maxOutputChars,
      HARD_LIMITS.maxOutputChars,
      HARD_LIMITS.maxOutputChars,
    ),
    maxReadChars: clampNumber(
      constraints?.maxReadChars,
      MIN_LIMITS.maxReadChars,
      HARD_LIMITS.maxReadChars,
      HARD_LIMITS.maxReadChars,
    ),
    maxWriteBytes: clampNumber(
      constraints?.maxWriteBytes,
      MIN_LIMITS.maxWriteBytes,
      HARD_LIMITS.maxWriteBytes,
      HARD_LIMITS.maxWriteBytes,
    ),
    timeoutMs: clampNumber(
      constraints?.timeoutMs,
      MIN_LIMITS.timeoutMs,
      HARD_LIMITS.timeoutMs,
      HARD_LIMITS.timeoutMs,
    ),
  };
}
