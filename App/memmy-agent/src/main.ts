#!/usr/bin/env node
// Must load first: inject MEMMY_CLOUD_SERVICE from the repository root .env into process.env for later module evaluation.
import "./load-env.js";
import { main } from "./entrypoints/cli/commands.js";
import { ConfigError } from "./config/loader.js";

try {
  await main();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // Config load/validation failures are expected user-facing errors (bad YAML, invalid
  // field, missing env var reference) — report them as a concise fatal message instead of
  // an unhandled-rejection stack trace, and exit non-zero so scripts can detect the failure.
  console.error(`memmy: ${error.message}`);
  process.exitCode = 1;
}
