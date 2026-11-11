import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config, ModelEndpointConfig } from "../../src/config/schema.js";
import { buildProviderSnapshot, makeProvider, providerSignature } from "../../src/providers/factory.js";
import { resolveModelSelection } from "../../src/providers/model-catalog.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { makeReloadingProviderSnapshotLoader } from "../../src/providers/snapshot-loader.js";
const roots: string[] = [];
function data(inherit: boolean | undefined, ownKey?: string): any {
  return { app: { userMode: "byok" }, agents: { defaults: { modelPreset: "independent" } },
    providers: { openai: { apiKey: "cloud-fixture-token", extraHeaders: { Authorization: "Bearer cloud-header", "X-Cloud": "unrelated" },
      extraBody: { model: "wrong-cloud-model", cloudOption: true }, endpoints: {
        independent: { apiBase: "https://local-fixture.example/v1", protocol: "openai-chat-completions",
          ...(inherit === undefined ? {} : { inheritProviderDefaults: inherit }), ...(ownKey === undefined ? {} : { apiKey: ownKey }),
          extraHeaders: { "X-Own": "preserved" }, extraBody: { ownOption: true } },
        inherited: { apiBase: "https://cloud-fixture.example/v1", protocol: "openai-chat-completions" } } } },
    modelPresets: {
      independent: { provider: "openai", endpoint: "independent", model: "local-fixture-model", source: "byok", capabilities: ["agent", "memory_summary"] },
      inherited: { provider: "openai", endpoint: "inherited", model: "cloud-fixture-model", source: "byok", capabilities: ["agent"] } },
    modelAssignments: { byok: { agent: { candidates: ["independent", "inherited"], default: "independent" }, memorySummary: "independent" } } };
}
function writeConfig(value: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-endpoint-defaults-")); roots.push(root);
  const file = path.join(root, "config.yaml"); fs.writeFileSync(file, YAML.stringify(value)); return file;
}
function anthropicData(key?: string) {
  const input = data(false, key), provider = input.providers.openai;
  provider.endpoints.independent.protocol = "anthropic-messages"; provider.endpoints.inherited.protocol = "anthropic-messages";
  input.providers = { anthropic: provider };
  input.modelPresets.independent.provider = "anthropic"; input.modelPresets.inherited.provider = "anthropic";
  return input;
}
function mockHttp() {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const url = String(input); requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (JSON.parse(String(init?.body)).stream) {
      if (url.includes("/messages")) {
        const events = [
          { type: "message_start", message: { id: "msg-test", role: "assistant", model: "local-fixture-model", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" },
        ];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = url.includes("/messages") ? { id: "msg-test", type: "message", role: "assistant", model: "local-fixture-model", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      : url.endsWith("/responses") ? { id: "resp-test", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], status: "completed", usage: { input_tokens: 1, output_tokens: 1 } }
      : { id: "chat-test", object: "chat.completion", choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  })); return requests;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe("endpoint inheritance and actual Agent provider requests", () => {
  it.each([false, true, undefined])("retains optional boolean %s through config serialization", inherit => {
    const config = new Config(data(inherit)), serialized = config.toObject(), endpoint = (serialized.providers as any).openai.endpoints.independent;
    expect(endpoint.inheritProviderDefaults).toBe(inherit);
    expect(new Config(serialized).providers.openai.endpoints.independent.toObject()).toEqual(endpoint);
  });
  it.each([null, "false", 0, {}])("rejects non-boolean endpoint inheritance %s", value => {
    expect(() => new ModelEndpointConfig({ apiBase: "https://fixture.example/v1", protocol: "openai-chat-completions", inheritProviderDefaults: value })).toThrow(/boolean/);
  });
  it.each(["own-fixture-token", undefined, ""])("sends only independent credentials/options (own key %s)", async key => {
    vi.stubEnv("OPENAI_API_KEY", "environment-fixture-token"); vi.stubEnv("OPENAI_ADMIN_KEY", "environment-admin-token");
    vi.stubEnv("OPENAI_ORG_ID", "environment-org"); vi.stubEnv("OPENAI_PROJECT_ID", "environment-project");
    const requests = mockHttp(), config = new Config(data(false, key)), provider = makeProvider(config) as OpenAICompatProvider;
    expect(provider.apiKey ?? null).toBe(key || null);
    expect(config.getApiKey(null, { preset: config.modelPresets.independent })).toBe(key || null);
    expect(provider.extraHeaders).toEqual({ "X-Own": "preserved" }); expect(provider.extraBody).toEqual({ ownOption: true });
    expect((await provider.chat({ messages: [{ role: "user", content: "synthetic" }] })).finishReason).toBe("stop");
    expect(requests).toHaveLength(1); const request = requests[0]!;
    expect(request.headers.get("authorization")).toBe(key ? `Bearer ${key}` : null);
    expect(request.headers.get("api-key")).toBeNull(); expect(request.headers.get("X-Cloud")).toBeNull();
    expect(request.headers.get("openai-organization")).toBeNull(); expect(request.headers.get("openai-project")).toBeNull();
    expect(request.headers.get("X-Own")).toBe("preserved"); expect(request.body).toMatchObject({ model: "local-fixture-model", ownOption: true });
    expect(request.body).not.toHaveProperty("cloudOption");
    if (!key) { expect(provider.apiKeyForClient).toBeNull(); expect(provider.client.apiKey).toBeNull(); }
  });
  it("keeps endpoint Authorization when independent key authentication is absent", async () => {
    vi.stubEnv("OPENAI_ORG_ID", "environment-org"); vi.stubEnv("OPENAI_PROJECT_ID", "environment-project");
    const input = data(false); input.providers.openai.endpoints.independent.extraHeaders.Authorization = "Bearer own-header";
    input.providers.openai.endpoints.independent.extraHeaders["OpenAI-Organization"] = "own-org";
    input.providers.openai.endpoints.independent.extraHeaders["OpenAI-Project"] = "own-project";
    const requests = mockHttp(); await makeProvider(new Config(input)).chat({ messages: [{ role: "user", content: "synthetic" }] });
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer own-header"); expect(requests[0]!.headers.get("X-Cloud")).toBeNull();
    expect(requests[0]!.headers.get("openai-organization")).toBe("own-org"); expect(requests[0]!.headers.get("openai-project")).toBe("own-project");
  });
  it("does not export an independent endpoint key into other providers' environment fallback", () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(makeProvider(new Config(data(false, "own-fixture-token"))).apiKey).toBe("own-fixture-token");
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
  it("keeps both Responses and streaming Chat requests unauthenticated", async () => {
    vi.stubEnv("OPENAI_API_KEY", "environment-fixture-token"); const requests = mockHttp();
    const responses = data(false); responses.providers.openai.endpoints.independent.protocol = "openai-responses";
    expect((await makeProvider(new Config(responses)).chat({ messages: [{ role: "user", content: "synthetic" }] })).content).toBe("OK");
    expect((await makeProvider(new Config(data(false))).chatStream({ messages: [{ role: "user", content: "synthetic" }] })).content).toBe("OK");
    expect(requests.map(request => request.url)).toEqual(["https://local-fixture.example/v1/responses", "https://local-fixture.example/v1/chat/completions"]);
    for (const request of requests) expect(request.headers.get("authorization")).toBeNull();
  });
  it("forwards caller cancellation without retrying independent no-auth requests", async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const request = vi.fn(async (_input: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBeNull(); entered();
      return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    }); vi.stubGlobal("fetch", request);
    const abort = new AbortController(), running = makeProvider(new Config(data(false))).chat({ messages: [{ role: "user", content: "synthetic" }], signal: abort.signal });
    await started; abort.abort(); const result = await running;
    expect(result.finishReason).toBe("error"); expect(result.content).toMatch(/abort/i); expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["own-anthropic-token", undefined])("keeps Anthropic requests independent of defaults and environment (key %s)", async key => {
    vi.stubEnv("ANTHROPIC_API_KEY", "environment-anthropic-token"); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "environment-auth-token");
    const input = anthropicData(key);
    const requests = mockHttp(), actual = makeProvider(new Config(input));
    const response = await actual.chat({ messages: [{ role: "user", content: "synthetic" }], maxTokens: 64 });
    expect(response.finishReason, response.content ?? "no response").toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("x-api-key")).toBe(key ?? null);
    expect(requests[0]!.headers.get("authorization")).toBeNull();
    expect(requests[0]!.headers.get("X-Cloud")).toBeNull();
    expect(requests[0]!.body.model).toBe("local-fixture-model");
    expect(requests[0]!.body).not.toHaveProperty("cloudOption");
  });
  it.each(["chat", "chatStream"] as const)("executes independent Anthropic %s without any environment key, including explicit header authentication", async method => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
    const requests = mockHttp();
    for (const ownHeader of [false, true]) {
      const input = anthropicData();
      if (ownHeader) input.providers.anthropic.endpoints.independent.extraHeaders.Authorization = "Bearer own-anthropic-header";
      const result = await makeProvider(new Config(input))[method]({ messages: [{ role: "user", content: "synthetic" }], maxTokens: 64 });
      expect(result.finishReason, result.content ?? "no response").toBe("stop"); expect(result.content).toBe("OK");
      const request = requests.at(-1)!;
      expect(request.headers.get("x-api-key")).toBeNull();
      expect(request.headers.get("authorization")).toBe(ownHeader ? "Bearer own-anthropic-header" : null);
      expect(request.headers.get("X-Cloud")).toBeNull();
    }
    expect(requests).toHaveLength(2);
  });
  it.each(["chat", "chatStream"] as const)("does not send pre-cancelled independent Anthropic %s", async method => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
    const requests = mockHttp(), abort = new AbortController(); abort.abort();
    await expect(makeProvider(new Config(anthropicData()))[method]({ messages: [{ role: "user", content: "synthetic" }], maxTokens: 64, signal: abort.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(0);
  });
  it("keeps the existing Anthropic missing-key rejection when inheritance is enabled", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
    const input = anthropicData(); delete input.providers.anthropic.apiKey;
    delete input.providers.anthropic.endpoints.independent.inheritProviderDefaults;
    const requests = mockHttp(), provider = makeProvider(new Config(input));
    expect((await provider.chat({ messages: [{ role: "user", content: "synthetic" }], maxTokens: 64 })).content).toMatch(/missing Anthropic API key/);
    expect(requests).toHaveLength(0);
  });
  it.each([undefined, true])("preserves default inheritance %s and provider key rotation", inherit => {
    const input = data(inherit), first = buildProviderSnapshot(new Config(input)), rotated = structuredClone(input);
    rotated.providers.openai.apiKey = "rotated-cloud-token"; rotated.providers.openai.extraHeaders["X-Cloud"] = "rotated";
    const second = buildProviderSnapshot(new Config(rotated));
    expect(first.provider.apiKey).toBe("cloud-fixture-token"); expect(second.provider.apiKey).toBe("rotated-cloud-token");
    expect((second.provider as OpenAICompatProvider).extraHeaders["X-Cloud"]).toBe("rotated"); expect(second.signature).not.toEqual(first.signature);
  });
  it("keeps independent signatures stable across unrelated default rotation", () => {
    const first = data(false, "own-fixture-token"), second = structuredClone(first);
    second.providers.openai.apiKey = "rotated-cloud-token"; second.providers.openai.extraBody.model = "rotated-model";
    expect(providerSignature(new Config(second))).toEqual(providerSignature(new Config(first)));
    first.agents.defaults.fallbackModels = ["inherited"]; second.agents.defaults.fallbackModels = ["inherited"];
    expect(providerSignature(new Config(second))).not.toEqual(providerSignature(new Config(first)));
  });
  it("applies independent options when constructing a fallback", () => {
    const input = data(false, "own-fixture-token"); input.agents.defaults.modelPreset = "inherited"; input.agents.defaults.fallbackModels = ["independent"];
    const snapshot = buildProviderSnapshot(new Config(input));
    const fallback = (snapshot.provider as any).providerFactory(new Config(input).modelPresets.independent);
    expect(fallback.apiKey).toBe("own-fixture-token"); expect(fallback.extraHeaders).toEqual({ "X-Own": "preserved" });
    expect(fallback.extraBody).toEqual({ ownOption: true });
  });
  it("preserves independent options in catalog selection and reloaded snapshots", () => {
    const configPath = writeConfig(data(false)), selection = resolveModelSelection({ configPath, capability: "memory_summary" });
    expect(selection).not.toBeNull(); expect(selection!.providerConfig.apiKey).toBeUndefined();
    expect(selection!.providerConfig.extraHeaders).toEqual({ "X-Own": "preserved" }); expect(selection!.providerConfig.extraBody).toEqual({ ownOption: true });
    expect(selection!.snapshot.provider.apiKey).toBeNull();
    const loader = makeReloadingProviderSnapshotLoader({ configPath }), first = loader();
    fs.writeFileSync(configPath, YAML.stringify(data(true, "own-fixture-token"))); const second = loader();
    expect((first.provider as OpenAICompatProvider).extraBody).toEqual({ ownOption: true });
    expect((second.provider as OpenAICompatProvider).extraBody).toMatchObject({ cloudOption: true }); expect(second.signature).not.toEqual(first.signature);
  });
});
