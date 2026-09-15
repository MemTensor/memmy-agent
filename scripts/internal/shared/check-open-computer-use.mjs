#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const binary = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: check-open-computer-use.mjs BINARY [--list-apps]");
const env = { ...process.env };
// Match the packaged launch path without a system Node/npm/global OCU.
for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
env.PATH = process.platform === "win32"
  ? `${process.env.SystemRoot || "C:\\Windows"}\\System32;${process.env.SystemRoot || "C:\\Windows"};${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0`
  : "/usr/bin:/bin:/usr/sbin:/sbin";
env.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE = `memmy-packaging-${process.pid}`;
const version = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
if (version.status !== 0) throw new Error(`OCU version check failed: ${version.error?.message ?? version.stderr}`);

const child = spawn(binary, ["mcp"], { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
let sequence = 0;
const pending = new Map();
const rejectAll = (error) => {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
};
child.on("error", rejectAll);
child.on("exit", (code) => rejectAll(new Error(`OCU exited before responding (${code})`)));
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { rejectAll(new Error("OCU wrote invalid JSON to stdout")); return; }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const timeout = setTimeout(() => {
  rejectAll(new Error("OCU smoke check timed out"));
  child.kill();
}, 30_000);
try {
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "memmy-package-check", version: "1.0.0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const result = await request("tools/list");
  const names = result.tools?.map((tool) => tool.name) ?? [];
  for (const name of ["list_apps", "get_app_state", "click", "type_text", "press_key", "scroll"]) {
    if (!names.includes(name)) throw new Error(`OCU is missing tool: ${name}`);
  }
  if (process.argv.includes("--list-apps")) {
    const apps = await request("tools/call", { name: "list_apps", arguments: {} });
    if (apps.isError) throw new Error(`OCU desktop backend failed: ${JSON.stringify(apps.content)}`);
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, version: version.stdout.trim(), binary, tools: names, desktopBackendChecked: process.argv.includes("--list-apps") }));
} finally {
  clearTimeout(timeout);
  lines.close();
  child.stdin.end();
  const kill = setTimeout(() => child.kill(), 2000);
  kill.unref();
  child.once("exit", () => clearTimeout(kill));
}
