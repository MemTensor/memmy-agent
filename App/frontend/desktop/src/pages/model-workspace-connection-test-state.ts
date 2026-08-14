import type { ModelConnection } from "../state/model-workspace.js";

export const MODEL_CONNECTION_TEST_STATE_STORAGE_KEY = "memmy.modelWorkspace.connectionTests.v1";

export type StoredConnectionTestStatus = "success" | "error";

export interface StoredConnectionTestState {
  status: StoredConnectionTestStatus;
  signature: string;
}

export function connectionTestSignature(connection: ModelConnection): string {
  const models = connection.modelEntries
    .map((entry) => ({
      presetId: entry.presetId,
      model: entry.model.trim(),
      capabilities: [...entry.capabilities].sort()
    }))
    .sort((left, right) => (
      left.presetId.localeCompare(right.presetId)
      || left.model.localeCompare(right.model)
    ));
  return JSON.stringify({
    provider: connection.provider,
    endpointId: connection.endpointId,
    endpoint: connection.endpoint.trim().replace(/\/+$/, ""),
    protocol: connection.protocol,
    apiKeyMasked: connection.apiKeyMasked.trim(),
    models
  });
}

export function readConnectionTestStates(
  connections: readonly ModelConnection[],
  storage?: Pick<Storage, "getItem">
): Record<string, StoredConnectionTestState> {
  const stored = readStoredStates(storage);
  return Object.fromEntries(connections.flatMap((connection) => {
    const state = stored[connection.id];
    return state?.signature === connectionTestSignature(connection)
      ? [[connection.id, state]]
      : [];
  }));
}

export function writeConnectionTestState(
  connection: ModelConnection,
  status: StoredConnectionTestStatus,
  storage?: Pick<Storage, "getItem" | "setItem">
): void {
  if (!storage) return;
  const states = readStoredStates(storage);
  states[connection.id] = { status, signature: connectionTestSignature(connection) };
  try {
    storage.setItem(MODEL_CONNECTION_TEST_STATE_STORAGE_KEY, JSON.stringify(states));
  } catch {
    // Losing this session-only UI hint must not block saving the model catalog.
  }
}

export function removeConnectionTestState(
  connectionId: string,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
): void {
  if (!storage) return;
  const states = readStoredStates(storage);
  if (!(connectionId in states)) return;
  delete states[connectionId];
  try {
    if (Object.keys(states).length > 0) {
      storage.setItem(MODEL_CONNECTION_TEST_STATE_STORAGE_KEY, JSON.stringify(states));
    } else {
      storage.removeItem(MODEL_CONNECTION_TEST_STATE_STORAGE_KEY);
    }
  } catch {
    // Losing this session-only UI hint must not block catalog mutations.
  }
}

function readStoredStates(storage?: Pick<Storage, "getItem">): Record<string, StoredConnectionTestState> {
  try {
    const raw = storage?.getItem(MODEL_CONNECTION_TEST_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([connectionId, value]) => (
      isStoredConnectionTestState(value) ? [[connectionId, value]] : []
    )));
  } catch {
    return {};
  }
}

function isStoredConnectionTestState(value: unknown): value is StoredConnectionTestState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredConnectionTestState>;
  return (candidate.status === "success" || candidate.status === "error")
    && typeof candidate.signature === "string";
}
