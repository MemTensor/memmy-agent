// Run only against an isolated directory produced by prepare-live-document-review.ts.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { prepareStartupMigrations } from "../../src/entrypoints/cli/startup-migrations.js";

const folder = path.resolve(process.argv[2] ?? "");
if (!path.basename(path.dirname(folder)).startsWith("memmy-live-document-review-")) {
  throw new Error("Expected an isolated review scenario directory");
}
const configPath = path.join(folder, "config.yaml");
const config = YAML.parse(await fs.readFile(configPath, "utf8"));
const key = config.providers.memmy_account.apiKey;
const workspace = path.join(folder, "workspace");
const entry = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  MEMMY_CONFIG: configPath, MEMMY_AGENT_DATA_DIR: path.join(folder, "data"),
  MEMMY_AGENT_WORKSPACE: workspace, MEMMY_CLOUD_SERVICE: "https://api.memmy.cn",
  MEMMY_AGENT_SESSION_DAG_DIR: path.join(folder, "session-dag"), MEMMY_APP_DATABASE: path.join(folder, "app.sqlite") };
// Migrations can add the desktop MCP default. Prepare them first, then disable external
// connections and pass their actual target receipt to the child CLI.
const { target } = await prepareStartupMigrations({ config: configPath, workspace }, env);
const migrated = YAML.parse(await fs.readFile(configPath, "utf8"));
migrated.tools.mcpServers = {};
migrated.contextCompaction = { summaryMode: "text" };
await fs.writeFile(configPath, YAML.stringify(migrated), { mode: 0o600 });
Object.assign(env, {
  MEMMY_MIGRATIONS_READY_CONFIG: target.runtimeConfigFile,
  MEMMY_MIGRATIONS_READY_WORKSPACE: target.agentWorkspace,
  MEMMY_MIGRATIONS_READY_SESSION_DAG: target.sessionDagDir,
  MEMMY_MIGRATIONS_READY_APP_DATABASE: target.appDatabaseFile,
});
const started = Date.now();
const child = spawn(process.execPath, [entry, "agent", "--config", configPath, "--workspace", workspace, "--standalone", "--no-markdown"], {
  cwd: workspace,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
let timedOut = false;
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });
child.stdin.end(await fs.readFile(path.join(folder, "prompt.txt")));
const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 240_000);
const code = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
}).finally(() => clearTimeout(timeout));
const sanitized = output.split(key).join("[REDACTED]").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED JWT]");
await fs.writeFile(path.join(folder, "cli-output.txt"), sanitized, { mode: 0o600 });
const result = { scenario: path.basename(folder), exitCode: code, timedOut, elapsedMs: Date.now() - started, outputFile: path.join(folder, "cli-output.txt") };
await fs.writeFile(path.join(folder, "run-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (code !== 0) console.log(sanitized.slice(-1500));
process.exitCode = code === 0 && !timedOut ? 0 : 1;
