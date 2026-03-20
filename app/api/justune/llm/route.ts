import {
  getConversationMessagesCharacterCount,
  getConversationMessagesValidationError,
  runLlmTurn,
  validateConversationMessages,
} from "@/lib/llm";
import type { LlmRequestBody, LlmResponseBody } from "@lemmair/justune-runtime";
import { clampRuntimeConstraints } from "@lemmair/justune-runtime/runtime-constraints";
import {
  readSessionSecretCookie,
  validateSameOriginRequest,
} from "@/lib/request-security";
import {
  SessionStoreError,
  recordSessionAuditEvent,
  registerSessionRequest,
  registerSessionRun,
  validateSession,
} from "@/lib/session-store";

export const runtime = "nodejs";

function badRequest(message: string, status = 400) {
  return new Response(message, { status });
}

async function auditLlmTurn(
  sessionId: string,
  {
    action,
    outcome,
    detail,
    runId,
    statusCode,
    messageCount,
    toolCallCount,
  }: {
    action: "llm_turn_accepted" | "llm_turn_rejected" | "llm_turn_failed";
    outcome: "accepted" | "rejected" | "error";
    detail: string;
    runId: string;
    statusCode: number;
    messageCount?: number;
    toolCallCount?: number;
  },
) {
  try {
    await recordSessionAuditEvent(sessionId, {
      route: "llm",
      action,
      outcome,
      detail,
      runId,
      statusCode,
      messageCount,
      toolCallCount,
    });
  } catch {
    // Audit failures should not change the request outcome.
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isValidBody(value: unknown): value is LlmRequestBody {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.clientId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.sessionSecret === "string" &&
    typeof value.runId === "string" &&
    validateConversationMessages(value.messages) &&
    isObject(value.constraints)
  );
}

export async function POST(request: Request) {
  const originError = validateSameOriginRequest(request);
  if (originError) {
    return badRequest(originError, 403);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }

  if (!isValidBody(body)) {
    return badRequest("Invalid justune LLM request.");
  }

  const conversationError = getConversationMessagesValidationError(body.messages);
  const conversationChars = getConversationMessagesCharacterCount(body.messages);
  if (conversationError) {
    await auditLlmTurn(body.sessionId, {
      action: "llm_turn_rejected",
      outcome: "rejected",
      detail: conversationError,
      runId: body.runId,
      statusCode: 400,
      messageCount: body.messages.length,
    });
    return badRequest(conversationError);
  }

  const cookieSecret = readSessionSecretCookie(request);
  if (!cookieSecret || cookieSecret !== body.sessionSecret) {
    await auditLlmTurn(body.sessionId, {
      action: "llm_turn_rejected",
      outcome: "rejected",
      detail: "Session cookie validation failed.",
      runId: body.runId,
      statusCode: 401,
      messageCount: body.messages.length,
    });
    return badRequest("Session cookie validation failed.", 401);
  }

  const csrfToken = request.headers.get("x-justune-csrf");
  if (!csrfToken) {
    await auditLlmTurn(body.sessionId, {
      action: "llm_turn_rejected",
      outcome: "rejected",
      detail: "Missing CSRF token.",
      runId: body.runId,
      statusCode: 403,
      messageCount: body.messages.length,
    });
    return badRequest("Missing CSRF token.", 403);
  }

  if (!(await validateSession(body.sessionId, body.sessionSecret, body.clientId, csrfToken))) {
    await auditLlmTurn(body.sessionId, {
      action: "llm_turn_rejected",
      outcome: "rejected",
      detail: "Session validation failed.",
      runId: body.runId,
      statusCode: 401,
      messageCount: body.messages.length,
    });
    return badRequest("Session validation failed.", 401);
  }

  try {
    await registerSessionRequest(body.sessionId, conversationChars);
    await registerSessionRun(body.sessionId, body.runId);
    const response = await runLlmTurn({
      ...body,
      constraints: clampRuntimeConstraints(body.constraints),
    });
    await auditLlmTurn(body.sessionId, {
      action: "llm_turn_accepted",
      outcome: "accepted",
      detail: `Completed an LLM turn in ${response.mode} mode.`,
      runId: body.runId,
      statusCode: 200,
      messageCount: body.messages.length,
      toolCallCount: response.toolCalls.length,
    });
    return Response.json(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to complete the LLM turn.";
    const statusCode = error instanceof SessionStoreError ? error.statusCode : 500;
    await auditLlmTurn(body.sessionId, {
      action: statusCode >= 500 ? "llm_turn_failed" : "llm_turn_rejected",
      outcome: statusCode >= 500 ? "error" : "rejected",
      detail: message,
      runId: body.runId,
      statusCode,
      messageCount: body.messages.length,
    });
    return badRequest(message, statusCode);
  }
}
