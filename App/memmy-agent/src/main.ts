#!/usr/bin/env node
// Must load first: resolve MEMMY_CLOUD_SERVICE from external env, packaged manifest, or development .env.
import "./load-env.js";
import { main } from "./entrypoints/cli/commands.js";
import { ConfigError } from "./config/loader.js";
import { LinuxSystemdGatewayError } from "./entrypoints/cli/linux-systemd-gateway.js";

try {
  await main();
} catch (error) {
  if (!(error instanceof ConfigError) && !(error instanceof LinuxSystemdGatewayError)) throw error;
  // Config validation and Linux systemd Gateway failures are expected user-facing errors.
  // Report them concisely and exit non-zero so scripts can detect the failure.
  console.error(`memmy: ${error.message}`);
  process.exitCode = 1;
}
