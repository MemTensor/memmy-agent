import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isDirectRun, main } from "../src/cli/index.js";
import {
  createMemoryHttpServer,
  type Embedder,
  MemoryDb,
  MemoryService
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("memmy CLI", () => {
  it("recognizes npm bin symlinks as direct CLI execution", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-cli-symlink-"));
    roots.push(root);
    const target = join(root, "index.js");
    const link = join(root, "memmy-memory");
    writeFileSync(target, "#!/usr/bin/env node\n");
    symlinkSync(target, link);

    expect(isDirectRun(link, target)).toBe(true);
  });

  it("does not expose MCP commands in this release", async () => {
    const help = await runCliText(["help"]);
    expect(help).not.toContain("mcp serve");
    await expectCliFailure(["mcp", "serve"], "unknown command: mcp serve");
  });

  it("drives the local REST workflow with current commands and memory reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-memory-cli-reads-"));
    roots.push(root);
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = new MemoryService({ db, mode: "dev", embedder: createTestEmbedder() });
    const server = createMemoryHttpServer({ service });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const health = await runCliJson(["health", "--url", url]) as {
        ok?: boolean;
        version?: string;
        storage?: {
          backendId?: string;
        };
      };
      expect(health).toMatchObject({
        ok: true,
        version: "0.1.0",
        storage: {
          backendId: "sqlite-local"
        }
      });

      const session = await runCliJson([
        "session",
        "open",
        "--url",
        url,
        "--source",
        "codex",
        "--user-id",
        "user-cli-source-test"
      ]) as { sessionId: string };
      expect(session.sessionId).toBeTruthy();

      const complete = await runCliJson([
        "turn",
        "complete",
        "turn-cli-1",
        "--url",
        url,
        "--session-id",
        session.sessionId,
        "--query",
        "verify the memory CLI can submit a turn",
        "--answer",
        "recorded the turn through the memory CLI",
        "--source",
        "codex"
      ]) as { episodeId: string; rawTurnId: string; l1MemoryId: string };
      expect(complete).toMatchObject({
        episodeId: expect.any(String),
        rawTurnId: expect.any(String),
        l1MemoryId: expect.any(String)
      });
      await runCliJson([
        "raw",
        "POST",
        "/worker/run",
        "--url",
        url,
        "--body",
        "{\"limit\":20}"
      ]);

      const search = await runCliJson([
        "search",
        "memory CLI recorded turn",
        "--url",
        url,
        "--layers",
        "L1",
        "--source",
        "codex"
      ]) as { injectedContext: string };
      expect(search.injectedContext).toContain(complete.l1MemoryId);

      const detail = await runCliText([
        "get",
        complete.l1MemoryId,
        "--url",
        url
      ]);
      expect(detail).toContain(`id: ${complete.l1MemoryId}`);
      expect(detail).toContain("kind: trace");
      expect(detail).toContain("layer: L1");
      expect(detail).toContain("recorded the turn through the memory CLI");
      expect(detail).not.toContain("embedding");

      const verboseDetail = await runCliJson([
        "get",
        complete.l1MemoryId,
        "--url",
        url,
        "--verbose"
      ]) as { id: string; item?: { id: string } };
      expect(verboseDetail.id).toBe(complete.l1MemoryId);
      expect(verboseDetail.item?.id).toBe(complete.l1MemoryId);

      const episodeDetail = await runCliJson([
        "get",
        complete.episodeId,
        "--url",
        url,
        "--verbose"
      ]) as { id: string; kind: string; timeline?: { items?: Array<{ id: string }>; rawTurns?: Array<{ rawTurnId: string }> } };
      expect(episodeDetail.id).toBe(complete.episodeId);
      expect(episodeDetail.kind).toBe("episode");
      expect(episodeDetail.timeline?.items?.map((item) => item.id)).toContain(complete.l1MemoryId);
      expect(episodeDetail.timeline?.rawTurns?.map((turn) => turn.rawTurnId)).toContain(complete.rawTurnId);

      const items = await runCliJson([
        "raw",
        "GET",
        "/panel/items?layer=L1",
        "--url",
        url
      ]) as { items: Array<{ id: string; metadata?: { source?: string } }> };
      expect(items.items.map((item) => item.id)).toContain(complete.l1MemoryId);
      expect(items.items.find((item) => item.id === complete.l1MemoryId)?.metadata?.source).toBe("codex");

      const deleted = await runCliJson([
        "delete",
        complete.l1MemoryId,
        "--url",
        url,
        "--source",
        "codex"
      ]) as { ok: boolean; status: string };
      expect(deleted).toMatchObject({ ok: true, status: "deleted" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it("drives the local REST workflow with simplified commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-memory-cli-"));
    roots.push(root);
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = new MemoryService({ db, mode: "dev", embedder: createTestEmbedder() });
    const server = createMemoryHttpServer({ service });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const health = await runCliJson(["health", "--url", url]) as {
        ok?: boolean;
        version?: string;
        storage?: {
          backendId?: string;
        };
      };
      expect(health).toMatchObject({
        ok: true,
        version: "0.1.0",
        storage: {
          backendId: "sqlite-local"
        }
      });

      const session = await runCliJson([
        "session",
        "open",
        "--url",
        url,
        "--source",
        "codex",
        "--user-id",
        "user-cli-source-test"
      ]) as { sessionId: string };
      expect(session.sessionId).toBeTruthy();

      const complete = await runCliJson([
        "turn",
        "complete",
        "turn-cli-1",
        "--url",
        url,
        "--session-id",
        session.sessionId,
        "--query",
        "verify the memory CLI can submit a turn",
        "--answer",
        "recorded the turn through the memory CLI",
        "--source",
        "codex"
      ]) as { episodeId: string; rawTurnId: string; l1MemoryId: string };
      expect(complete).toMatchObject({
        episodeId: expect.any(String),
        rawTurnId: expect.any(String),
        l1MemoryId: expect.any(String)
      });
      await runCliJson([
        "raw",
        "POST",
        "/worker/run",
        "--url",
        url,
        "--body",
        "{\"limit\":20}"
      ]);

      const search = await runCliJson([
        "search",
        "memory CLI recorded turn",
        "--url",
        url,
        "--layers",
        "L1",
        "--source",
        "codex"
      ]) as { injectedContext: string };
      expect(search.injectedContext).toContain(complete.l1MemoryId);

      const detail = await runCliText([
        "get",
        complete.l1MemoryId,
        "--url",
        url
      ]);
      expect(detail).toContain(`id: ${complete.l1MemoryId}`);
      expect(detail).toContain("kind: trace");
      expect(detail).not.toContain("embedding");

      const items = await runCliJson([
        "raw",
        "GET",
        "/panel/items?layer=L1",
        "--url",
        url
      ]) as { items: Array<{ id: string; metadata?: { source?: string } }> };
      expect(items.items.map((item) => item.id)).toContain(complete.l1MemoryId);
      expect(items.items.find((item) => item.id === complete.l1MemoryId)?.metadata?.source).toBe("codex");

      const deleted = await runCliJson([
        "delete",
        complete.l1MemoryId,
        "--url",
        url,
        "--source",
        "codex"
      ]) as { ok: boolean; status: string };
      expect(deleted).toMatchObject({ ok: true, status: "deleted" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});

async function runCliJson(argv: string[]): Promise<unknown> {
  return JSON.parse(await runCliText(argv)) as unknown;
}

async function runCliText(argv: string[]): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await main(argv);
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

async function expectCliFailure(argv: string[], message: string): Promise<void> {
  const originalWrite = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await expect(main(argv)).rejects.toThrow(message);
  } finally {
    process.stderr.write = originalWrite;
  }
  expect(output).toContain(message);
}

function createTestEmbedder(): Embedder {
  return {
    config: {
      provider: "local",
      model: "cli-test-embedding",
      batchSize: 32,
      timeoutMs: 60_000,
      maxRetries: 0,
      cache: false,
      normalize: false
    },
    isRemote() {
      return false;
    },
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
    async embedOne() {
      return [1, 0, 0];
    },
    status() {
      return {
        provider: "local",
        model: "cli-test-embedding",
        configured: true,
        remote: false
      };
    }
  };
}
