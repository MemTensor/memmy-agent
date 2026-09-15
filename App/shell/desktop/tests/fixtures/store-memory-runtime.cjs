const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];

if (["install", "stop", "service"].includes(args[0])) {
  const serviceHome = path.join(arg("--home"), "memory-service");
  if (args[0] !== "install") process.exit(0); // Leave graceful shutdown to HTTP.
  const database = arg("--db");
  if (fs.existsSync(database + ".server.lock")) throw new Error("replaced a still-owned runtime");
  if (!args.includes("--replace-same-version-on-executable-change")) throw new Error("content replacement not requested");
  const runtimeDir = path.join(serviceHome, "runtime", "fixture");
  const bundled = arg("--runtime-directory");
  fs.cpSync(bundled, runtimeDir, { recursive: true });
  const metadata = JSON.parse(fs.readFileSync(path.join(bundled, "memory-runtime.json"), "utf8"));
  fs.writeFileSync(path.join(serviceHome, "current.json"), JSON.stringify({
    ...metadata, runtimeDir, entrypoint: path.join(runtimeDir, "dist/src/server/index.js"),
    runtimeExecutable: process.execPath
  }));
  process.exit(0);
}

const configPath = arg("--config");
const sqlitePath = arg("--db");
const serviceHome = path.join(path.dirname(configPath), "memory-service");
const metadata = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../..", "memory-runtime.json"), "utf8"));
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== "Bearer fixture-token") { response.writeHead(401).end(); return; }
  if (request.url === "/api/v1/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, protocolVersion: 1, serviceVersion: metadata.version, contentId: metadata.contentId }));
    return;
  }
  if (request.url === "/api/v1/admin/shutdown" && request.method === "POST") {
    fs.writeFileSync(path.join(serviceHome, "shutdown-requested"), "yes");
    response.writeHead(200).end("{}");
    server.close();
    // HTTP closes before the database owner releases its lock.
    setTimeout(() => { fs.rmSync(sqlitePath + ".server.lock", { force: true }); process.exit(0); }, 200);
    return;
  }
  response.writeHead(404).end();
});
server.listen(Number(arg("--port")), "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(sqlitePath + ".server.lock", JSON.stringify({ pid: process.pid, sqlitePath, host: "127.0.0.1", port }));
  fs.writeFileSync(path.join(serviceHome, "runtime.json"), JSON.stringify({
    pid: process.pid, configPath, sqlitePath, endpoint: "http://127.0.0.1:" + port,
    serviceVersion: metadata.version, protocolVersion: 1
  }));
  process.send?.({ port });
});
