import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A release directory produced by package:mpp or the server publication tool. */
export async function serveRegistry({ root = resolve(dirname(fileURLToPath(import.meta.url)), "../release"), port = 0 } = {}) {
  const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
  const records = await Promise.all(catalog.map(async item => {
    const release = JSON.parse(await readFile(join(root, `${item.pluginId}-${item.version}.release.json`), "utf8"));
    if (!/^[a-zA-Z0-9._+-]+$/.test(release.artifact.file)) throw new Error("Unsafe artifact file name");
    const bytes = await readFile(join(root, release.artifact.file));
    if (createHash("sha256").update(bytes).digest("hex") !== release.artifact.sha256) throw new Error("Release hash mismatch");
    return { release, bytes };
  }));
  const runtimes = new Map();
  for (const name of await readdir(root)) {
    const match = /^office-runtime-((?:darwin|linux|win32)-(?:x64|arm64))\.json$/.exec(name);
    if (!match) continue;
    const runtime = JSON.parse(await readFile(join(root, name), "utf8"));
    const file = runtime.archive?.url;
    if (runtime.target !== match[1] || !/^office-runtime-[a-z0-9-]+\.zip$/.test(file)) throw new Error("Unsafe runtime descriptor");
    if ((await stat(join(root, file))).size !== runtime.archive.bytes) throw new Error("Runtime archive size mismatch");
    runtimes.set(match[1], runtime);
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const route = url.pathname.replace(/^\/api\/v1\//, "/v1/");
    const json = value => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    const runtimeMatch = /^\/v1\/plugins\/office\/runtimes\/((?:darwin|linux|win32)-(?:x64|arm64))(?:\/([a-f0-9]{64}))?$/.exec(route);
    if (runtimeMatch) {
      const runtime = runtimes.get(runtimeMatch[1]);
      if (!runtime || (runtimeMatch[2] && runtimeMatch[2] !== runtime.archive.sha256)) { response.writeHead(404).end(); return; }
      if (!runtimeMatch[2]) { json({ ...runtime, archive: { ...runtime.archive, url: `/api/v1/plugins/office/runtimes/${runtime.target}/${runtime.archive.sha256}` } }); return; }
      response.writeHead(200, { "content-type": "application/zip", "content-length": runtime.archive.bytes });
      void pipeline(createReadStream(join(root, runtime.archive.url)), response).catch(() => response.destroy()); return;
    }
    if (route === "/v1/plugins") { json(records.map(r => r.release.manifest)); return; }
    for (const { release, bytes } of records) {
      const base = `/v1/plugins/${release.manifest.id}`;
      const requestedVersion = url.searchParams.get("version");
      if (requestedVersion && requestedVersion !== release.manifest.version) continue;
      if (route === base) {
        json({ manifest: release.manifest, artifact: { url: `/api/v1/plugins/${release.manifest.id}/artifact?version=${release.manifest.version}`, sha256: release.artifact.sha256 } }); return;
      }
      if (route === `${base}/artifact`) {
        response.writeHead(200, { "content-type": "application/zip", "content-length": bytes.length }); response.end(bytes); return;
      }
    }
    response.writeHead(404).end();
  });
  await new Promise((ok, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", ok); });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { baseUrl } = await serveRegistry({ root: process.env.OFFICE_REGISTRY_ROOT, port: Number(process.env.PORT ?? 19391) });
  console.log(`Office registry: ${baseUrl}`);
}
