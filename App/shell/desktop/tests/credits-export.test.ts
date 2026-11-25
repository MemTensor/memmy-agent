import { mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveCreditsCsv } from "../src/main/credits-export.js";

const runtime = { baseUrl: "http://127.0.0.1:18101", localToken: "test-runtime-token" };
const query = { domain: "memory" as const, from: "2026-11-18T00:00:00+08:00", to: "2026-11-26T00:00:00+08:00" };
let directory: string;
let destination: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memmy-credits-export-test-"));
  destination = join(directory, "export.csv");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

function stubDownload(download: () => Response) {
  const fetch = vi.fn().mockImplementationOnce(async () => Response.json({
    exportId: "export", fileName: "export.csv", rowCount: 2386, expiresAt: "2026-11-25T00:05:00Z",
    downloadUrl: "/api/credits/v1/usage/download?domain=memory&token=signed"
  })).mockImplementationOnce(async () => download());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("streams above 32 MiB into one file, keeping the original CSV bytes", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(65);
  chunk.set(new Uint8Array([0xef, 0xbb, 0xbf]));
  let remaining = 36;
  const fetch = stubDownload(() => new Response(new ReadableStream({
    pull(controller) { if (remaining-- > 0) controller.enqueue(chunk); else controller.close(); }
  }), { headers: { "content-type": "text/csv", "X-Memmy-Credits-Export-Bytes": String(36 * chunk.length) } }));

  await expect(saveCreditsCsv(runtime, query, destination, new AbortController().signal)).resolves.toEqual({ status: "saved", rowCount: 2386 });
  expect((await stat(destination)).size).toBe(36 * chunk.length);
  const saved = await open(destination);
  try {
    const prefix = Buffer.alloc(3);
    await saved.read(prefix);
    expect(prefix).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  } finally { await saved.close(); }
  expect(await readdir(directory)).toEqual(["export.csv"]);
  const [download, init] = fetch.mock.calls[1]!;
  expect(String(download)).toBe("http://127.0.0.1:18101/api/credits/usage/download?domain=memory&token=signed");
  expect(init).toMatchObject({ headers: { "x-memmy-local-token": "test-runtime-token", accept: "text/csv" }, redirect: "error" });
});

it("cleans up an interrupted download or a response shorter than the verified byte count", async () => {
  const abort = new AbortController();
  stubDownload(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }
  }), { headers: { "content-type": "text/csv" } }));
  const saving = saveCreditsCsv(runtime, query, destination, abort.signal);
  await vi.waitFor(async () => expect(await readdir(directory)).toHaveLength(1));
  abort.abort();
  await expect(saving).resolves.toEqual({ status: "cancelled" });
  expect(await readdir(directory)).toEqual([]);

  stubDownload(() => new Response("short", { headers: { "content-type": "text/csv", "X-Memmy-Credits-Export-Bytes": "100" } }));
  await expect(saveCreditsCsv(runtime, query, destination, new AbortController().signal)).resolves.toEqual({ status: "failed", code: "EXPORT_FAILED" });
  expect(await readdir(directory)).toEqual([]);
});

it("returns the size-limit error without publishing a file", async () => {
  stubDownload(() => Response.json({ error: { code: "EXPORT_TOO_LARGE", message: "File too large", requestId: "request" } }, { status: 413 }));
  await expect(saveCreditsCsv(runtime, query, destination, new AbortController().signal)).resolves.toEqual({ status: "failed", code: "EXPORT_TOO_LARGE" });
  expect(await readdir(directory)).toEqual([]);
});
