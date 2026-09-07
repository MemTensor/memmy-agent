import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const memmyRoot = resolve(import.meta.dirname, "..");
const pluginRoot = resolve(process.env.LITERATURE_REVIEW_PLUGIN_ROOT ?? join(memmyRoot, "..", "Literature-Review-Plugin"));
if (!existsSync(join(pluginRoot, "plugin.json"))) {
  throw new Error(`Literature Review Plugin repository not found: ${pluginRoot}`);
}

await run("npm", ["run", "package:mpp"], pluginRoot);
const reportPath = resolve(
  process.env.LITERATURE_REVIEW_E2E_REPORT
    ?? join(pluginRoot, "evals", "reports", "host-integration-latest.json")
);
await mkdir(dirname(reportPath), { recursive: true });
await run("npm", ["exec", "vitest", "run", "App/backend/src/tests/literature-review-plugin-e2e.test.ts"], memmyRoot, {
  LITERATURE_REVIEW_PLUGIN_ROOT: pluginRoot,
  LITERATURE_REVIEW_E2E_REPORT: reportPath
});
process.stdout.write(`Host integration report: ${reportPath}\n`);

function run(command, args, cwd, extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      shell: false
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}
