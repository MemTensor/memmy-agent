export * from "../core/summarize-history.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../core/summarize-history.js";

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    run();
  } catch (error) {
    console.error(`history summary failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
