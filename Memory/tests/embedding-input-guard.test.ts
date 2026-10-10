import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../src/config/index.js";
import { createEmbedder } from "../src/model/embedder.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["ASCII boundary", "a".repeat(27_447)],
  ["mixed Unicode", "中文🙂 café\n".repeat(5_000)]
])("guards opaque-model %s inputs by bytes without truncation", async (_name, text) => {
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { input } = JSON.parse(String(init?.body));
    sent.push(...input);
    if (input.some((part: string) => Buffer.byteLength(part, "utf8") > 12_000)) {
      return new Response(JSON.stringify({ code: 20015, message: "The parameter is invalid." }), { status: 400 });
    }
    return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0] })) }), { status: 200 });
  }));
  const embedder = createEmbedder({ ...DEFAULT_MEMMY_CONFIG.embedding, provider: "openai_compatible",
    model: "Pro/BAAI/bge-m3", endpoint: "https://example.test/v1", cache: false, maxRetries: 0 },
    { usageRecorder: { record() { return "skipped"; } } });
  await expect(embedder.embedOne(text)).resolves.toEqual([1, 0]);
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.every(part => Buffer.byteLength(part, "utf8") <= 12_000)).toBe(true);
  expect(sent.join("")).toBe(text);
});

it("honors a smaller byte budget and keeps multi-byte characters intact", async () => {
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { input } = JSON.parse(String(init?.body)); sent.push(...input);
    return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0] })) }), { status: 200 });
  }));
  const text = "a中🙂é".repeat(100);
  const embedder = createEmbedder({ ...DEFAULT_MEMMY_CONFIG.embedding, provider: "openai_compatible",
    model: "custom-alias", endpoint: "https://example.test/v1", maxInputBytes: 7, cache: false },
    { usageRecorder: { record() { return "skipped"; } } });
  await embedder.embedOne(text);
  expect(sent.every(part => Buffer.byteLength(part) <= 7)).toBe(true);
  expect(sent.join("")).toBe(text);
});

it("rejects an impossible character budget before making any HTTP request", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const embedder = createEmbedder({ ...DEFAULT_MEMMY_CONFIG.embedding, provider: "openai_compatible",
    model: "custom-alias", endpoint: "https://example.test/v1", maxInputBytes: 1, cache: false });
  await expect(embedder.embedOne("🙂")).rejects.toThrow("one complete character");
  expect(fetchMock).not.toHaveBeenCalled();
});
