import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as postLlmRoute } from "@/app/api/justune/llm/route";
import { createSession, getSessionAuditEventsForTests, resetSessionStoreForTests } from "@/lib/session-store";
import { getDefaultRuntimeConstraints } from "@/lib/runtime-constraints";

function createLlmRequest(
  session: { sessionId: string; secret: string; csrfToken: string },
  options?: { includeCsrf?: boolean; runId?: string },
) {
  const runId = options?.runId ?? "run_12345678";
  const includeCsrf = options?.includeCsrf ?? true;

  return new Request("http://localhost:3000/api/justune/llm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      cookie: `justune_session_secret=${encodeURIComponent(session.secret)}`,
      ...(includeCsrf ? { "x-justune-csrf": session.csrfToken } : {}),
    },
    body: JSON.stringify({
      clientId: "client_route1111",
      sessionId: session.sessionId,
      sessionSecret: session.secret,
      runId,
      constraints: getDefaultRuntimeConstraints(),
      messages: [
        {
          id: "msg_user",
          role: "user",
          text: "inspect the workspace",
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  });
}

describe("llm route audit trail", () => {
  afterEach(() => {
    resetSessionStoreForTests();
    delete process.env.JUSTUNE_LLM_API_KEY;
    delete process.env.JUSTUNE_LLM_MODEL;
    delete process.env.JUSTUNE_LLM_BASE_URL;
    vi.unstubAllGlobals();
  });

  it("records accepted llm turns in the server audit trail", async () => {
    const session = await createSession("client_route1111");

    const response = await postLlmRoute(createLlmRequest(session));

    expect(response.status).toBe(200);

    await expect(getSessionAuditEventsForTests(session.sessionId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "run_registered",
          outcome: "accepted",
          runId: "run_12345678",
        }),
        expect.objectContaining({
          action: "llm_turn_accepted",
          outcome: "accepted",
          runId: "run_12345678",
          statusCode: 200,
          messageCount: 1,
        }),
      ]),
    );
  });

  it("records rejected llm turns in the server audit trail", async () => {
    const session = await createSession("client_route1111");

    const response = await postLlmRoute(createLlmRequest(session, { includeCsrf: false }));

    expect(response.status).toBe(403);

    await expect(getSessionAuditEventsForTests(session.sessionId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "llm_turn_rejected",
          outcome: "rejected",
          runId: "run_12345678",
          statusCode: 403,
          detail: "Missing CSRF token.",
        }),
      ]),
    );
  });

  it("returns session-store validation errors with their original status code", async () => {
    const session = await createSession("client_route1111");

    const response = await postLlmRoute(
      createLlmRequest(session, { runId: "bad_run_id" }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid run id.");

    await expect(getSessionAuditEventsForTests(session.sessionId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "llm_turn_rejected",
          outcome: "rejected",
          runId: "bad_run_id",
          statusCode: 400,
          detail: "Invalid run id.",
        }),
      ]),
    );
  });
});
