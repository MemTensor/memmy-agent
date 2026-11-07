import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function readAdapterConnection(adapterUrl) {
  const metadata = new URL("./memmy-memory-config.json", adapterUrl);
  const configPath = process.env.MEMMY_CONFIG?.trim()
    || JSON.parse(await readOptional(metadata) || "{}").memmy_config_path
    || join(homedir(), ".memmy", "config.yaml");
  const config = parse(await readOptional(configPath));
  const storage = config?.memmyMemory?.storage;
  const configuredEndpoint = (storage?.endpoint || "http://127.0.0.1:18960").replace(/\/+$/, "");
  const endpoint = (process.env.MEMMY_MEMORY_URL?.trim() || configuredEndpoint).replace(/\/+$/, "");
  const token = process.env.MEMMY_MEMORY_TOKEN?.trim() || process.env.MEMORY_SERVICE_TOKEN?.trim()
    || (endpoint === configuredEndpoint ? storage?.token?.trim() : "");
  return { endpoint, token };
}
