import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { DesktopCreditsExportResult } from "@memmy/desktop-interface";
import { ApiErrorBodySchema, CreditsUsageExportSchema, type CreditsUsageExportQuery, type RuntimeConfig } from "@memmy/local-api-contracts";

async function exportHttpFailure(response: Response): Promise<DesktopCreditsExportResult> {
  const result = ApiErrorBodySchema.safeParse(await response.json().catch(() => null));
  const code = result.success ? result.data.error.code : null;
  return { status: "failed", code: code === "EXPORT_TOO_LARGE" || code === "EXPORT_RANGE_TOO_LARGE" || code === "USAGE_DATE_RANGE_TOO_LARGE" ? code : "EXPORT_FAILED" };
}

export async function saveCreditsCsv(
  runtime: Pick<RuntimeConfig, "baseUrl" | "localToken">,
  query: CreditsUsageExportQuery,
  destination: string,
  signal: AbortSignal
): Promise<DesktopCreditsExportResult> {
  const headers = { "x-memmy-local-token": runtime.localToken };
  let response: Response | undefined;
  let temporaryDirectory: string | undefined;
  try {
    const prepare = new URL("/api/credits/usage/export", runtime.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) prepare.searchParams.set(key, String(value));
    }
    const metadata = await fetch(prepare, { headers, signal, redirect: "error" });
    if (!metadata.ok) return await exportHttpFailure(metadata);
    const { downloadUrl, rowCount } = CreditsUsageExportSchema.parse(await metadata.json());
    const signed = new URL(downloadUrl, "https://credits.invalid");
    if (signed.origin !== "https://credits.invalid" || signed.pathname !== "/api/credits/v1/usage/download") {
      throw new Error("Invalid credits export URL");
    }
    const download = new URL(`/api/credits/usage/download${signed.search}`, runtime.baseUrl);
    response = await fetch(download, { headers: { ...headers, accept: "text/csv" }, signal, redirect: "error" });
    if (!response.ok) return await exportHttpFailure(response);
    if (!response.body || !response.headers.get("content-type")?.startsWith("text/csv")) {
      throw new Error("Invalid credits export response");
    }
    signal.throwIfAborted();
    temporaryDirectory = await mkdtemp(join(dirname(destination), ".memmy-export-"));
    const temporaryFile = join(temporaryDirectory, "download.csv");
    // Node's fetch provides a Node Web Stream despite the DOM declaration in this build.
    const stream = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>, { signal });
    await pipeline(stream, createWriteStream(temporaryFile, { flags: "wx", mode: 0o600 }), { signal });
    const expectedBytes = response.headers.get("X-Memmy-Credits-Export-Bytes");
    if (expectedBytes !== null && String((await stat(temporaryFile)).size) !== expectedBytes) {
      throw new Error("Incomplete credits export");
    }
    signal.throwIfAborted();
    await rename(temporaryFile, destination);
    return { status: "saved", rowCount };
  } catch (error) {
    if (signal.aborted) return { status: "cancelled" };
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return {
      status: "failed",
      code: code && ["EACCES", "EPERM", "ENOSPC", "EROFS", "ENOENT", "ENOTDIR", "EISDIR", "EBUSY"].includes(code)
        ? "EXPORT_SAVE_FAILED" : "EXPORT_FAILED"
    };
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
