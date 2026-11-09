import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../../../memmy-agent/src/providers/anthropic-provider.js";
import { createHttpModelConfigTester } from "../model-config-tester.js";

// Reproduces MEMMY-854 without contacting a paid provider.
describe("chat connection probes", () => {
  it.each([
    ["openai-chat-completions", "/plan/v3", "/plan/v3/chat/completions",
      { choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }],
    ["anthropic-messages", "/plan/anthropic", "/plan/anthropic/v1/messages",
      { type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" }]
  ] as const)("validates %s even when model listing returns 404", async (protocol, base, chatPath, reply) => {
    const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : {} });
      res.setHeader("Content-Type", "application/json");
      if (req.url === chatPath && req.method === "POST") res.end(JSON.stringify(reply));
      else { res.statusCode = 404; res.end(JSON.stringify({ error: { message: "not found" } })); }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing address");
      const result = await createHttpModelConfigTester().test({
        provider: "custom", endpointId: "token-plan", protocol,
        apiBase: `http://127.0.0.1:${address.port}${base}`,
        modelId: "deepseek/deepseek-flash", apiKey: "fake-test-key", capability: "chat"
      });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ path: chatPath, method: "POST", body: { model: "deepseek/deepseek-flash" } });
      expect(result.modelListed).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each(["anthropic/claude-sonnet-test", "claude-sonnet-test"])(
    "matches the Anthropic SDK request for %s without changing the saved ID", async modelId => {
      const calls: Array<{ path: string; model?: string; status: number }> = [];
      const server = createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        const body = text ? JSON.parse(text) : {};
        const status = req.headers["x-api-key"] !== "fake-test-key" ? 401
          : req.url !== "/v1/messages" || body.model !== "claude-sonnet-test" ? 404 : 200;
        calls.push({ path: req.url!, model: body.model, status });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status === 200
          ? { id: "msg_test", type: "message", role: "assistant", model: body.model,
              content: [{ type: "text", text: "OK" }], stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 } }
          : { type: "error", error: { type: "invalid_request_error", message: status === 401 ? "invalid key" : "model not found" } }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing address");
        const apiBase = `http://127.0.0.1:${address.port}`;
        const provider = new AnthropicProvider({ apiKey: "fake-test-key", apiBase, defaultModel: modelId, inheritProviderDefaults: false });
        const response = await provider.client.messages.create(provider.buildKwargs({
          model: modelId, messages: [{ role: "user", content: "Reply briefly with OK." }], maxTokens: 64
        }));
        expect(response.content[0].text).toBe("OK");
        const config = { provider: "custom" as const, endpointId: "prefix-test", protocol: "anthropic-messages" as const,
          apiBase, apiKey: "fake-test-key", modelId, capability: "chat" as const };
        const tester = createHttpModelConfigTester();
        expect((await tester.test(config)).ok).toBe(true);
        expect(calls).toEqual([
          { path: "/v1/messages", model: "claude-sonnet-test", status: 200 },
          { path: "/v1/messages", model: "claude-sonnet-test", status: 200 }
        ]);
        expect(config.modelId).toBe(modelId);
        const denied = await tester.test({ ...config, apiKey: "invalid-test-key" });
        expect(denied.ok).toBe(false);
        expect(denied.message).toContain("HTTP 401");
        expect(calls).toHaveLength(3);
        expect((await tester.test(config)).ok).toBe(true);
        expect(calls).toHaveLength(4);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });

});
