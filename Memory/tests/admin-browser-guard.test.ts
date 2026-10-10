import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryHttpServer,
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryService,
  type Embedder,
  type LlmClient
} from "../src/index.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function testEmbedder(): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => [text.length, 1, 0]);
    },
    dimension(): number {
      return 3;
    }
  } as unknown as Embedder;
}

async function startFixture(): Promise<{ baseUrl: string; shutdowns: () => number }> {
  const root = mkdtempSync(join(tmpdir(), "memmy-admin-guard-"));
  const configPath = join(root, "config.yaml");
  const config = {
    ...DEFAULT_MEMMY_CONFIG,
    hub: { enabled: false, teamToken: "hub-secret" }
  } as typeof DEFAULT_MEMMY_CONFIG;
  writeFileSync(configPath, YAML.stringify({ memmyMemory: config }));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const service = new MemoryService({
    db,
    mode: "dev",
    config,
    configPath,
    configLoader: () => ({ config, path: configPath }),
    embedder: testEmbedder()
  });
  let shutdownCount = 0;
  const server = createMemoryHttpServer({
    service,
    configPath,
    onShutdownRequested: () => {
      shutdownCount += 1;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => db.close(),
    async () => closeServer(server)
  );
  return { baseUrl: `http://127.0.0.1:${address.port}`, shutdowns: () => shutdownCount };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("admin route browser guard (#468)", () => {
  it("refuses a cross-origin browser shutdown attempt", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.baseUrl}/api/v1/admin/shutdown`, {
      method: "POST",
      headers: { origin: "https://evil.example" }
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "forbidden", message: "cross-origin browser requests are not allowed" }
    });
  });

  it("refuses a DNS-rebinding-shaped attempt without an Origin header", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.baseUrl}/api/v1/admin/shutdown`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" }
    });
    expect(response.status).toBe(403);
  });

  it("refuses an unparseable Origin header", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.baseUrl}/api/v1/admin/shutdown`, {
      method: "POST",
      headers: { origin: "not-a-url" }
    });
    expect(response.status).toBe(403);
  });

  it("still lets the desktop app and CLI shut the service down", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.baseUrl}/api/v1/admin/shutdown`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true });
    // The shutdown callback is invoked after the response finishes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.shutdowns()).toBe(1);
  });

  it("allows a loopback Origin such as the desktop renderer's", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.baseUrl}/api/v1/admin/shutdown`, {
      method: "POST",
      headers: { origin: "http://localhost:19000" }
    });
    expect(response.status).toBe(200);
  });

  it("guards the sibling admin route the same way", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.baseUrl}/api/v1/admin/reload-config`, {
      method: "POST",
      headers: { origin: "https://evil.example" }
    });
    expect(response.status).toBe(403);
  });
});
