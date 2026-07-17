#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatOutput, runCommand } from "./commands.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const result = await runCommand({ argv });
    process.stdout.write(formatOutput(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (isDirectRun()) {
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export function isDirectRun(argvPath = process.argv[1], modulePath = fileURLToPath(import.meta.url)): boolean {
  return argvPath !== undefined && realpathOrSelf(argvPath) === realpathOrSelf(modulePath);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (isDirectRun()) {
  void main();
}
