import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRuntime } from "../scripts/package-runtime.mjs";
import { serveRegistry } from "../scripts/serve.mjs";

test("portable runtime publication is reproducible and served by target and exact digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-runtime-distribution-"));
  let server;
  try {
    const input = join(root, "input"), registry = join(root, "registry"); await mkdir(input); await mkdir(registry);
    const tools = {};
    for (const name of ["soffice", "pdfinfo", "pdftoppm", "pdftotext"]) { tools[name] = `${name}.exe`; await writeFile(join(input, tools[name]), `runtime fixture ${name}`); }
    await writeFile(join(registry, "catalog.json"), "[]");
    const options = { root: input, destination: registry, target: "win32-x64", version: "test-1", tools, setDefault: true };
    const first = await packageRuntime(options), second = await packageRuntime(options);
    assert.equal(first.archive.sha256, second.archive.sha256);
    const running = await serveRegistry({ root: registry }); server = running.server;
    const response = await fetch(`${running.baseUrl}/api/v1/plugins/office/runtimes/win32-x64`);
    assert.equal(response.status, 200); const manifest = await response.json();
    assert.equal(manifest.archive.sha256, first.archive.sha256);
    const asset = await fetch(new URL(manifest.archive.url, running.baseUrl));
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile(join(registry, first.archive.url)));
    assert.equal((await fetch(`${running.baseUrl}/api/v1/plugins/office/runtimes/win32-x64/${"0".repeat(64)}`)).status, 404);
    assert.equal((await fetch(`${running.baseUrl}/api/v1/plugins/office/runtimes/darwin-arm64`)).status, 404);
    await writeFile(join(input, tools.soffice), "changed");
    await assert.rejects(packageRuntime(options), /immutable/);
  } finally {
    if (server) await new Promise(ok => server.close(ok));
    await rm(root, { recursive: true, force: true });
  }
});
