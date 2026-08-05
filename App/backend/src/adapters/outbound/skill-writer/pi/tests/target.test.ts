/** Pi skill target tests. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSkillTarget } from "../index.js";
import { renderMemmyDefaultSkillManifest } from "../../templates/memmy-default.js";

let tempDirectory: string | undefined;

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("Pi skill target", () => {
  it("installs the Pi extension, config, bootstrap, and skill idempotently", async () => {
    const fixture = createFixture();
    const target = createPiSkillTarget(fixture);
    writeFileSync(join(fixture.rootDirectory, "AGENTS.md"), "manual instructions\n", "utf8");

    await target.installPlugin?.("pi");
    await target.installPlugin?.("pi");

    const extension = readFileSync(join(fixture.rootDirectory, "extensions", "memmy-memory.ts"), "utf8");
    expect(extension).toContain('pi.on("before_agent_start"');
    expect(extension).toContain('pi.on("agent_settled"');
    expect(extension).toContain('pi.on("input"');
    expect(extension).toContain('pi.registerCommand("memmy-resume"');
    expect(extension).not.toContain('pi.on("agent_end"');
    const config = JSON.parse(readFileSync(join(fixture.rootDirectory, "extensions", "memmy-memory-config.json"), "utf8"));
    expect(config).toEqual({
      memmy_config_path: fixture.memmyConfigPath,
      endpoint: "http://127.0.0.1:18960",
      token: "test-token"
    });
    const agents = readFileSync(join(fixture.rootDirectory, "AGENTS.md"), "utf8");
    expect(agents.match(/<!-- memmy:start v=1 -->/gu)).toHaveLength(1);
    expect(agents).toContain("manual instructions");
    expect(readFileSync(join(fixture.rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8"))
      .toContain("A Memmy Memory Hook or plugin is installed for this agent.");
  });

  it("reads the Memory storage endpoint instead of an earlier model endpoint", async () => {
    const fixture = createFixture();
    writeFileSync(fixture.memmyConfigPath, [
      "memmyMemory:",
      "  profiles:",
      "    byok:",
      "      summary:",
      '        endpoint: "http://model-provider.example/v1"',
      "  storage:",
      '    endpoint: "http://127.0.0.1:18960"',
      '    token: "test-token"',
      ""
    ].join("\n"), "utf8");

    const requestedOrigins: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedOrigins.push(url.origin);
      if (url.pathname === "/api/v1/sessions/open") return jsonResponse({ sessionId: "pi-memory-session" });
      if (url.pathname === "/api/v1/turns/start") return jsonResponse({ turnId: "pi-live-turn" });
      return jsonResponse({}, 404);
    };

    const target = createPiSkillTarget(fixture);
    await target.installPlugin?.("pi");

    try {
      const extensionPath = join(fixture.rootDirectory, "extensions", "memmy-memory.ts");
      const extensionModule = await import(`${pathToFileURL(extensionPath).href}?test=${crypto.randomUUID()}`) as {
        default: (pi: unknown) => void;
      };
      const handlers = new Map<string, (...args: never[]) => unknown>();
      extensionModule.default({
        on(event: string, handler: (...args: never[]) => unknown) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        appendEntry() {}
      });

      await handlers.get("before_agent_start")?.(
        { prompt: "Use the configured Memory service" },
        extensionContext([], "root") as never
      );

      expect(requestedOrigins).toEqual([
        "http://127.0.0.1:18960",
        "http://127.0.0.1:18960"
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uninstalls only Memmy-owned files", async () => {
    const fixture = createFixture();
    const target = createPiSkillTarget(fixture);
    const unrelatedExtension = join(fixture.rootDirectory, "extensions", "unrelated.ts");
    writeFileSync(unrelatedExtension, "export default () => {};\n", "utf8");
    await target.installPlugin?.("pi");

    await target.uninstallPlugin?.("pi");

    expect(existsSync(unrelatedExtension)).toBe(true);
    expect(existsSync(join(fixture.rootDirectory, "extensions", "memmy-memory.ts"))).toBe(false);
    expect(existsSync(join(fixture.rootDirectory, "skills", "memmy-memory"))).toBe(false);
    expect(readFileSync(join(fixture.rootDirectory, "AGENTS.md"), "utf8")).toBe("");
  });

  it("does not create the Pi directory when Pi is unavailable", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "memmy-pi-missing-"));
    const rootDirectory = join(tempDirectory, ".pi", "agent");
    const target = createPiSkillTarget({ rootDirectory });
    await expect(target.install(renderMemmyDefaultSkillManifest("pi"))).rejects.toThrow("Pi is not installed");
    expect(existsSync(rootDirectory)).toBe(false);
  });

  it("awaits settled capture, preserves status, redacts secrets, and marks handled entries", async () => {
    const fixture = createFixture();
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let releaseComplete: (() => void) | undefined;
    const completeGate = new Promise<void>((resolve) => {
      releaseComplete = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ path, body });
      if (path === "/api/v1/sessions/open") return jsonResponse({ sessionId: "pi-memory-session" });
      if (path === "/api/v1/turns/start") return jsonResponse({
        turnId: "pi-live-turn",
        episodeId: "pi-episode",
        sourceMemoryIds: ["memory-1"],
        injectedContext: { markdown: "prior context" }
      });
      if (path === "/api/v1/turns/pi-live-turn/complete") {
        await completeGate;
        return jsonResponse({ turnId: "pi-live-turn" });
      }
      return jsonResponse({}, 404);
    };
    const target = createPiSkillTarget(fixture);
    await target.installPlugin?.("pi");

    try {
      const extensionPath = join(fixture.rootDirectory, "extensions", "memmy-memory.ts");
      const extensionModule = await import(`${pathToFileURL(extensionPath).href}?test=${crypto.randomUUID()}`) as {
        default: (pi: unknown) => void;
      };
      const handlers = new Map<string, (...args: never[]) => unknown>();
      const markers: Array<{ customType: string; data: unknown }> = [];
      extensionModule.default({
        on(event: string, handler: (...args: never[]) => unknown) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        appendEntry(customType: string, data: unknown) {
          markers.push({ customType, data });
        }
      });
      const secret = "sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN";
      const branch = [
        sessionEntry("parent", null, "system", "setup"),
        sessionEntry("user-1", "parent", "user", `First ${secret}`),
        sessionEntry("assistant-1", "user-1", "assistant", "Partial answer"),
        sessionEntry("user-2", "assistant-1", "user", "Follow-up password=hunter2"),
        sessionEntry("assistant-2", "user-2", "assistant", "", "error", `Failed with ${secret}`)
      ];
      const context = extensionContext(branch, "parent");
      await handlers.get("before_agent_start")?.({ prompt: `First ${secret}` }, context as never);

      let settled = false;
      const settledPromise = Promise.resolve(handlers.get("agent_settled")?.({}, context as never)).then(() => {
        settled = true;
      });
      await waitFor(() => requests.some((item) => item.path.endsWith("/complete")));
      expect(settled).toBe(false);
      releaseComplete?.();
      await settledPromise;

      expect(requests.find((item) => item.path.endsWith("/start"))?.body.query).toBe("First [REDACTED:openai_api_key]");
      expect(requests.find((item) => item.path.endsWith("/complete"))?.body).toMatchObject({
        query: "First [REDACTED:openai_api_key]\n\nFollow-up password=[REDACTED:password]",
        answer: "Partial answer",
        status: "failed"
      });
      expect(markers).toEqual([expect.objectContaining({
        customType: "memmy-memory-capture",
        data: expect.objectContaining({ entryIds: ["user-1", "assistant-1", "user-2", "assistant-2"], status: "failed" })
      })]);
    } finally {
      releaseComplete?.();
      globalThis.fetch = originalFetch;
    }
  });

  it("does not complete aborted runs but marks their entries handled", async () => {
    const fixture = createFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/api/v1/sessions/open") return jsonResponse({ sessionId: "pi-memory-session" });
      if (path === "/api/v1/turns/start") return jsonResponse({
        turnId: "pi-aborted-turn",
        episodeId: "pi-episode",
        injectedContext: { markdown: "" }
      });
      throw new Error(`Unexpected request: ${path}`);
    };
    const target = createPiSkillTarget(fixture);
    await target.installPlugin?.("pi");
    const extensionPath = join(fixture.rootDirectory, "extensions", "memmy-memory.ts");
    const extensionModule = await import(`${pathToFileURL(extensionPath).href}?test=${crypto.randomUUID()}`) as {
      default: (pi: unknown) => void;
    };
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const markers: Array<{ customType: string; data: unknown }> = [];
    extensionModule.default({
      on(event: string, handler: (...args: never[]) => unknown) {
        handlers.set(event, handler);
      },
      registerCommand() {},
      appendEntry(customType: string, data: unknown) {
        markers.push({ customType, data });
      }
    });
    try {
      const branch = [
        sessionEntry("parent", null, "system", "setup"),
        sessionEntry("user-1", "parent", "user", "cancel me"),
        sessionEntry("assistant-1", "user-1", "assistant", "partial", "aborted")
      ];
      const context = extensionContext(branch, "parent");
      await handlers.get("before_agent_start")?.({ prompt: "cancel me" }, context as never);
      await handlers.get("agent_settled")?.({}, context as never);
      expect(markers).toEqual([expect.objectContaining({ data: expect.objectContaining({ status: "aborted" }) })]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function createFixture(): { rootDirectory: string; memmyConfigPath: string } {
  tempDirectory = mkdtempSync(join(tmpdir(), "memmy-pi-target-"));
  const rootDirectory = join(tempDirectory, ".pi", "agent");
  const memmyConfigPath = join(tempDirectory, ".memmy", "config.yaml");
  mkdirSync(join(rootDirectory, "extensions"), { recursive: true });
  mkdirSync(join(tempDirectory, ".memmy"), { recursive: true });
  writeFileSync(memmyConfigPath, 'storage:\n  endpoint: "http://127.0.0.1:18960"\n  token: "test-token"\n', "utf8");
  return { rootDirectory, memmyConfigPath };
}

function sessionEntry(
  id: string,
  parentId: string | null,
  role: string,
  text: string,
  stopReason = "stop",
  errorMessage?: string
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: [{ type: "text", text }],
      ...(role === "assistant" ? { stopReason, errorMessage } : {})
    }
  };
}

function extensionContext(branch: Array<Record<string, unknown>>, leafId: string): Record<string, unknown> {
  return {
    cwd: "/tmp/pi-project",
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => "pi-session-1",
      getLeafId: () => leafId,
      getBranch: () => branch
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
