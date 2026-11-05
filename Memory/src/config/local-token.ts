import { randomBytes } from "node:crypto";
import { loadMemmyConfig } from "./index.js";
import { mutateMemoryConfig } from "./writer.js";

/** Establish one persistent credential before any local HTTP listener or adapter starts. */
export async function ensureLocalMemoryToken(configPath: string, persistForLauncher = false): Promise<string> {
  const { config } = loadMemmyConfig(configPath);
  const configured = config.storage.token?.trim();
  const override = process.env.MEMMY_MEMORY_TOKEN?.trim() || process.env.MEMORY_SERVICE_TOKEN?.trim();
  if (configured && !(persistForLauncher && override)) return configured;
  if (!configured && (config.storage.mode !== "local" || config.storage.backend !== "sqlite")) {
    throw new Error("Memory service requires a configured storage token for non-local storage");
  }
  let token = "";
  await mutateMemoryConfig(configPath, (root) => {
    const memory = record(root.memmyMemory);
    const storage = record(memory.storage);
    // Re-read under the shared config lock: another initializer may have won.
    token = typeof storage.token === "string" ? storage.token.trim() : "";
    if (persistForLauncher && token && override && token !== override) {
      throw new Error("Memory service registration requires the environment token to match the shared config");
    }
    if (!token) storage.token = token = override || randomBytes(32).toString("hex");
    memory.storage = storage;
    root.memmyMemory = memory;
  });
  return token;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
