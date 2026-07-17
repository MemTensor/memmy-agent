import { afterEach, describe, expect, it, vi } from "vitest";
import { WebFetchTool } from "../../../../src/core/agent-runtime/tools/web.js";
import { WebFetchConfig } from "../../../../src/config/schema.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web_fetch SSRF protection", () => {
  it("blocks private IP targets", async () => {
    const data = JSON.parse(
      await new WebFetchTool().execute({ url: "http://169.254.169.254/computeMetadata/v1/" }),
    );

    expect(data.error).toBeDefined();
    expect(data.error.toLowerCase()).toMatch(/private|blocked|not allowed/);
  });

  it("blocks localhost targets", async () => {
    const data = JSON.parse(await new WebFetchTool().execute({ url: "http://localhost/admin" }));

    expect(data.error).toBeDefined();
  });

  it("marks successful fetched content as untrusted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            "<html><head><title>Test</title></head><body><p>Hello world</p></body></html>",
            {
              status: 200,
              headers: { "content-type": "text/html" },
            },
          ),
      ),
    );

    const data = JSON.parse(
      await new WebFetchTool().execute({ url: "https://93.184.216.34/page" }),
    );

    expect(data.untrusted).toBe(true);
    expect(data.text).toContain("[External content");
  });

  it("can skip Jina Reader and use a custom user agent", async () => {
    const seenHeaders: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        void url;
        seenHeaders.push(String((init.headers as Record<string, string>)["User-Agent"]));
        return new Response("<html><body><p>Hello world</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }),
    );

    const tool = new WebFetchTool({
      config: new WebFetchConfig({ useJinaReader: false }),
      userAgent: "memmy-test-agent",
    });
    const data = JSON.parse(await tool.execute({ url: "https://93.184.216.34/page" }));

    expect(data.extractor).toBe("readability");
    expect(seenHeaders).toEqual(["memmy-test-agent", "memmy-test-agent"]);
  });

  it("uses Readability for HTML body extraction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            [
              "<html><head><title>Ignored chrome</title></head><body>",
              "<nav>Navigation Link</nav>",
              "<article><h1>Memmy Tools</h1><p>Important article body for extraction.</p></article>",
              "</body></html>",
            ].join(""),
            {
              status: 200,
              headers: { "content-type": "text/html" },
            },
          ),
      ),
    );

    const data = JSON.parse(
      await new WebFetchTool({ config: new WebFetchConfig({ useJinaReader: false }) }).execute({
        url: "https://93.184.216.34/article",
      }),
    );

    expect(data.extractor).toBe("readability");
    expect(data.text).toContain("Important article body for extraction.");
    expect(data.text).not.toContain("Navigation Link");
  });

  it("blocks private redirect targets before requesting them", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        if (url === "https://93.184.216.34/start") {
          return new Response("", {
            status: 302,
            headers: { location: "http://127.0.0.1/secret" },
          });
        }
        throw new Error("private redirect target should not be fetched");
      }),
    );

    const data = JSON.parse(
      await new WebFetchTool({ config: new WebFetchConfig({ useJinaReader: false }) }).execute({
        url: "https://93.184.216.34/start",
      }),
    );

    expect(data.error.toLowerCase()).toContain("redirect blocked");
    expect(requested).toEqual(["https://93.184.216.34/start"]);
  });

  it("blocks private image redirects before returning image content", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        if (url === "https://93.184.216.34/image.png") {
          return new Response("", {
            status: 302,
            headers: { location: "http://127.0.0.1/secret.png" },
          });
        }
        return new Response(Buffer.from("\x89PNG\r\n\x1a\n"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }),
    );

    const data = JSON.parse(
      await new WebFetchTool({ config: new WebFetchConfig({ useJinaReader: false }) }).execute({
        url: "https://93.184.216.34/image.png",
      }),
    );

    expect(data.error.toLowerCase()).toContain("redirect blocked");
    expect(requested).toEqual(["https://93.184.216.34/image.png"]);
  });

  it("does not request a private redirect target", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        if (url === "https://93.184.216.34/start") {
          return new Response("", {
            status: 302,
            headers: { location: "http://127.0.0.1:8765/metadata" },
          });
        }
        return new Response("internal secret", { status: 200 });
      }),
    );

    const data = JSON.parse(
      await new WebFetchTool({ config: new WebFetchConfig({ useJinaReader: false }) }).execute({
        url: "https://93.184.216.34/start",
      }),
    );

    expect(data.error.toLowerCase()).toContain("redirect blocked");
    expect(requested).toEqual(["https://93.184.216.34/start"]);
  });
});
