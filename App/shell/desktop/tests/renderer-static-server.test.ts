import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPackagedRendererStaticServer } from "../src/main/renderer-static-server.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("packaged renderer static server", () => {
  it("serves renderer assets over loopback HTTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-renderer-static-"));
    await writeFile(join(root, "index.html"), "<!doctype html><title>Memmy</title>", "utf8");
    await writeFile(join(root, "app.js"), "console.log('memmy');", "utf8");

    const server = await startPackagedRendererStaticServer({
      rootDirectory: root,
      port: 0
    });
    servers.push(server);

    const parsed = new URL(server.baseUrl);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.port).not.toBe("");

    const indexResponse = await fetch(`${server.baseUrl}/index.html`);
    expect(indexResponse.status).toBe(200);
    expect(await indexResponse.text()).toContain("Memmy");

    const assetResponse = await fetch(`${server.baseUrl}/app.js`);
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toContain("memmy");
  });
});
