import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
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
});
