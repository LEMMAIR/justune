import { createSession, restoreSession } from "@/lib/session-store";
import { getProviderLabel, getProviderReady } from "@/lib/llm";
import {
  buildSessionSecretCookie,
  readSessionSecretCookie,
  validateSameOriginRequest,
} from "@/lib/request-security";

export const runtime = "nodejs";

interface SessionRequestBody {
  clientId: string;
  sessionId?: string;
  sessionSecret?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isValidBody(value: unknown): value is SessionRequestBody {
  if (!isObject(value) || typeof value.clientId !== "string") {
    return false;
  }

  return (
    value.sessionId === undefined ||
    typeof value.sessionId === "string"
  );
}

export async function POST(request: Request) {
  const originError = validateSameOriginRequest(request);
  if (originError) {
    return new Response(originError, { status: 403 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return new Response("Invalid session bootstrap request.", { status: 400 });
  }

  if (!isValidBody(body)) {
    return new Response("Invalid session bootstrap request.", { status: 400 });
  }

  const cookieSecret = readSessionSecretCookie(request);
  if (body.sessionSecret && cookieSecret && body.sessionSecret !== cookieSecret) {
    return new Response("Session secret mismatch.", { status: 401 });
  }

  const restoreSecret = body.sessionSecret ?? cookieSecret ?? undefined;
  const restored =
    body.sessionId && restoreSecret
      ? await restoreSession(body.clientId, body.sessionId, restoreSecret)
      : null;

  let session;

  try {
    session = restored ?? (await createSession(body.clientId));
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Failed to create a session.",
      { status: 400 },
    );
  }

  return Response.json(
    {
      clientId: body.clientId,
      sessionId: session.sessionId,
      sessionSecret: session.secret,
      csrfToken: session.csrfToken,
      providerReady: getProviderReady(),
      providerLabel: getProviderLabel(),
      resumed: Boolean(restored),
    },
    {
      headers: {
        "Set-Cookie": buildSessionSecretCookie(session.secret),
      },
    },
  );
}
