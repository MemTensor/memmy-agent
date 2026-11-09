import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
async function run(args) {
  await new Promise((ok, reject) => {
    const processHandle = spawn(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, stdio: "inherit", shell: false, env: process.env });
    processHandle.once("error", reject);
    processHandle.once("exit", code => code === 0 ? ok() : reject(new Error(`Office validation failed (${code})`)));
  });
}
await run(["--prefix", "plugins/office", "run", "package:mpp"]);
await run(["exec", "--", "vitest", "run", "--config", "App/backend/vitest.config.ts", "App/backend/src/tests/office-plugin-e2e.test.ts", ...(process.platform === "win32" ? ["App/backend/src/adapters/outbound/plugin-runtime/tests/windows-sandbox.test.ts"] : ["App/backend/src/adapters/outbound/plugin-runtime/tests/command-adapter.test.ts"]), "App/backend/src/adapters/outbound/plugin-runtime/tests/office-installer.test.ts"]);
