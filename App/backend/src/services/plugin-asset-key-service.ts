/** Authorizes encrypted plugin assets through the account cloud; keys never persist. */
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PluginHostServiceInvoker, PluginRuntimeRecord } from "../adapters/outbound/plugin-runtime/index.js";

const Input = z.object({ assetPath: z.string().regex(/^assets\/[a-zA-Z0-9._-]+$/) });
const Asset = z.object({ file: z.string(), keyId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), wrappedKey: z.string().min(64).max(2048) });
const Index = z.object({ format: z.literal("memmy-asset-seal-v1"), pluginId: z.string(), version: z.string(), assets: z.record(z.string(), Asset) });
const Key = z.object({ key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) });
export function createPluginAssetKeyService(options: {
  baseUrl: string;
  getPlugin(id: string): PluginRuntimeRecord | null;
  authHeaders(): Record<string, string>;
  isEntitlementGranted(entitlement: string): boolean;
  fetch?: typeof fetch;
}): PluginHostServiceInvoker {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error("Asset key service requires HTTPS");
  return { async invoke(call) {
    call.signal?.throwIfAborted();
    if (call.service !== "asset-key") throw failure("host_service_unavailable");
    const input = Input.parse(call.input);
    const plugin = options.getPlugin(call.pluginId);
    if (!plugin?.rootPath || plugin.state !== "active" || !plugin.manifest.requiredEntitlement
      || !options.isEntitlementGranted(plugin.manifest.requiredEntitlement)) throw failure("plugin_entitlement_required");
    const headers = options.authHeaders();
    if (!headers.authorization) throw failure("plugin_entitlement_required");
    const root = await realpath(plugin.rootPath);
    const indexPath = join(root, "asset-seal.json");
    if (await realpath(indexPath) !== indexPath || (await stat(indexPath)).size > 64 * 1024) throw failure("plugin_invalid");
    const index = Index.parse(JSON.parse(await readFile(indexPath, "utf8")));
    const asset = index.assets[input.assetPath];
    if (index.pluginId !== plugin.id || index.version !== plugin.version || !asset || asset.file !== input.assetPath + ".enc") throw failure("plugin_invalid");
    const timeout = AbortSignal.timeout(15_000);
    const response = await (options.fetch ?? fetch)(new URL(`/api/v1/plugins/${encodeURIComponent(plugin.id)}/asset-key`, base), {
      method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ version: plugin.version, assetPath: input.assetPath, keyId: asset.keyId, sha256: asset.sha256, wrappedKey: asset.wrappedKey }),
      redirect: "error", signal: call.signal ? AbortSignal.any([call.signal, timeout]) : timeout
    });
    if (response.status === 401 || response.status === 403) throw failure("plugin_entitlement_required");
    if (!response.ok) throw failure("asset_key_unavailable");
    let text = "";
    if (!response.body) throw failure("asset_key_unavailable");
    for await (const chunk of response.body) {
      text += Buffer.from(chunk).toString("utf8");
      if (Buffer.byteLength(text) > 2048) throw failure("asset_key_unavailable");
    }
    try { return Key.parse(JSON.parse(text)); }
    catch { throw failure("asset_key_unavailable"); }
  } };
}
function failure(code: string): Error {
  return Object.assign(new Error(code === "plugin_entitlement_required" ? "Plugin asset access requires account authorization" : "Plugin asset key unavailable"), { code, retryable: false });
}
