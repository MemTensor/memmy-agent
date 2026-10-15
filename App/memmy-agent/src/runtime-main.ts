#!/usr/bin/env node
import "./load-env.js";
import { serve, runInternalCommand } from "./entrypoints/cli/commands.js";
import { prepareStartupMigrations } from "./entrypoints/cli/startup-migrations.js";
import { ConfigError } from "./config/loader.js";
import { VERSION } from "./version.js";
import { parseArgs } from "node:util";
if (await runInternalCommand(process.argv)) {
  // Preserve internal browser preparation without bringing in gateway/onboarding.
} else if (["-V", "--version"].includes(process.argv[2])) console.log(VERSION);
else {
  const args = process.argv.slice(2);
  if (args[0] === "serve") args.shift();
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      timeout: { type: "string", short: "t" },
      workspace: { type: "string", short: "w" },
      config: { type: "string", short: "c" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    console.log(
      "Usage: memmy serve [--host HOST] [--port PORT] [--config FILE] [--workspace DIR] [--timeout SECONDS] [--verbose]",
    );
  else
    try {
      await prepareStartupMigrations(values);
      await serve(values);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      console.error("memmy: " + error.message);
      process.exitCode = 1;
    }
}
