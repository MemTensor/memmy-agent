#!/usr/bin/env node
// Must load first: resolve MEMMY_CLOUD_SERVICE from external env, packaged manifest, or development .env.
import "./load-env.js";

try {
  // Desktop runs migrations before showing its main window. Keep this command
  // out of the Agent/tools/channel SDK import graph on every cold start.
  if (process.argv[2] === "migrate") {
    const { runStartupMigrationCommand } = await import("./entrypoints/cli/startup-migration-command.js");
    await runStartupMigrationCommand();
  } else if (process.argv[2] === "internal") {
    // Browser cache preparation runs beside the Gateway on every desktop
    // startup. It only needs config and Playwright setup, not Agent services.
    const { runBrowserPreparationCommand } = await import("./entrypoints/cli/browser-preparation-command.js");
    await runBrowserPreparationCommand();
  } else {
    const gatewayImportStartedAt = Date.now();
    const { main } = await import("./entrypoints/cli/commands.js");
    if (process.argv[2] === "gateway" && process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === "1") {
      console.info(`[gateway-startup] ${JSON.stringify({ stage: "cli-import-ready", elapsedMs: Date.now() - gatewayImportStartedAt })}`);
    }
    await main();
  }
} catch (error) {
  const { ConfigError } = await import("./config/loader.js");
  const { LinuxSystemdGatewayError } = await import("./entrypoints/cli/linux-systemd-gateway.js");
  if (!(error instanceof ConfigError) && !(error instanceof LinuxSystemdGatewayError)) throw error;
  // Config validation and Linux systemd Gateway failures are expected user-facing errors.
  // Report them concisely and exit non-zero so scripts can detect the failure.
  console.error(`memmy: ${error.message}`);
  process.exitCode = 1;
}
