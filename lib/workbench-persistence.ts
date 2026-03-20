import type {
  LlmResponseBody,
  SessionResponse,
  ToolInput,
  ToolName,
} from "@/lib/protocol";
import type { FileChange } from "@/lib/justune-browser-sandbox";

export interface PersistedToolLogEntry {
  id: string;
  tool: ToolName;
  toolCallId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  input: ToolInput;
  resultPreview?: string;
  status: "running" | "completed" | "failed";
}

export interface PersistedWorkbenchState {
  version: 1;
  prompt: string;
  messages: unknown[];
  logs: PersistedToolLogEntry[];
  changes: FileChange[];
  workspaceFiles: Record<string, string>;
  workspacePaths: string[];
  runCount: number;
  lastMode: LlmResponseBody["mode"] | null;
  queuedPrompts: string[];
  interruptedRun: boolean;
  session: Pick<SessionResponse, "clientId" | "sessionId" | "sessionSecret" | "csrfToken"> | null;
}

const DATABASE_NAME = "justune-workbench";
const STORE_NAME = "state";
const STATE_KEY = "primary";

function canUseIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore) => void,
  readResult?: () => T,
): Promise<T> {
  const database = await openDatabase();

  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);

    transaction.oncomplete = () => {
      database.close();
      resolve(readResult ? readResult() : (undefined as T));
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    };

    handler(store);
  });
}

export async function loadPersistedWorkbenchState(): Promise<PersistedWorkbenchState | null> {
  if (!canUseIndexedDb()) {
    return null;
  }

  let result: PersistedWorkbenchState | null = null;
  await withStore(
    "readonly",
    (store) => {
      const request = store.get(STATE_KEY);
      request.onsuccess = () => {
        const value = request.result;
        if (value && value.version === 1) {
          result = value as PersistedWorkbenchState;
        }
      };
    },
    () => result,
  );

  return result;
}

export async function savePersistedWorkbenchState(
  state: PersistedWorkbenchState,
): Promise<void> {
  if (!canUseIndexedDb()) {
    return;
  }

  await withStore("readwrite", (store) => {
    store.put(state, STATE_KEY);
  });
}

export async function clearPersistedWorkbenchState(): Promise<void> {
  if (!canUseIndexedDb()) {
    return;
  }

  await withStore("readwrite", (store) => {
    store.delete(STATE_KEY);
  });
}
