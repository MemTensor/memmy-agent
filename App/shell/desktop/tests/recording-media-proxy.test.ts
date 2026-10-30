import { describe, expect, it, vi } from "vitest";
import { createRecordingMediaProxy } from "../src/main/recording-media-proxy.js";
const id = "2e887c14-ef13-48f3-b9b1-2efbc1e89537";
describe("recording media proxy", () => {
  it("authenticates only to the fixed local gateway and forwards streaming Range responses", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ token: "test-token" })))
      .mockResolvedValueOnce(new Response("56789", { status: 206, headers: { "content-range": "bytes 5-9/36", "content-length": "5", "content-type": "video/mp4" } }));
    const proxy = createRecordingMediaProxy(() => ({ baseUrl: "http://127.0.0.1:18961", bootstrapSecret: "test-secret" }), fetchFn);
    const response = await proxy(new Request(`memmy-recording://recording/${id}/video`, { headers: { range: "bytes=5-9" } }));
    expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe("bytes 5-9/36"); expect(await response.text()).toBe("56789");
    expect(String(fetchFn.mock.calls[0][0])).toBe("http://127.0.0.1:18961/webui/bootstrap");
    expect(fetchFn.mock.calls[0][1].headers).toEqual({ "X-Memmy-Agent-Auth": "test-secret" });
    expect(String(fetchFn.mock.calls[1][0])).toBe(`http://127.0.0.1:18961/api/computer-recordings/${id}/video?media=recording`);
    expect(fetchFn.mock.calls[1][1].headers.get("Authorization")).toBe("Bearer test-token");
    expect(fetchFn.mock.calls[1][1].headers.get("Range")).toBe("bytes=5-9");
  });
  it("refuses foreign hosts, paths, arbitrary media, and token query parameters before network access", async () => {
    const fetchFn = vi.fn(); const proxy = createRecordingMediaProxy(() => ({ baseUrl: "http://127.0.0.1:1", bootstrapSecret: "test" }), fetchFn);
    for (const url of [`memmy-recording://evil/${id}/video`, `memmy-recording://recording/${id}/secret`,
      `memmy-recording://recording/${id}/video?media=../../secret`, `memmy-recording://recording/${id}/video?token=secret`]) {
      expect((await proxy(new Request(url))).status).toBeGreaterThanOrEqual(400);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("never uses a remote gateway and does not expose failed bootstrap content", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("private auth diagnostics", { status: 403 }));
    const request = new Request(`memmy-recording://recording/${id}/video`);
    expect((await createRecordingMediaProxy(() => ({ baseUrl: "https://remote.invalid", bootstrapSecret: "test" }), fetchFn)(request)).status).toBe(503);
    expect(fetchFn).not.toHaveBeenCalled();
    const response = await createRecordingMediaProxy(() => ({ baseUrl: "http://127.0.0.1:1", bootstrapSecret: "test" }), fetchFn)(request);
    expect(response.status).toBe(401); expect(await response.text()).toBe("Unauthorized");
  });
});
