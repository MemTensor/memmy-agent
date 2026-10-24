import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const agent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const generatorPath: string = path.join(agent, "scripts/generate-browser-history-sensor.mjs");

describe("static isolated browser History sensor packaging", () => {
  it("ships the single TypeScript sensor implementation without eval or DOM reads at script load", async () => {
    const { browserHistorySensorSource, defaultHistorySensorDestination } = await import(generatorPath);
    const expected = await browserHistorySensorSource();
    expect(await fs.readFile(defaultHistorySensorDestination, "utf8")).toBe(expected);
    expect(expected).not.toMatch(/\beval\(|new Function|__memmyBrowserHistory\s*\(/u);
    const sandbox = vm.createContext({ document: new Proxy({}, { get() { throw new Error("Sensor must remain dormant"); } }) });
    vm.runInContext(expected, sandbox);
    expect(typeof (sandbox as any).__memmyInstallBrowserHistorySensor).toBe("function");
    expect((sandbox as any).__memmyBrowserHistorySensor).toBeUndefined();
  });
});
