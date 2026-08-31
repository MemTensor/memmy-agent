import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpPluginsClient } from "../plugins-client.js";

const config = { baseUrl: "http://127.0.0.1:18100", localToken: "token", timeZone: "+00:00" };

afterEach(() => vi.unstubAllGlobals());

describe("plugins client", () => {
  it("loads UI slots independently and invokes declared capabilities", async () => {
    const fetchMock = vi.fn(async (request: URL, init?: RequestInit) => {
      if (request.pathname.endsWith("/invoke")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ conversationId: "chat-1", input: { topic: "memory" } });
        return Response.json({ callId: "call-1", event: { type: "result", output: { ok: true } } });
      }
      return Response.json({ html: request.pathname.endsWith("/surface") ? "surface" : "renderer" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpPluginsClient(config);

    await expect(client.getUi("com.example.review", "renderer")).resolves.toBe("renderer");
    await expect(client.getUi("com.example.review", "surface")).resolves.toBe("surface");
    await expect(client.invoke("com.example.review", "run", { conversationId: "chat-1", input: { topic: "memory" } })).resolves.toMatchObject({ callId: "call-1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
