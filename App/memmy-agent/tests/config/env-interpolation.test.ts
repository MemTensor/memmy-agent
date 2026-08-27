import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEnvVars, loadConfig, resolveConfigEnvVars, saveConfig } from "../../src/config/loader.js";

const roots: string[] = [];
const envBackup: Record<string, string | undefined> = {};

function tmpConfig(data: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-config-env-"));
  roots.push(root);
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, YAML.stringify(data), "utf8");
  return file;
}

function setEnv(name: string, value: string): void {
  if (!(name in envBackup)) envBackup[name] = process.env[name];
  process.env[name] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete envBackup[key];
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("environment variable interpolation", () => {
  it("replaces whole string values", () => {
    setEnv("MY_SECRET", "hunter2");

    expect(resolveEnvVars("${MY_SECRET}")).toBe("hunter2");
  });

  it("replaces variables inside longer strings", () => {
    setEnv("HOST", "example.com");

    expect(resolveEnvVars("https://${HOST}/api")).toBe("https://example.com/api");
  });

  it("replaces multiple variables in one string", () => {
    setEnv("USER", "alice");
    setEnv("PASS", "secret");

    expect(resolveEnvVars("${USER}:${PASS}")).toBe("alice:secret");
  });

  it("walks nested objects", () => {
    setEnv("TOKEN", "abc123");

    expect(resolveEnvVars({ channels: { telegram: { token: "${TOKEN}" } } })).toEqual({
      channels: { telegram: { token: "abc123" } },
    });
  });

  it("walks lists", () => {
    setEnv("VAL", "x");

    expect(resolveEnvVars(["${VAL}", "plain"])).toEqual(["x", "plain"]);
  });

  it("ignores non-strings", () => {
    expect(resolveEnvVars(42)).toBe(42);
    expect(resolveEnvVars(true)).toBe(true);
    expect(resolveEnvVars(null)).toBeNull();
    expect(resolveEnvVars(3.14)).toBe(3.14);
  });

  it("keeps plain strings unchanged", () => {
    expect(resolveEnvVars("no vars here")).toBe("no vars here");
  });

  it("raises for missing variables", () => {
    delete process.env.DOES_NOT_EXIST;

    expect(() => resolveEnvVars("${DOES_NOT_EXIST}")).toThrow(/DOES_NOT_EXIST/);
  });

  it("resolves env vars inside loaded configs", () => {
    setEnv("TEST_API_KEY", "resolved-key");
    const configPath = tmpConfig({ providers: { groq: { apiKey: "${TEST_API_KEY}" } } });

    const raw = loadConfig(configPath);
    const resolved = resolveConfigEnvVars(raw);

    expect(raw.providers.groq.apiKey).toBe("${TEST_API_KEY}");
    expect(resolved.providers.groq.apiKey).toBe("resolved-key");
  });

  it("saveConfig preserves env templates", () => {
    setEnv("MY_TOKEN", "real-token");
    const configPath = tmpConfig({ channels: { telegram: { token: "${MY_TOKEN}" } } });

    const raw = loadConfig(configPath);
    saveConfig(raw, configPath);

    expect(YAML.parse(fs.readFileSync(configPath, "utf8")).channels.telegram.token).toBe("${MY_TOKEN}");
  });

  it("preserves excluded DreamConfig fields without env refs", () => {
    const configPath = tmpConfig({ agents: { defaults: { dream: { cron: "5 11 * * *" } } } });

    const resolved = resolveConfigEnvVars(loadConfig(configPath));

    expect(resolved.agents.defaults.dream.cron).toBe("5 11 * * *");
    expect(resolved.agents.defaults.dream.describeSchedule()).toBe("cron 5 11 * * * (legacy)");
  });

  it("preserves excluded DreamConfig fields while resolving unrelated env refs", () => {
    setEnv("TEST_API_KEY", "resolved-key");
    const configPath = tmpConfig({
      agents: { defaults: { dream: { cron: "5 11 * * *" } } },
      providers: { groq: { apiKey: "${TEST_API_KEY}" } },
    });

    const resolved = resolveConfigEnvVars(loadConfig(configPath));

    expect(resolved.providers.groq.apiKey).toBe("resolved-key");
    expect(resolved.agents.defaults.dream.cron).toBe("5 11 * * *");
    expect(resolved.agents.defaults.dream.describeSchedule()).toBe("cron 5 11 * * * (legacy)");
  });
});
