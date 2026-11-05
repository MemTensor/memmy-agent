import { DEFAULT_MEMORY_URL, resolveMemoryConnection, sameHttpOrigin } from "@memmy/agent-source-core/memory-connection";
import { randomBytes } from "node:crypto";
import { loadMemmyConfig } from "./index.js";
import { mutateMemoryConfig } from "./writer.js";

/** Establish one persistent credential before any local HTTP listener or adapter starts. */
export async function ensureLocalMemoryToken(
  configPath: string, persistForLauncher = false, request?: { endpoint?: string; token?: string }
): Promise<string> {
  // Read the endpoint from disk before considering credentials from the calling shell.
  const { config } = loadMemmyConfig(configPath, {});
  const configured = config.storage.token;
  const fileEndpoint = config.storage.endpoint ?? DEFAULT_MEMORY_URL;
  const requestedEndpoint = request?.endpoint ?? fileEndpoint;
  const requestedToken = request?.token?.trim();
  function credentialForFile(endpoint: string, storedToken: string | undefined): string | undefined {
    if (requestedToken && sameHttpOrigin(requestedEndpoint, endpoint)) return requestedToken;
    return environmentTokenForFile(fileEndpoint, endpoint, storedToken);
  }
  const override = credentialForFile(fileEndpoint, configured);
  if (configured && !(persistForLauncher && override)) return override || configured;
  if (override && !persistForLauncher && !requestedToken) return override;
  if (!configured && !override && (config.storage.mode !== "local" || config.storage.backend !== "sqlite")) {
    throw new Error("Memory service requires a configured storage token for non-local storage");
  }
  let token = "";
  await mutateMemoryConfig(configPath, (root) => {
    const memory = record(root.memmyMemory);
    const storage = record(memory.storage);
    // Re-read under the shared config lock: another initializer may have won.
    token = text(storage.token) || text(memory.token);
    const endpoint = text(storage.endpoint) || text(memory.endpoint) || DEFAULT_MEMORY_URL;
    const override = credentialForFile(endpoint, token);
    if (persistForLauncher && token && override && token !== override) {
      throw new Error("Memory service registration requires the environment token to match the shared config");
    }
    if (!token) storage.token = token = override || randomBytes(32).toString("hex");
    memory.storage = storage;
    root.memmyMemory = memory;
  });
  return token;
}

function environmentTokenForFile(fileEndpoint: string, endpoint: string, storedToken: string | undefined): string | undefined {
  const { token } = resolveMemoryConnection(fileEndpoint, undefined, process.env, endpoint);
  if (!token && !storedToken && (process.env.MEMMY_MEMORY_TOKEN?.trim() || process.env.MEMORY_SERVICE_TOKEN?.trim())) {
    throw new Error("Memory requires a credential for the configured endpoint; the environment token belongs to another origin");
  }
  return token;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
