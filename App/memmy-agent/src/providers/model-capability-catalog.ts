import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ModelCapabilityCatalogSchema,
  ModelCapabilityCatalogRefreshResultSchema,
  RuntimeConfigSchema,
  type ModelCapabilityCatalog,
} from "@memmy/local-api-contracts";

export type RuntimeModelCapabilityCatalogState =
  | { mode: "catalog"; catalog: Readonly<ModelCapabilityCatalog> }
  | { mode: "provider-fallback"; catalog: null };

export class ModelCapabilityCatalogUnavailableError extends Error {
  readonly code = "model_catalog_unavailable";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ModelCapabilityCatalogUnavailableError";
  }
}

export function resolveRuntimeModelCapabilityCatalogPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".memmy", "models.json");
}

export function readRuntimeModelCapabilityCatalog(
  filePath = resolveRuntimeModelCapabilityCatalogPath(),
): Readonly<ModelCapabilityCatalog> | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const result = ModelCapabilityCatalogSchema.safeParse(value);
  return result.success ? freeze(result.data) : null;
}

/** Used at startup and turn boundaries; the returned snapshot belongs to that invocation. */
export function createRuntimeModelCapabilityCatalog(options: {
  catalogPath?: string;
  runtimeConfigPath?: string;
  fetchImpl?: typeof fetch;
} = {}) {
  const catalogPath = options.catalogPath ?? resolveRuntimeModelCapabilityCatalogPath();
  const runtimeConfigPath = options.runtimeConfigPath ?? path.join(os.homedir(), ".memmy", "runtime.json");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async load(signal?: AbortSignal): Promise<RuntimeModelCapabilityCatalogState> {
      signal?.throwIfAborted();
      let readError: unknown;
      const read = () => {
        try {
          return readRuntimeModelCapabilityCatalog(catalogPath);
        } catch (error) {
          readError = error;
          return null;
        }
      };
      const local = read();
      if (local) return { mode: "catalog", catalog: local };

      try {
        const runtime = RuntimeConfigSchema.parse(JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8")));
        const baseUrl = new URL(runtime.baseUrl);
        if (baseUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname)
          || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !["", "/"].includes(baseUrl.pathname)) {
          throw new Error("Model catalog synchronization requires a local Backend");
        }
        // Four cloud requests plus 5/10/30-second waits can exceed ordinary local API timeouts.
        const timeout = AbortSignal.timeout(90_000);
        const response = await fetchImpl(new URL("/api/app/model-catalog/refresh", baseUrl), {
          method: "POST",
          headers: { "x-memmy-local-token": runtime.localToken },
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) throw new Error(`Model catalog synchronization failed with HTTP ${response.status}`);
        const result = ModelCapabilityCatalogRefreshResultSchema.parse(await response.json());
        signal?.throwIfAborted();
        const current = read();
        if (current) return { mode: "catalog", catalog: current };
        if (result.status === "retries-exhausted") return { mode: "provider-fallback", catalog: null };
        throw new ModelCapabilityCatalogUnavailableError(`Model catalog remains unavailable after ${result.status}`, readError);
      } catch (error) {
        signal?.throwIfAborted();
        const current = read();
        if (current) return { mode: "catalog", catalog: current };
        if (error instanceof ModelCapabilityCatalogUnavailableError) throw error;
        throw new ModelCapabilityCatalogUnavailableError("Unable to coordinate model catalog synchronization", error);
      }
    },
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
