import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeRecord } from "../../adapters/outbound/plugin-runtime/index.js";
import { createPluginAssetKeyService } from "../plugin-asset-key-service.js";

describe("plugin asset key authorization", () => {
  let root: string;
  const asset = { file: "assets/template.docx.enc", keyId: "test-key", sha256: "a".repeat(64), wrappedKey: "A".repeat(512) };
  const index = { format: "memmy-asset-seal-v1", pluginId: "legal-labor", version: "0.1.0-test", assets: { "assets/template.docx": asset } };
  const call = { pluginId: "legal-labor", callId: "call", conversationId: "conversation", service: "asset-key", input: { assetPath: "assets/template.docx" } };
  const key = Buffer.alloc(32, 7).toString("base64");
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "memmy-asset-service-")); writeFileSync(join(root, "asset-seal.json"), JSON.stringify(index)); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function setup(status = 200) {
    const plugin = { id: "legal-labor", version: "0.1.0-test", state: "active", rootPath: root, manifest: { requiredEntitlement: "plugin:legal-labor" } } as PluginRuntimeRecord;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ key }), { status }));
    const authHeaders = vi.fn(() => ({ authorization: "Bearer account-credential" }));
    const isEntitlementGranted = vi.fn(() => true);
    const service = createPluginAssetKeyService({ baseUrl: "https://test-api.memmy.cn", getPlugin: () => plugin, authHeaders, isEntitlementGranted, fetch });
    return { service, fetch, plugin, authHeaders, isEntitlementGranted };
  }
  it("uses installed metadata and account credentials instead of caller-supplied envelope", async () => {
    const s = setup();
    await expect(s.service.invoke({...call,input:{...call.input,wrappedKey:"forged"}})).resolves.toEqual({key});
    const [url, request] = s.fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://test-api.memmy.cn/api/v1/plugins/legal-labor/asset-key");
    expect(JSON.parse(request!.body as string)).toEqual({version:index.version,assetPath:"assets/template.docx",keyId:asset.keyId,sha256:asset.sha256,wrappedKey:asset.wrappedKey});
    expect(request!.redirect).toBe("error");
  });
  it.each([401,403])("honors cloud authorization failure HTTP %s despite stale local grants", async (status) => {
    await expect(setup(status).service.invoke(call)).rejects.toMatchObject({code:"plugin_entitlement_required"});
  });
  it("refuses revoked local grants, disabled plugin and missing credentials before networking", async () => {
    for (const mutate of [(s:ReturnType<typeof setup>)=>s.isEntitlementGranted.mockReturnValue(false),
      (s:ReturnType<typeof setup>)=>{s.plugin.state="disabled";},
      (s:ReturnType<typeof setup>)=>s.authHeaders.mockReturnValue({authorization:""})]) {
      const s=setup();mutate(s);await expect(s.service.invoke(call)).rejects.toMatchObject({code:"plugin_entitlement_required"});expect(s.fetch).not.toHaveBeenCalled();
    }
  });
  it("rejects unknown asset, traversal, and mismatched releases", async () => {
    const s=setup();
    await expect(s.service.invoke({...call,input:{assetPath:"assets/other.docx"}})).rejects.toMatchObject({code:"plugin_invalid"});
    await expect(s.service.invoke({...call,input:{assetPath:"assets/../../private"}})).rejects.toThrow();
    writeFileSync(join(root,"asset-seal.json"),JSON.stringify({...index,version:"other"}));
    await expect(s.service.invoke(call)).rejects.toMatchObject({code:"plugin_invalid"});expect(s.fetch).not.toHaveBeenCalled();
  });
  it("rejects symlinked metadata", async () => {
    const s=setup();writeFileSync(join(root,"outside.json"),JSON.stringify(index));rmSync(join(root,"asset-seal.json"));symlinkSync(join(root,"outside.json"),join(root,"asset-seal.json"));
    await expect(s.service.invoke(call)).rejects.toMatchObject({code:"plugin_invalid"});expect(s.fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed, oversized and unavailable key responses", async () => {
    const s=setup();
    for (const body of [JSON.stringify({key:"short"}),"x".repeat(3000),"not-json"]) {
      s.fetch.mockImplementation(async()=>new Response(body));await expect(s.service.invoke(call)).rejects.toMatchObject({code:"asset_key_unavailable"});
    }
    await expect(setup(503).service.invoke(call)).rejects.toMatchObject({code:"asset_key_unavailable"});
  });
  it("does not forward cancelled requests", async () => {
    const s=setup();const controller=new AbortController();controller.abort();
    await expect(s.service.invoke({...call,signal:controller.signal})).rejects.toThrow();expect(s.fetch).not.toHaveBeenCalled();
  });
});
