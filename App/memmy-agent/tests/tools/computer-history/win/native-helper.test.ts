import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveNativeCollector } from "../../../../src/tools/computer-history/win/native-helper.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-win-helper-"));
  roots.push(root);
  const dev = path.join(root, "override.exe");
  const bundled = path.join(root, "app.asar.unpacked", "win", "memmy-history-recorder.exe");
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(dev, "development fixture");
  fs.writeFileSync(bundled, "packaged fixture");
  vi.stubEnv("MEMMY_WINDOWS_HISTORY_BINARY", dev);
  return { root, dev, bundled, url: (archive: string) => pathToFileURL(path.join(root, archive, "win", "settings.js")).href };
}
it.each(["app.asar", "app.asar.unpacked"])("%s ignores both environment and explicit overrides", (archive) => {
  const f = fixture();
  expect(resolveNativeCollector(f.url(archive), f.dev)).toBe(f.bundled);
});
it("missing packaged helper never falls back to a valid development override", () => {
  const f = fixture();
  fs.unlinkSync(f.bundled);
  expect(() => resolveNativeCollector(f.url("app.asar"), f.dev)).toThrow("windows_collector_unavailable");
});
it("development supports explicit and environment overrides", () => {
  const f = fixture();
  expect(resolveNativeCollector(f.url("development"))).toBe(f.dev);
  expect(resolveNativeCollector(f.url("development"), f.bundled)).toBe(f.bundled);
});
it("rejects a directory or relative development override", () => {
  const f = fixture();
  for (const invalid of [f.root, "relative.exe"]) {
    expect(() => resolveNativeCollector(f.url("development"), invalid)).toThrow("windows_collector_unavailable");
  }
});
