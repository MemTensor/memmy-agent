import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setConfigPath } from "../../src/config/loader.js";
import {
  getBridgeInstallDir,
  getCliHistoryPath,
  getConfigPath,
  getCronDir,
  getDataDir,
  getLogsDir,
  getMediaDir,
  getRuntimeSubdir,
  getWebuiDir,
  getWorkspacePath,
  isDefaultWorkspace,
} from "../../src/config/paths.js";

const originalConfig = process.env.MEMMY_CONFIG;
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const originalWorkspace = process.env.MEMMY_AGENT_WORKSPACE;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-config-paths-"));
  roots.push(root);
  return root;
}

function expectDirectory(value: string): void {
  expect(fs.statSync(value).isDirectory()).toBe(true);
}

afterEach(() => {
  setConfigPath(null);
  if (originalConfig === undefined) delete process.env.MEMMY_CONFIG;
  else process.env.MEMMY_CONFIG = originalConfig;
  if (originalDataDir === undefined) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  if (originalWorkspace === undefined) delete process.env.MEMMY_AGENT_WORKSPACE;
  else process.env.MEMMY_AGENT_WORKSPACE = originalWorkspace;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("config path helpers", () => {
  it("defaults config path to the user config directory", () => {
    delete process.env.MEMMY_CONFIG;

    expect(getConfigPath()).toBe(path.join(os.homedir(), ".memmy", "config.yaml"));
  });

  it("derives runtime dirs from the config path", () => {
    const root = tmpRoot();
    const configFile = path.join(root, "instance-a", "config.yaml");
    process.env.MEMMY_CONFIG = configFile;
    delete process.env.MEMMY_AGENT_DATA_DIR;
    const dataDir = path.dirname(configFile);

    expect(getDataDir()).toBe(dataDir);
    expectDirectory(dataDir);
    expect(getRuntimeSubdir("cron")).toBe(path.join(dataDir, "cron"));
    expectDirectory(path.join(dataDir, "cron"));
    expect(getCronDir()).toBe(path.join(dataDir, "cron"));
    expect(getLogsDir()).toBe(path.join(dataDir, "logs"));
    expectDirectory(path.join(dataDir, "logs"));
  });

  it("derives runtime dirs from the active loader config path", () => {
    const root = tmpRoot();
    const configFile = path.join(root, "instance-active", "config.yaml");
    delete process.env.MEMMY_CONFIG;
    delete process.env.MEMMY_AGENT_DATA_DIR;
    setConfigPath(configFile);
    const dataDir = path.dirname(configFile);

    expect(getConfigPath()).toBe(configFile);
    expect(getDataDir()).toBe(dataDir);
    expectDirectory(dataDir);
    expect(getRuntimeSubdir("logs")).toBe(path.join(dataDir, "logs"));
    expectDirectory(path.join(dataDir, "logs"));
  });

  it("supports channel namespaces for media dirs", () => {
    const root = tmpRoot();
    const configFile = path.join(root, "instance-b", "config.yaml");
    process.env.MEMMY_CONFIG = configFile;
    delete process.env.MEMMY_AGENT_DATA_DIR;
    const dataDir = path.dirname(configFile);

    expect(getMediaDir()).toBe(path.join(dataDir, "media"));
    expectDirectory(path.join(dataDir, "media"));
    expect(getMediaDir("telegram")).toBe(path.join(dataDir, "media", "telegram"));
    expectDirectory(path.join(dataDir, "media", "telegram"));
  });

  it("creates explicit runtime directories from MEMMY_AGENT_DATA_DIR", () => {
    const dataDir = path.join(tmpRoot(), "data");
    process.env.MEMMY_AGENT_DATA_DIR = dataDir;

    expect(getDataDir()).toBe(dataDir);
    expect(getWebuiDir()).toBe(path.join(dataDir, "webui"));
    expect(getCronDir()).toBe(path.join(dataDir, "cron"));
    expect(getLogsDir()).toBe(path.join(dataDir, "logs"));

    expectDirectory(dataDir);
    expectDirectory(path.join(dataDir, "webui"));
    expectDirectory(path.join(dataDir, "cron"));
    expectDirectory(path.join(dataDir, "logs"));
  });

  it("keeps shared paths global", () => {
    expect(getCliHistoryPath()).toBe(path.join(os.homedir(), ".memmy", "history", "cli_history"));
    expect(getBridgeInstallDir()).toBe(path.join(os.homedir(), ".memmy", "bridge"));
  });

  it("resolves workspace paths explicitly", () => {
    const defaultWorkspace = path.join(tmpRoot(), "default-workspace");
    process.env.MEMMY_AGENT_WORKSPACE = defaultWorkspace;
    const customWorkspace = path.join(tmpRoot(), "custom-workspace");

    expect(getWorkspacePath()).toBe(defaultWorkspace);
    expectDirectory(defaultWorkspace);
    expect(getWorkspacePath(customWorkspace)).toBe(customWorkspace);
    expectDirectory(customWorkspace);
  });

  it("distinguishes default and custom workspaces", () => {
    const defaultWorkspace = path.join(tmpRoot(), "default-workspace");
    process.env.MEMMY_AGENT_WORKSPACE = defaultWorkspace;

    expect(isDefaultWorkspace(null)).toBe(true);
    expect(isDefaultWorkspace(defaultWorkspace)).toBe(true);
    expect(isDefaultWorkspace(path.join(tmpRoot(), "custom-workspace"))).toBe(false);
  });
});
