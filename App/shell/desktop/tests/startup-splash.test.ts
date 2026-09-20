import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  resolveStartupSplashHtml,
  resolveStartupSplashLanguage,
  resolveUpdateSplashHtml,
  shouldQuitWhenAllWindowsClosed,
  type StartupSplashLanguage
} from "../src/main/startup-splash.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("startup splash localization", () => {
  it.each<StartupSplashLanguage>(["zh-CN", "en-US"])("reads the persisted %s application language", (language) => {
    const databasePath = createSettingsDatabase(language);

    expect(resolveStartupSplashLanguage(databasePath, language === "zh-CN" ? "en-US" : "zh-CN")).toBe(language);
  });

  it.each(["system", "fr-FR", null])("falls back for an unsupported or missing setting: %s", (language) => {
    const databasePath = createSettingsDatabase(language);

    expect(resolveStartupSplashLanguage(databasePath, "en-US")).toBe("en-US");
  });

  it("falls back when the database table or file is unavailable", () => {
    const directory = createTemporaryDirectory();
    const emptyDatabasePath = join(directory, "empty.sqlite");
    new DatabaseSync(emptyDatabasePath).close();

    expect(resolveStartupSplashLanguage(emptyDatabasePath, "zh-CN")).toBe("zh-CN");
    expect(resolveStartupSplashLanguage(join(directory, "missing.sqlite"), "en-US")).toBe("en-US");
  });

  it("renders only the selected language hint", () => {
    const englishHtml = resolveStartupSplashHtml("en-US");
    const chineseHtml = resolveStartupSplashHtml("zh-CN");

    expect(englishHtml).toContain("Starting…");
    expect(englishHtml).not.toContain("正在启动…");
    expect(chineseHtml).toContain("正在启动…");
    expect(chineseHtml).not.toContain("Starting…");
  });

  it("renders the update splash without exposing unescaped version text", () => {
    const englishHtml = resolveUpdateSplashHtml("en-US", "1.0.8<script>");
    const chineseHtml = resolveUpdateSplashHtml("zh-CN", "1.0.8");

    expect(englishHtml).toContain("Completing Memmy update");
    expect(englishHtml).toContain("Memmy will reopen automatically");
    expect(englishHtml).toContain("1.0.8&lt;script&gt;");
    expect(englishHtml).not.toContain("1.0.8<script>");
    expect(chineseHtml).toContain("正在完成 Memmy 更新");
    expect(chineseHtml).toContain("安装完成后会自动打开新版。");
  });
});

describe("window-all-closed during boot", () => {
  it("keeps the app alive when the startup splash times out before boot has finished", () => {
    // The splash is a BrowserWindow: when its 15 s auto-close fires while the runtime services are
    // still starting, it is the only window, so window-all-closed fires. Quitting there turns a
    // slow boot into a silent exit code 0 ("Memmy is starting…" appears, then everything vanishes).
    expect(shouldQuitWhenAllWindowsClosed({ platform: "win32", isBootReady: false })).toBe(false);
    expect(shouldQuitWhenAllWindowsClosed({ platform: "linux", isBootReady: false })).toBe(false);
  });

  it("quits on Windows and Linux once boot is complete and the last window closes", () => {
    expect(shouldQuitWhenAllWindowsClosed({ platform: "win32", isBootReady: true })).toBe(true);
    expect(shouldQuitWhenAllWindowsClosed({ platform: "linux", isBootReady: true })).toBe(true);
  });

  it("never quits on macOS, matching the platform convention", () => {
    expect(shouldQuitWhenAllWindowsClosed({ platform: "darwin", isBootReady: true })).toBe(false);
    expect(shouldQuitWhenAllWindowsClosed({ platform: "darwin", isBootReady: false })).toBe(false);
  });
});

function createSettingsDatabase(language: string | null): string {
  const databasePath = join(createTemporaryDirectory(), "app.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE app_settings (id TEXT PRIMARY KEY, language TEXT NOT NULL)");
  if (language !== null) {
    database.prepare("INSERT INTO app_settings (id, language) VALUES ('default', ?)").run(language);
  }
  database.close();
  return databasePath;
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "memmy-startup-splash-"));
  temporaryDirectories.push(directory);
  return directory;
}
