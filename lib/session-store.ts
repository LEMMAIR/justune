import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 24;
const MAX_RUNS_PER_SESSION = 64;
const MAX_AUDIT_EVENTS_PER_SESSION = 64;
const MAX_LLM_TURNS_PER_SESSION = 120;
const MAX_CONVERSATION_CHARS_PER_SESSION = 2_000_000;

export type SessionAuditAction =
  | "session_created"
  | "session_restored"
  | "run_registered"
  | "llm_turn_accepted"
  | "llm_turn_rejected"
  | "llm_turn_failed";

export interface SessionAuditEvent {
  id: string;
  at: number;
  route: "session" | "llm";
  action: SessionAuditAction;
  outcome: "accepted" | "rejected" | "error";
  detail?: string;
  runId?: string;
  statusCode?: number;
  messageCount?: number;
  toolCallCount?: number;
}

interface SessionAuditEventInput {
  route: "session" | "llm";
  action: SessionAuditAction;
  outcome: "accepted" | "rejected" | "error";
  detail?: string;
  runId?: string;
  statusCode?: number;
  messageCount?: number;
  toolCallCount?: number;
}

interface RunRecord {
  runId: string;
  lastSeenAt: number;
}

interface SessionRecord {
  sessionId: string;
  secret: string;
  csrfToken: string;
  clientId: string;
  createdAt: number;
  requestTimestamps: number[];
  runs: Map<string, RunRecord>;
  auditEvents: SessionAuditEvent[];
  llmTurnCount: number;
  consumedConversationChars: number;
}

const sessions = new Map<string, SessionRecord>();
const runOwners = new Map<string, string>();
let loadedStoreFile: string | null | undefined;

interface PersistedRunRecord {
  runId: string;
  lastSeenAt: number;
}

interface PersistedSessionRecord {
  sessionId: string;
  secret: string;
  csrfToken: string;
  clientId: string;
  createdAt: number;
  requestTimestamps: number[];
  runs: PersistedRunRecord[];
  auditEvents?: SessionAuditEvent[];
  llmTurnCount?: number;
  consumedConversationChars?: number;
}

interface PersistedSessionStore {
  version: 1;
  sessions: PersistedSessionRecord[];
  runOwners: Array<[string, string]>;
}

interface SessionTokens {
  sessionId: string;
  secret: string;
  csrfToken: string;
}

interface SessionStoreBackend {
  createSession(clientId: string): Promise<SessionTokens>;
  restoreSession(clientId: string, sessionId: string, secret: string): Promise<SessionTokens | null>;
  validateSession(
    sessionId: string,
    secret: string,
    clientId: string,
    csrfToken?: string,
  ): Promise<boolean>;
  registerSessionRequest(sessionId: string, conversationChars?: number): Promise<void>;
  registerSessionRun(sessionId: string, runId: string): Promise<void>;
  recordSessionAuditEvent(sessionId: string, event: SessionAuditEventInput): Promise<boolean>;
  getSessionAuditEvents(sessionId: string): Promise<SessionAuditEvent[]>;
}

export class SessionStoreError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "SessionStoreError";
    this.statusCode = statusCode;
  }
}

interface RedisSessionStoreConfig {
  url: string;
  token: string;
  keyPrefix: string;
}

function getConfiguredSessionStoreFile() {
  const configured = process.env.JUSTUNE_SESSION_STORE_FILE?.trim();
  return configured ? resolve(configured) : null;
}

function getConfiguredRedisSessionStore(): RedisSessionStoreConfig | null {
  const url =
    process.env.JUSTUNE_SESSION_REDIS_REST_URL?.trim() ||
    process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token =
    process.env.JUSTUNE_SESSION_REDIS_REST_TOKEN?.trim() ||
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!url || !token) {
    return null;
  }

  return {
    url: url.replace(/\/+$/, ""),
    token,
    keyPrefix: process.env.JUSTUNE_SESSION_REDIS_KEY_PREFIX?.trim() || "justune",
  };
}

function serializeSessionStore(): PersistedSessionStore {
  return {
    version: 1,
    sessions: Array.from(sessions.values()).map((record) => ({
      sessionId: record.sessionId,
      secret: record.secret,
      csrfToken: record.csrfToken,
      clientId: record.clientId,
      createdAt: record.createdAt,
      requestTimestamps: [...record.requestTimestamps],
      runs: Array.from(record.runs.values()).map((run) => ({
        runId: run.runId,
        lastSeenAt: run.lastSeenAt,
      })),
      auditEvents: [...record.auditEvents],
      llmTurnCount: record.llmTurnCount,
      consumedConversationChars: record.consumedConversationChars,
    })),
    runOwners: Array.from(runOwners.entries()),
  };
}

function sanitizeAuditEvents(value: unknown): SessionAuditEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (event): event is SessionAuditEvent =>
        Boolean(event) &&
        typeof event === "object" &&
        typeof (event as { id?: unknown }).id === "string" &&
        typeof (event as { at?: unknown }).at === "number" &&
        ((event as { route?: unknown }).route === "session" ||
          (event as { route?: unknown }).route === "llm") &&
        typeof (event as { action?: unknown }).action === "string" &&
        ((event as { outcome?: unknown }).outcome === "accepted" ||
          (event as { outcome?: unknown }).outcome === "rejected" ||
          (event as { outcome?: unknown }).outcome === "error"),
    )
    .slice(-MAX_AUDIT_EVENTS_PER_SESSION);
}

function createAuditEvent(event: SessionAuditEventInput): SessionAuditEvent {
  return {
    id: createToken("audit"),
    at: Date.now(),
    ...event,
  };
}

function appendAuditEvent(record: SessionRecord, event: SessionAuditEventInput) {
  record.auditEvents.push(createAuditEvent(event));
  if (record.auditEvents.length > MAX_AUDIT_EVENTS_PER_SESSION) {
    record.auditEvents.splice(0, record.auditEvents.length - MAX_AUDIT_EVENTS_PER_SESSION);
  }
}

function loadPersistedSessionStore(filePath: string) {
  if (!existsSync(filePath)) {
    return;
  }

  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse JUSTUNE_SESSION_STORE_FILE at ${filePath}: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }

  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
    throw new Error(`Unsupported JUSTUNE_SESSION_STORE_FILE format at ${filePath}.`);
  }

  const persisted = value as PersistedSessionStore;
  sessions.clear();
  runOwners.clear();

  for (const record of persisted.sessions ?? []) {
    sessions.set(record.sessionId, {
      sessionId: record.sessionId,
      secret: record.secret,
      csrfToken: record.csrfToken,
      clientId: record.clientId,
      createdAt: record.createdAt,
      requestTimestamps: Array.isArray(record.requestTimestamps)
        ? record.requestTimestamps.filter((timestamp) => typeof timestamp === "number")
        : [],
      runs: new Map(
        Array.isArray(record.runs)
          ? record.runs
              .filter(
                (run): run is PersistedRunRecord =>
                  Boolean(run) &&
                  typeof run.runId === "string" &&
                  typeof run.lastSeenAt === "number",
              )
              .map((run) => [run.runId, { runId: run.runId, lastSeenAt: run.lastSeenAt }])
          : [],
      ),
      auditEvents: sanitizeAuditEvents(record.auditEvents),
      llmTurnCount:
        typeof record.llmTurnCount === "number" && record.llmTurnCount >= 0
          ? record.llmTurnCount
          : 0,
      consumedConversationChars:
        typeof record.consumedConversationChars === "number" &&
        record.consumedConversationChars >= 0
          ? record.consumedConversationChars
          : 0,
    });
  }

  for (const [runId, sessionId] of persisted.runOwners ?? []) {
    if (typeof runId === "string" && typeof sessionId === "string") {
      runOwners.set(runId, sessionId);
    }
  }
}

function syncSessionStoreConfiguration() {
  const filePath = getConfiguredSessionStoreFile();
  if (loadedStoreFile === filePath) {
    return;
  }

  loadedStoreFile = filePath;
  sessions.clear();
  runOwners.clear();

  if (filePath) {
    loadPersistedSessionStore(filePath);
  }
}

function persistSessionStore() {
  if (!loadedStoreFile) {
    return;
  }

  mkdirSync(dirname(loadedStoreFile), { recursive: true });
  const tempFile = `${loadedStoreFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tempFile, JSON.stringify(serializeSessionStore(), null, 2));
  renameSync(tempFile, loadedStoreFile);
}

function cleanExpiredSessions(now = Date.now()) {
  let mutated = false;

  for (const [sessionId, record] of sessions.entries()) {
    if (now - record.createdAt > SESSION_TTL_MS) {
      for (const runId of record.runs.keys()) {
        runOwners.delete(runId);
      }
      sessions.delete(sessionId);
      mutated = true;
    }
  }

  return mutated;
}

function createToken(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function isValidClientId(clientId: string) {
  return /^client_[a-z0-9-]{8,}$/i.test(clientId);
}

function isValidRunId(runId: string) {
  return /^run_[a-z0-9-]{8,}$/i.test(runId) && runId.length <= 96;
}

function trimOldRuns(record: SessionRecord) {
  if (record.runs.size <= MAX_RUNS_PER_SESSION) {
    return;
  }

  const sortedRuns = Array.from(record.runs.values()).sort(
    (left, right) => left.lastSeenAt - right.lastSeenAt,
  );

  while (sortedRuns.length > MAX_RUNS_PER_SESSION) {
    const oldest = sortedRuns.shift();
    if (!oldest) {
      break;
    }
    record.runs.delete(oldest.runId);
    runOwners.delete(oldest.runId);
  }
}

function createLocalSession(clientId: string) {
  syncSessionStoreConfiguration();
  if (!isValidClientId(clientId)) {
    throw new Error("Invalid client.");
  }

  if (cleanExpiredSessions()) {
    persistSessionStore();
  }
  const sessionId = createToken("s");
  const secret = createToken("sec");
  const csrfToken = createToken("csrf");
  sessions.set(sessionId, {
    sessionId,
    secret,
    csrfToken,
    clientId,
    createdAt: Date.now(),
    requestTimestamps: [],
    runs: new Map(),
    auditEvents: [],
    llmTurnCount: 0,
    consumedConversationChars: 0,
  });
  appendAuditEvent(sessions.get(sessionId)!, {
    route: "session",
    action: "session_created",
    outcome: "accepted",
    detail: "Created a new session.",
    statusCode: 200,
  });
  persistSessionStore();
  return { sessionId, secret, csrfToken };
}

function restoreLocalSession(clientId: string, sessionId: string, secret: string) {
  syncSessionStoreConfiguration();
  if (cleanExpiredSessions()) {
    persistSessionStore();
  }
  const record = sessions.get(sessionId);
  if (!record) {
    return null;
  }

  if (record.secret !== secret || record.clientId !== clientId) {
    return null;
  }

  appendAuditEvent(record, {
    route: "session",
    action: "session_restored",
    outcome: "accepted",
    detail: "Restored an existing session.",
    statusCode: 200,
  });
  persistSessionStore();
  return { sessionId: record.sessionId, secret: record.secret, csrfToken: record.csrfToken };
}

function validateLocalSession(
  sessionId: string,
  secret: string,
  clientId: string,
  csrfToken?: string,
) {
  syncSessionStoreConfiguration();
  if (cleanExpiredSessions()) {
    persistSessionStore();
  }
  const record = sessions.get(sessionId);
  if (!record || record.secret !== secret || record.clientId !== clientId) {
    return false;
  }
  if (csrfToken && record.csrfToken !== csrfToken) {
    return false;
  }
  return true;
}

function registerLocalSessionRequest(sessionId: string, conversationChars = 0) {
  syncSessionStoreConfiguration();
  const record = sessions.get(sessionId);
  if (!record) {
    throw new SessionStoreError("Unknown session.", 404);
  }

  const now = Date.now();
  record.requestTimestamps = record.requestTimestamps.filter(
    (timestamp) => now - timestamp < RATE_WINDOW_MS,
  );

  if (record.requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    throw new SessionStoreError("Rate limit exceeded for this session.", 429);
  }

  if (record.llmTurnCount >= MAX_LLM_TURNS_PER_SESSION) {
    throw new SessionStoreError(
      `Session exceeded the ${MAX_LLM_TURNS_PER_SESSION} turn quota.`,
      429,
    );
  }

  if (record.consumedConversationChars + conversationChars > MAX_CONVERSATION_CHARS_PER_SESSION) {
    throw new SessionStoreError(
      `Session exceeded the ${MAX_CONVERSATION_CHARS_PER_SESSION} character conversation quota.`,
      429,
    );
  }

  record.requestTimestamps.push(now);
  record.llmTurnCount += 1;
  record.consumedConversationChars += Math.max(0, conversationChars);
  persistSessionStore();
}

function registerLocalSessionRun(sessionId: string, runId: string) {
  syncSessionStoreConfiguration();
  const record = sessions.get(sessionId);
  if (!record) {
    throw new SessionStoreError("Unknown session.", 404);
  }

  if (!isValidRunId(runId)) {
    throw new SessionStoreError("Invalid run id.", 400);
  }

  const owner = runOwners.get(runId);
  if (owner && owner !== sessionId) {
    throw new SessionStoreError("Run id belongs to another session.", 409);
  }

  const now = Date.now();
  record.runs.set(runId, { runId, lastSeenAt: now });
  runOwners.set(runId, sessionId);
  trimOldRuns(record);
  appendAuditEvent(record, {
    route: "llm",
    action: "run_registered",
    outcome: "accepted",
    detail: "Registered the run id for this session.",
    runId,
    statusCode: 200,
  });
  persistSessionStore();
}

function localSessionStore(): SessionStoreBackend {
  return {
    async createSession(clientId) {
      return createLocalSession(clientId);
    },
    async restoreSession(clientId, sessionId, secret) {
      return restoreLocalSession(clientId, sessionId, secret);
    },
    async validateSession(sessionId, secret, clientId, csrfToken) {
      return validateLocalSession(sessionId, secret, clientId, csrfToken);
    },
    async registerSessionRequest(sessionId, conversationChars) {
      registerLocalSessionRequest(sessionId, conversationChars);
    },
    async registerSessionRun(sessionId, runId) {
      registerLocalSessionRun(sessionId, runId);
    },
    async recordSessionAuditEvent(sessionId, event) {
      syncSessionStoreConfiguration();
      const record = sessions.get(sessionId);
      if (!record) {
        return false;
      }

      appendAuditEvent(record, event);
      persistSessionStore();
      return true;
    },
    async getSessionAuditEvents(sessionId) {
      syncSessionStoreConfiguration();
      const record = sessions.get(sessionId);
      return record ? [...record.auditEvents] : [];
    },
  };
}

function sessionTtlSeconds() {
  return Math.max(1, Math.floor(SESSION_TTL_MS / 1000));
}

function remoteSessionKey(config: RedisSessionStoreConfig, sessionId: string) {
  return `${config.keyPrefix}:session:${sessionId}`;
}

function remoteRunOwnerKey(config: RedisSessionStoreConfig, runId: string) {
  return `${config.keyPrefix}:run-owner:${runId}`;
}

async function executeRedisCommand(
  config: RedisSessionStoreConfig,
  command: Array<string | number>,
) {
  const path = command.map((part) => encodeURIComponent(String(part))).join("/");
  const response = await fetch(`${config.url}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Redis session store request failed with ${response.status}.`);
  }

  const payload = (await response.json()) as { result?: unknown; error?: string };
  if (payload.error) {
    throw new Error(`Redis session store error: ${payload.error}`);
  }

  return payload.result;
}

function hydrateRemoteSession(value: string, sessionIdForError: string): SessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Stored session ${sessionIdForError} is not valid JSON.`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Stored session ${sessionIdForError} is invalid.`);
  }

  const record = parsed as PersistedSessionRecord;
  return {
    sessionId: record.sessionId,
    secret: record.secret,
    csrfToken: record.csrfToken,
    clientId: record.clientId,
      createdAt: record.createdAt,
      requestTimestamps: Array.isArray(record.requestTimestamps)
        ? record.requestTimestamps.filter((timestamp) => typeof timestamp === "number")
        : [],
    runs: new Map(
      Array.isArray(record.runs)
        ? record.runs
            .filter(
              (run): run is PersistedRunRecord =>
                Boolean(run) &&
                typeof run.runId === "string" &&
                typeof run.lastSeenAt === "number",
            )
            .map((run) => [run.runId, { runId: run.runId, lastSeenAt: run.lastSeenAt }])
        : [],
    ),
    auditEvents: sanitizeAuditEvents(record.auditEvents),
    llmTurnCount:
      typeof record.llmTurnCount === "number" && record.llmTurnCount >= 0
        ? record.llmTurnCount
        : 0,
    consumedConversationChars:
      typeof record.consumedConversationChars === "number" &&
      record.consumedConversationChars >= 0
        ? record.consumedConversationChars
        : 0,
  };
}

async function getRemoteSession(
  config: RedisSessionStoreConfig,
  sessionId: string,
): Promise<SessionRecord | null> {
  const result = await executeRedisCommand(config, ["GET", remoteSessionKey(config, sessionId)]);
  if (typeof result !== "string" || !result) {
    return null;
  }

  return hydrateRemoteSession(result, sessionId);
}

async function persistRemoteSession(
  config: RedisSessionStoreConfig,
  record: SessionRecord,
) {
  const serialized: PersistedSessionRecord = {
    sessionId: record.sessionId,
    secret: record.secret,
    csrfToken: record.csrfToken,
    clientId: record.clientId,
    createdAt: record.createdAt,
    requestTimestamps: [...record.requestTimestamps],
    runs: Array.from(record.runs.values()),
    auditEvents: [...record.auditEvents],
    llmTurnCount: record.llmTurnCount,
    consumedConversationChars: record.consumedConversationChars,
  };

  await executeRedisCommand(config, [
    "SET",
    remoteSessionKey(config, record.sessionId),
    JSON.stringify(serialized),
    "EX",
    sessionTtlSeconds(),
  ]);
}

function remoteSessionStore(config: RedisSessionStoreConfig): SessionStoreBackend {
  return {
    async createSession(clientId) {
      if (!isValidClientId(clientId)) {
        throw new Error("Invalid client.");
      }

      const record: SessionRecord = {
        sessionId: createToken("s"),
        secret: createToken("sec"),
        csrfToken: createToken("csrf"),
        clientId,
        createdAt: Date.now(),
        requestTimestamps: [],
        runs: new Map(),
        auditEvents: [],
        llmTurnCount: 0,
        consumedConversationChars: 0,
      };

      appendAuditEvent(record, {
        route: "session",
        action: "session_created",
        outcome: "accepted",
        detail: "Created a new session.",
        statusCode: 200,
      });
      await persistRemoteSession(config, record);
      return {
        sessionId: record.sessionId,
        secret: record.secret,
        csrfToken: record.csrfToken,
      };
    },
    async restoreSession(clientId, sessionId, secret) {
      const record = await getRemoteSession(config, sessionId);
      if (!record || record.secret !== secret || record.clientId !== clientId) {
        return null;
      }

      appendAuditEvent(record, {
        route: "session",
        action: "session_restored",
        outcome: "accepted",
        detail: "Restored an existing session.",
        statusCode: 200,
      });
      await persistRemoteSession(config, record);
      return {
        sessionId: record.sessionId,
        secret: record.secret,
        csrfToken: record.csrfToken,
      };
    },
    async validateSession(sessionId, secret, clientId, csrfToken) {
      const record = await getRemoteSession(config, sessionId);
      if (!record || record.secret !== secret || record.clientId !== clientId) {
        return false;
      }
      if (csrfToken && record.csrfToken !== csrfToken) {
        return false;
      }
      return true;
    },
    async registerSessionRequest(sessionId, conversationChars = 0) {
      const record = await getRemoteSession(config, sessionId);
      if (!record) {
        throw new SessionStoreError("Unknown session.", 404);
      }

      const now = Date.now();
      record.requestTimestamps = record.requestTimestamps.filter(
        (timestamp) => now - timestamp < RATE_WINDOW_MS,
      );

      if (record.requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
        throw new SessionStoreError("Rate limit exceeded for this session.", 429);
      }

      if (record.llmTurnCount >= MAX_LLM_TURNS_PER_SESSION) {
        throw new SessionStoreError(
          `Session exceeded the ${MAX_LLM_TURNS_PER_SESSION} turn quota.`,
          429,
        );
      }

      if (
        record.consumedConversationChars + conversationChars >
        MAX_CONVERSATION_CHARS_PER_SESSION
      ) {
        throw new SessionStoreError(
          `Session exceeded the ${MAX_CONVERSATION_CHARS_PER_SESSION} character conversation quota.`,
          429,
        );
      }

      record.requestTimestamps.push(now);
      record.llmTurnCount += 1;
      record.consumedConversationChars += Math.max(0, conversationChars);
      await persistRemoteSession(config, record);
    },
    async registerSessionRun(sessionId, runId) {
      const record = await getRemoteSession(config, sessionId);
      if (!record) {
        throw new SessionStoreError("Unknown session.", 404);
      }

      if (!isValidRunId(runId)) {
        throw new SessionStoreError("Invalid run id.", 400);
      }

      const owner = await executeRedisCommand(config, ["GET", remoteRunOwnerKey(config, runId)]);
      if (typeof owner === "string" && owner && owner !== sessionId) {
        throw new SessionStoreError("Run id belongs to another session.", 409);
      }

      const now = Date.now();
      record.runs.set(runId, { runId, lastSeenAt: now });
      const runsBeforeTrim = new Set(record.runs.keys());
      trimOldRuns(record);
      const removedRunIds = Array.from(runsBeforeTrim).filter(
        (existingRunId) => !record.runs.has(existingRunId),
      );
      appendAuditEvent(record, {
        route: "llm",
        action: "run_registered",
        outcome: "accepted",
        detail: "Registered the run id for this session.",
        runId,
        statusCode: 200,
      });

      await persistRemoteSession(config, record);
      await executeRedisCommand(config, [
        "SET",
        remoteRunOwnerKey(config, runId),
        sessionId,
        "EX",
        sessionTtlSeconds(),
      ]);

      for (const removedRunId of removedRunIds) {
        await executeRedisCommand(config, ["DEL", remoteRunOwnerKey(config, removedRunId)]);
      }
    },
    async recordSessionAuditEvent(sessionId, event) {
      const record = await getRemoteSession(config, sessionId);
      if (!record) {
        return false;
      }

      appendAuditEvent(record, event);
      await persistRemoteSession(config, record);
      return true;
    },
    async getSessionAuditEvents(sessionId) {
      const record = await getRemoteSession(config, sessionId);
      return record ? [...record.auditEvents] : [];
    },
  };
}

function getSessionStoreBackend(): SessionStoreBackend {
  const redisConfig = getConfiguredRedisSessionStore();
  if (redisConfig) {
    return remoteSessionStore(redisConfig);
  }

  return localSessionStore();
}

export async function createSession(clientId: string) {
  return getSessionStoreBackend().createSession(clientId);
}

export async function restoreSession(clientId: string, sessionId: string, secret: string) {
  return getSessionStoreBackend().restoreSession(clientId, sessionId, secret);
}

export async function validateSession(
  sessionId: string,
  secret: string,
  clientId: string,
  csrfToken?: string,
) {
  return getSessionStoreBackend().validateSession(sessionId, secret, clientId, csrfToken);
}

export async function registerSessionRequest(sessionId: string, conversationChars = 0) {
  return getSessionStoreBackend().registerSessionRequest(sessionId, conversationChars);
}

export async function registerSessionRun(sessionId: string, runId: string) {
  return getSessionStoreBackend().registerSessionRun(sessionId, runId);
}

export async function recordSessionAuditEvent(
  sessionId: string,
  event: SessionAuditEventInput,
) {
  return getSessionStoreBackend().recordSessionAuditEvent(sessionId, event);
}

export async function getSessionAuditEventsForTests(sessionId: string) {
  return getSessionStoreBackend().getSessionAuditEvents(sessionId);
}

export function resetSessionStoreForTests() {
  sessions.clear();
  runOwners.clear();
  if (loadedStoreFile) {
    rmSync(loadedStoreFile, { force: true });
  }
  loadedStoreFile = undefined;
}

export function reloadSessionStoreFromDiskForTests() {
  sessions.clear();
  runOwners.clear();
  loadedStoreFile = undefined;
  syncSessionStoreConfiguration();
}
