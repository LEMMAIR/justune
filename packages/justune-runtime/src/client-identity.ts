const CLIENT_ID_STORAGE_KEY = "justune.client-id";

function canUseStorage() {
  return (
    typeof window !== "undefined" &&
    typeof window.localStorage !== "undefined" &&
    typeof window.localStorage.getItem === "function" &&
    typeof window.localStorage.setItem === "function"
  );
}

export function getOrCreateClientId() {
  if (!canUseStorage()) {
    return `client_${crypto.randomUUID()}`;
  }

  try {
    const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const clientId = `client_${crypto.randomUUID()}`;
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
    return clientId;
  } catch {
    return `client_${crypto.randomUUID()}`;
  }
}
