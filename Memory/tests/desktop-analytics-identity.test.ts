import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readDesktopAnalyticsIdentity } from "../src/server/desktop-analytics-identity.js";
import { createMemoryDesktopAddAnalytics } from "../src/server/memory-add-analytics.js";
import {
  PLUGIN_RUNTIME_EVENTS,
  createPluginRuntimeAnalytics,
} from "../src/server/plugin-runtime-analytics.js";

describe("desktop analytics identity", () => {
  it("reads the logged-in account from the config file on each call", async () => {
    const configPath = writeConfig({
      userMode: "account",
      userId: "account-user",
      cloudUuid: "cloud-1",
    });
    expect(readDesktopAnalyticsIdentity(configPath)).toEqual({
      userId: "account-user",
      userMode: "account",
    });

    writeConfig({
      userMode: "byok",
      userId: "account-user",
      cloudUuid: "cloud-1",
    }, configPath);
    expect(readDesktopAnalyticsIdentity(configPath)).toEqual({
      userId: "account-user",
      userMode: "byok",
    });
  });

  it("omits the account id unless cloudUuid is present", () => {
    const configPath = writeConfig({
      userMode: "account",
      userId: "account-user",
    });
    expect(readDesktopAnalyticsIdentity(configPath)).toEqual({
      userId: null,
      userMode: "account",
    });
    expect(readDesktopAnalyticsIdentity(join(tmpdir(), "missing-memmy-config.yaml"))).toEqual({
      userId: null,
      userMode: null,
    });
  });

  it("does not report local-user as an account id", () => {
    const configPath = writeConfig({
      userMode: "byok",
      userId: "local-user",
      cloudUuid: "cloud-1",
    });
    expect(readDesktopAnalyticsIdentity(configPath).userId).toBeNull();
  });

  it("posts hook and scan events with the identity currently in the config", async () => {
    const configPath = writeConfig({
      userMode: "account",
      userId: "account-user",
      cloudUuid: "cloud-1",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    const identity = () => readDesktopAnalyticsIdentity(configPath);
    const shared = {
      fetchImpl,
      baseUrl: "https://cloud.example.com",
      getClientId: () => "1234567890.1234567890",
      getInstallationId: () => "install-1",
      getUserId: () => identity().userId,
      getUserMode: () => identity().userMode,
    };
    const plugin = createPluginRuntimeAnalytics(shared);
    const scan = createMemoryDesktopAddAnalytics(shared);

    await plugin.trackAwait(PLUGIN_RUNTIME_EVENTS.hookCaptureStarted, { source_id: "cursor" });
    scan.trackAddStarted({ adapterId: "agent-source:cursor", scanMode: "incremental" });
    await scan.flush();

    expect(postedIdentity(fetchImpl, 0)).toMatchObject({
      userId: "account-user",
      user_id: "account-user",
      user_mode: "account",
    });
    expect(postedIdentity(fetchImpl, 1)).toMatchObject({
      userId: "account-user",
      user_id: "account-user",
      user_mode: "account",
    });

    writeConfig({ userMode: "byok" }, configPath);
    await plugin.trackAwait(PLUGIN_RUNTIME_EVENTS.hookCaptureStarted, { source_id: "cursor" });
    expect(postedIdentity(fetchImpl, 2)).toMatchObject({ user_mode: "byok" });
    expect(postedIdentity(fetchImpl, 2).userId).toBeUndefined();
  });
});

function writeConfig(
  app: { userMode?: string; userId?: string; cloudUuid?: string },
  configPath = join(mkdtempSync(join(tmpdir(), "memmy-analytics-")), "config.yaml"),
): string {
  const lines = ["app:"];
  if (app.userMode) lines.push(`  userMode: ${app.userMode}`);
  if (app.userId) lines.push(`  userId: ${app.userId}`);
  if (app.cloudUuid) lines.push(`  cloudUuid: ${app.cloudUuid}`);
  writeFileSync(configPath, `${lines.join("\n")}\n`);
  return configPath;
}

function postedIdentity(fetchImpl: { mock: { calls: unknown[][] } }, call: number): {
  userId?: string;
  user_id?: string;
  user_mode?: string;
} {
  const init = fetchImpl.mock.calls[call]?.[1] as { body?: string } | undefined;
  const body = JSON.parse(String(init?.body)) as {
    userId?: string;
    events: Array<{ params: { user_id?: string; user_mode?: string } }>;
  };
  return {
    userId: body.userId,
    user_id: body.events[0]?.params.user_id,
    user_mode: body.events[0]?.params.user_mode,
  };
}
