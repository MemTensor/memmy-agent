/** HTTPS-backed trusted plugin registry. */
import { PluginManifestSchema } from "@memmy/local-api-contracts";
import { z } from "zod";
import type { PluginRegistry } from "./index.js";

const MAX_REGISTRY_RESPONSE_BYTES = 1024 * 1024;
const PluginReleaseSchema = z.object({
  manifest: PluginManifestSchema,
  artifact: z.object({
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i)
  }).optional()
});

export interface CreateHttpPluginRegistryOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
}

export function createHttpPluginRegistry(options: CreateHttpPluginRegistryOptions): PluginRegistry {
  const baseUrl = new URL(options.baseUrl);
  assertAllowedProtocol(baseUrl);
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);

  return {
    async resolve(pluginId, version) {
      const url = new URL(`/api/v1/plugins/${encodeURIComponent(pluginId)}`, baseUrl);
      if (version) url.searchParams.set("version", version);
      const response = await fetchFn(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000)
      });
      if (response.status === 404) {
        throw Object.assign(new Error(`Plugin release not found: ${pluginId}`), { code: "not_found" as const });
      }
      if (!response.ok) throw new Error(`Plugin registry request failed with ${response.status}`);
      const release = PluginReleaseSchema.parse(JSON.parse(await readLimitedText(response)));
      if (release.manifest.id !== pluginId || (version && release.manifest.version !== version)) {
        throw Object.assign(new Error("Plugin registry returned a different release"), { code: "plugin_invalid" });
      }
      return release;
    }
  };
}

function assertAllowedProtocol(url: URL): void {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Plugin registry must use HTTPS or loopback HTTP");
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REGISTRY_RESPONSE_BYTES) {
    throw new Error("Plugin registry response exceeded size limit");
  }
  if (!response.body) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_REGISTRY_RESPONSE_BYTES) throw new Error("Plugin registry response exceeded size limit");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
