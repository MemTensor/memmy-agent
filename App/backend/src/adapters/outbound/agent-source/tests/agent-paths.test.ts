import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveClaudeCodeHomeDirectory,
  resolveClaudeCodeProjectsDirectory,
  resolveCodexHomeDirectory,
  resolveCodexSessionsDirectory,
  resolveCursorDataPaths,
  resolveHermesHomeDirectory,
  resolveOpencodeConfigDirectory,
  resolveOpencodeDataDirectory,
  resolveOpencodeDatabasePath,
  resolveOpenclawConfigPath,
  resolveOpenclawStateDirectory,
  resolveWorkbuddyHomeDirectory,
  resolveWorkbuddyProjectsDirectory
} from "../../agent-paths.js";

const ENVIRONMENT_VARIABLES = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEBUDDY_CONFIG_DIR",
  "CODEX_HOME",
  "HERMES_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "WORKBUDDY_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
] as const;
const originalEnvironment = new Map(ENVIRONMENT_VARIABLES.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("agent paths", () => {
  it("honors each Agent's configured home or state directory", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-home";
    process.env.CODEX_HOME = "/tmp/codex-home";
    process.env.HERMES_HOME = "/tmp/hermes-home";
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-state";
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/openclaw-config.json";
    process.env.WORKBUDDY_CONFIG_DIR = "/tmp/workbuddy-home";

    expect(resolveClaudeCodeHomeDirectory()).toBe("/tmp/claude-home");
    expect(resolveCodexHomeDirectory()).toBe("/tmp/codex-home");
    expect(resolveHermesHomeDirectory()).toBe("/tmp/hermes-home");
    expect(resolveOpenclawStateDirectory()).toBe("/tmp/openclaw-state");
    expect(resolveOpenclawConfigPath()).toBe("/tmp/openclaw-config.json");
    expect(resolveWorkbuddyHomeDirectory()).toBe("/tmp/workbuddy-home");
  });

  it("uses WorkBuddy's official config directory variables", () => {
    process.env.WORKBUDDY_CONFIG_DIR = "/tmp/workbuddy-current";
    process.env.CODEBUDDY_CONFIG_DIR = "/tmp/workbuddy-legacy-product-name";

    expect(resolveWorkbuddyHomeDirectory()).toBe("/tmp/workbuddy-current");

    process.env.WORKBUDDY_CONFIG_DIR = " ";
    expect(resolveWorkbuddyHomeDirectory()).toBe("/tmp/workbuddy-legacy-product-name");
  });

  it("uses OpenCode's custom config directory and XDG data directory", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";
    delete process.env.OPENCODE_CONFIG_DIR;

    expect(resolveOpencodeConfigDirectory()).toBe(join("/tmp/xdg-config", "opencode"));
    expect(resolveOpencodeDataDirectory()).toBe(join("/tmp/xdg-data", "opencode"));

    process.env.OPENCODE_CONFIG_DIR = "/tmp/custom-opencode";
    expect(resolveOpencodeConfigDirectory()).toBe("/tmp/custom-opencode");
  });

  it("resolves all seven Agent source paths on macOS", () => {
    const options = {
      platform: "darwin" as const,
      homeDirectory: "/Users/alice",
      environment: {}
    };

    expect({
      cursor: resolveCursorDataPaths(options).workspaceStorageDirectory,
      claudeCode: resolveClaudeCodeProjectsDirectory(options),
      codex: resolveCodexSessionsDirectory(options),
      opencode: resolveOpencodeDatabasePath(options),
      openclaw: resolveOpenclawStateDirectory(options),
      hermes: resolveHermesHomeDirectory(options),
      workbuddy: resolveWorkbuddyProjectsDirectory(options)
    }).toEqual({
      cursor: "/Users/alice/Library/Application Support/Cursor/User/workspaceStorage",
      claudeCode: "/Users/alice/.claude/projects",
      codex: "/Users/alice/.codex/sessions",
      opencode: "/Users/alice/.local/share/opencode/opencode.db",
      openclaw: "/Users/alice/.openclaw",
      hermes: "/Users/alice/.hermes",
      workbuddy: "/Users/alice/.workbuddy/projects"
    });
  });

  it("resolves all seven Agent source paths on Windows", () => {
    const options = {
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: {
        APPDATA: "C:\\Users\\alice\\AppData\\Roaming"
      }
    } as const;

    expect({
      cursor: resolveCursorDataPaths(options).workspaceStorageDirectory,
      claudeCode: resolveClaudeCodeProjectsDirectory(options),
      codex: resolveCodexSessionsDirectory(options),
      opencode: resolveOpencodeDatabasePath(options),
      openclaw: resolveOpenclawStateDirectory(options),
      hermes: resolveHermesHomeDirectory(options),
      workbuddy: resolveWorkbuddyProjectsDirectory(options)
    }).toEqual({
      cursor: "C:\\Users\\alice\\AppData\\Roaming\\Cursor\\User\\workspaceStorage",
      claudeCode: "C:\\Users\\alice\\.claude\\projects",
      codex: "C:\\Users\\alice\\.codex\\sessions",
      opencode: "C:\\Users\\alice\\.local\\share\\opencode\\opencode.db",
      openclaw: "C:\\Users\\alice\\.openclaw",
      hermes: "C:\\Users\\alice\\.hermes",
      workbuddy: "C:\\Users\\alice\\.workbuddy\\projects"
    });
  });

  it("resolves Cursor's Linux XDG path and Windows fallback path", () => {
    expect(resolveCursorDataPaths({
      platform: "linux",
      homeDirectory: "/home/alice",
      environment: {
        XDG_CONFIG_HOME: "/srv/alice/config"
      }
    }).userDirectory).toBe("/srv/alice/config/Cursor/User");

    expect(resolveCursorDataPaths({
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: {}
    }).userDirectory).toBe("C:\\Users\\alice\\AppData\\Roaming\\Cursor\\User");
  });
});
