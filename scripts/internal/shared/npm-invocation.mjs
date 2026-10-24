import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Invoke npm through Node so Windows never passes package paths through cmd.exe.
export function npmInvocation(args, { execPath = process.execPath, env = process.env, platform = process.platform } = {}) {
  const candidates = [
    env.npm_execpath && basename(env.npm_execpath) === "npm-cli.js" ? env.npm_execpath : undefined,
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(execPath), "../lib/node_modules/npm/bin/npm-cli.js")
  ];
  const cli = candidates.find((file) => file && existsSync(file));
  if (cli) return { command: execPath, args: [cli, ...args] };
  if (platform === "win32") throw new Error("Cannot locate npm-cli.js; run packaging with a Node installation that includes npm.");
  return { command: "npm", args };
}
