// Preserve the existing macOS CLI/import path; summaries are platform-independent.
export * from "../core/summarize-history.js";
import { run } from "../core/summarize-history.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) {
    console.error(`history summary failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
