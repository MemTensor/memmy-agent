import { afterEach, describe, expect, it, vi } from "vitest";
import { WebFetchTool, validateUrl } from "../../../../src/core/agent-runtime/tools/web.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response("<html><head><title>T</title></head><body><p>ok</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ),
  );
}

async function expectFetchSucceeds(rawUrl: string): Promise<void> {
  stubFetch();
  const data = JSON.parse(await new WebFetchTool().execute({ url: rawUrl }));
  expect(data.error).toBeUndefined();
  expect(data.untrusted).toBe(true);
  expect(data.text).toContain("[External content");
  expect(data.text).toContain("ok");
}

describe("web_fetch URL sanitization", () => {
  it.each([
    "`https://example.com/page`",
    " `https://example.com/page` ",
    '"https://example.com/page"',
    "'https://example.com/page'",
    '  "https://example.com/page"  ',
  ])("fails validation for dirty URL %#", (dirtyUrl) => {
    const [isValid] = validateUrl(dirtyUrl);

    expect(isValid).toBe(false);
  });

  it("passes validation for a clean URL", () => {
    const [isValid] = validateUrl("https://example.com/page");

    expect(isValid).toBe(true);
  });

  it("matches urlparse behavior where backtick URLs have no scheme", () => {
    const parsed = new URL("`https://example.com/page`", "http://fallback.invalid");

    expect(parsed.protocol).toBe("http:");
    expect(parsed.pathname).toBe("/%60https://example.com/page%60");
  });

  it("strips backticks and fetches the URL", async () => {
    await expectFetchSucceeds("`https://93.184.216.34/page`");
  });

  it("strips double quotes and fetches the URL", async () => {
    await expectFetchSucceeds('"https://93.184.216.34/page"');
  });

  it("strips single quotes and fetches the URL", async () => {
    await expectFetchSucceeds("'https://93.184.216.34/page'");
  });

  it("strips surrounding spaces and backticks before fetching", async () => {
    await expectFetchSucceeds("  `https://93.184.216.34/page`  ");
  });

  it("strips mixed markdown and quotes before fetching", async () => {
    await expectFetchSucceeds('"`https://93.184.216.34/page`"');
  });

  it("keeps case-insensitive HTTP schemes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })),
    );

    const data = JSON.parse(await new WebFetchTool().execute({ url: "HTTPS://93.184.216.34/page" }));

    expect(data.error).toBeUndefined();
  });

  it("rejects non-HTTP URLs after cleaning", async () => {
    const data = JSON.parse(await new WebFetchTool().execute({ url: "ftp://example.com/file" }));

    expect(data.error).toContain("URL validation failed");
  });

  it("rejects garbage URLs after cleaning", async () => {
    const data = JSON.parse(await new WebFetchTool().execute({ url: "`not a url at all`" }));

    expect(data.error).toContain("URL validation failed");
  });

  it("rejects bare domains after cleaning", async () => {
    const data = JSON.parse(await new WebFetchTool().execute({ url: "`example.com/page`" }));

    expect(data.error).toContain("URL validation failed");
  });
});
