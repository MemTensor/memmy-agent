import fs from "node:fs";
import YAML from "yaml";
import {
  getConfigPath,
  loadConfig,
  resolveConfigEnvVars,
} from "../../config/loader.js";
import { prepareManagedChromium } from "../../core/agent-runtime/tools/browser-setup.js";

/** Prepares the desktop browser cache without importing Agent services. */
export async function runBrowserPreparationCommand(argv: string[] = process.argv): Promise<boolean> {
  if (argv[2] !== "internal") return false;
  if (argv.length !== 4 || argv[3] !== "browser-prepare") {
    console.error("unavailable");
    process.exitCode = 2;
    return true;
  }
  try {
    const loaded = resolveConfigEnvVars(loadConfig(null));
    warnDeprecatedMemoryWindow();
    const result = await prepareManagedChromium(loaded.tools.browser.enabled);
    console.log(result.status);
    if (result.status === "unavailable") {
      if (result.error) console.error(result.error);
      process.exitCode = 1;
    }
  } catch (error) {
    console.log("unavailable");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  return true;
}

// Preserve the full CLI's existing config warning without importing its runtime.
function warnDeprecatedMemoryWindow(): void {
  try {
    const data = YAML.parse(fs.readFileSync(getConfigPath(), "utf8") || "{}");
    if (data?.agents?.defaults?.memoryWindow != null) {
      console.warn("`memoryWindow` in your config is no longer used and can be safely removed.");
    }
  } catch {
    // A missing file or warning-only read cannot interrupt browser preparation.
  }
}
