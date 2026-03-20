import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  getSessionAuditEventsForTests,
  registerSessionRequest,
  registerSessionRun,
  reloadSessionStoreFromDiskForTests,
  resetSessionStoreForTests,
  restoreSession,
  validateSession,
} from "@/lib/session-store";

describe("session store", () => {
  afterEach(() => {
    resetSessionStoreForTests();
    delete process.env.JUSTUNE_SESSION_STORE_FILE;
    delete process.env.JUSTUNE_SESSION_REDIS_REST_URL;
    delete process.env.JUSTUNE_SESSION_REDIS_REST_TOKEN;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("binds sessions to the originating client id", async () => {
    const session = await createSession("client_12345678");

    await expect(
      validateSession(session.sessionId, session.secret, "client_12345678"),
    ).resolves.toBe(true);
    await expect(
      validateSession(session.sessionId, session.secret, "client_other123"),
    ).resolves.toBe(false);
  });

  it("restores an existing session for the same client", async () => {
    const session = await createSession("client_restore1");

    await expect(
      restoreSession("client_restore1", session.sessionId, session.secret),
    ).resolves.toEqual(session);
    await expect(
      restoreSession("client_restore2", session.sessionId, session.secret),
    ).resolves.toBeNull();

    await expect(getSessionAuditEventsForTests(session.sessionId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "session_created", outcome: "accepted" }),
        expect.objectContaining({ action: "session_restored", outcome: "accepted" }),
      ]),
    );
  });

  it("binds run ids to a single session", async () => {
    const first = await createSession("client_run11111");
    const second = await createSession("client_run22222");
    const runId = "run_12345678-1234-1234-1234-123456789abc";

    await expect(registerSessionRun(first.sessionId, runId)).resolves.toBeUndefined();
    await expect(registerSessionRun(second.sessionId, runId)).rejects.toThrow(
      "Run id belongs to another session.",
    );
  });

  it("persists sessions to an optional file-backed store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "justune-session-store-"));
    process.env.JUSTUNE_SESSION_STORE_FILE = join(directory, "sessions.json");

    try {
      const session = await createSession("client_persist1");

      reloadSessionStoreFromDiskForTests();

      await expect(
        restoreSession("client_persist1", session.sessionId, session.secret),
      ).resolves.toEqual(session);
      await expect(
        validateSession(session.sessionId, session.secret, "client_persist1"),
      ).resolves.toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("supports a Redis REST-backed session store", async () => {
    process.env.JUSTUNE_SESSION_REDIS_REST_URL = "https://redis.example.test";
    process.env.JUSTUNE_SESSION_REDIS_REST_TOKEN = "token_test";

    const redisValues = new Map<string, string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const [rawCommand = "", rawKey = "", ...rest] = url
          .replace("https://redis.example.test/", "")
          .split("/");
        const command = decodeURIComponent(rawCommand).toUpperCase();
        const key = decodeURIComponent(rawKey);

        if (command === "SET") {
          const value = decodeURIComponent(rest[0] ?? "");
          redisValues.set(key, value);
          return {
            ok: true,
            json: async () => ({ result: "OK" }),
          };
        }

        if (command === "GET") {
          return {
            ok: true,
            json: async () => ({ result: redisValues.get(key) ?? null }),
          };
        }

        if (command === "DEL") {
          redisValues.delete(key);
          return {
            ok: true,
            json: async () => ({ result: 1 }),
          };
        }

        throw new Error(`Unexpected Redis command: ${command}`);
      }),
    );

    const session = await createSession("client_remote11");

    await expect(
      restoreSession("client_remote11", session.sessionId, session.secret),
    ).resolves.toEqual(session);
    await expect(
      validateSession(session.sessionId, session.secret, "client_remote11", session.csrfToken),
    ).resolves.toBe(true);
  });

  it("enforces a cumulative llm turn quota per session", async () => {
    const session = await createSession("client_quota111");
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const current = now;
      now += 61_000;
      return current;
    });

    for (let index = 0; index < 120; index += 1) {
      await expect(registerSessionRequest(session.sessionId, 1)).resolves.toBeUndefined();
    }

    await expect(registerSessionRequest(session.sessionId, 1)).rejects.toThrow(
      "Session exceeded the 120 turn quota.",
    );
  });

  it("enforces a cumulative conversation-character quota per session", async () => {
    const session = await createSession("client_quota222");
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const current = now;
      now += 61_000;
      return current;
    });

    await expect(registerSessionRequest(session.sessionId, 1_000_000)).resolves.toBeUndefined();
    await expect(registerSessionRequest(session.sessionId, 1_000_000)).resolves.toBeUndefined();
    await expect(registerSessionRequest(session.sessionId, 1)).rejects.toThrow(
      "Session exceeded the 2000000 character conversation quota.",
    );
  });
});
