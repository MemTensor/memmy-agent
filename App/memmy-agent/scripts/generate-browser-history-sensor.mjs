import fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";

const agentRoot = fileURLToPath(new URL("../", import.meta.url));
export const defaultHistorySensorDestination = path.resolve(agentRoot, "../shell/desktop/extensions/memmy-browser/history-sensor.js");

/** Emit one source implementation into the static isolated content script; no browser eval. */
export async function browserHistorySensorSource() {
  const source = await fs.readFile(path.join(agentRoot, "src/tools/computer-history/browser-history-sensor.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022, removeComments: false,
  } });
  const module = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
  if (typeof module.browserHistorySensor !== "function") throw new Error("Browser History sensor source is missing");
  return `/* Generated from App/memmy-agent/src/tools/computer-history/browser-history-sensor.ts. */\n"use strict";\n(() => {\n  globalThis.__memmyInstallBrowserHistorySensor = ${module.browserHistorySensor.toString()};\n})();\n`;
}

export async function writeBrowserHistorySensor(destination = defaultHistorySensorDestination) {
  const source = await browserHistorySensorSource();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, source, "utf8");
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === "--check") {
    if (await fs.readFile(defaultHistorySensorDestination, "utf8") !== await browserHistorySensorSource()) {
      throw new Error("Static browser History sensor is outdated; regenerate it before packaging");
    }
  } else await writeBrowserHistorySensor();
}
