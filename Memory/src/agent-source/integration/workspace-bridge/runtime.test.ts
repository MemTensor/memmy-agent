import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "./runtime-loader.js";
import {
  notifyRuntimeBoundary,
  openRuntimeSession,
  readRuntimeConfig,
  type RuntimeSession,
} from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Memory lifecycle runtime", () => {
  it("reads Memory connection and owner settings without a workspace scanning flag", async () => {
    const fixture = createFixture();
    const configUrl = pathToFileURL(join(fixture, "memmy-memory-config.json"));
    const configPath = join(fixture, "config.yaml");
    writeFileSync(configUrl, JSON.stringify({
      memmy_config_path: configPath,
      userId: "installed-owner",
      workspaceHostId: "a".repeat(64),
    }));
    writeFileSync(configPath, [
      "memmyMemory:",
      "  workspaceBridge:",
      "    enabled: false",
      "  storage:",
      "    endpoint: http://127.0.0.1:18888",
      "    token: test-token",
      "",
    ].join("\n"));

    await expect(readRuntimeConfig(configUrl, true)).resolves.toEqual({
      endpoint: "http://127.0.0.1:18888",
      token: "test-token",
      userId: "installed-owner",
      workspaceHostId: "a".repeat(64),
    });
  });

  it("opens a v2 project Session with only canonical workspace identity", async () => {
    const fixture = createFixture();
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/api/v1/health") {
        return json(response, 200, { features: { l3WorldModelProtocolVersions: [2] } });
      }
      requests.push({ path: request.url ?? "", body: await requestBody(request) });
      return json(response, 200, { sessionId: "memory-session-1", projectId: "project-1" });
    });
    const endpoint = await listen(server);
    try {
      const session = await openRuntimeSession({
        configUrl: runtimeConfig(fixture, endpoint),
        source: "codex",
        sessionKey: "codex-memory-project",
        workspaceRoot: fixture,
        transition: "allow_legacy_rollover",
        pinnedOwner: true,
      });

      expect(session).toMatchObject({
        protocol: "v2",
        projectId: "project-1",
        workspaceRoot: realpathSync(fixture),
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: "/api/v1/sessions/open",
        body: {
          l3WorldModelProtocolVersion: 2,
          workspaceUri: pathToFileURL(realpathSync(fixture)).href,
          workspaceHostId: "a".repeat(64),
        },
      });
      expect(JSON.stringify(requests)).not.toContain("environment-sync");
    } finally {
      await close(server);
    }
  });

  it("keeps the v2 Turn pipeline when an explicit workspace cannot be used", async () => {
    const fixture = createFixture();
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/api/v1/health") {
        return json(response, 200, { features: { l3WorldModelProtocolVersions: [2] } });
      }
      requests.push(await requestBody(request));
      return json(response, 200, { sessionId: "memory-session-1", projectId: null });
    });
    const endpoint = await listen(server);
    try {
      const session = await openRuntimeSession({
        configUrl: runtimeConfig(fixture, endpoint),
        source: "codex",
        sessionKey: "codex-memory-invalid-root",
        workspaceRoot: process.platform === "win32" ? "C:\\" : "/",
        transition: "allow_legacy_rollover",
        pinnedOwner: true,
      });
      expect(session).toMatchObject({ protocol: "v2", projectId: null, workspaceRoot: null });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ l3WorldModelProtocolVersion: 2 });
      expect(requests[0]).not.toHaveProperty("workspaceUri");
      expect(requests[0]).not.toHaveProperty("workspaceHostId");
    } finally {
      await close(server);
    }
  });

  it("falls back to the exact legacy request only for a resume-only legacy conflict", async () => {
    const fixture = createFixture();
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/api/v1/health") {
        return json(response, 200, { features: { l3WorldModelProtocolVersions: [2] } });
      }
      requests.push(await requestBody(request));
      if (requests.length === 1) {
        return json(response, 409, {
          error: { code: "l3_world_model_v2_session_not_open", message: "l3_world_model_v2_session_not_open" },
        });
      }
      return json(response, 200, { sessionId: "legacy-memory-session" });
    });
    const endpoint = await listen(server);
    try {
      const session = await openRuntimeSession({
        configUrl: runtimeConfig(fixture, endpoint),
        source: "claude_code",
        sessionKey: "claude_code-memory-existing",
        transition: "resume_only",
        pinnedOwner: true,
      });
      expect(session).toMatchObject({ protocol: "legacy", sessionId: "legacy-memory-session" });
      expect(requests[0]).toMatchObject({
        l3WorldModelProtocolVersion: 2,
        l3WorldModelTransition: "resume_only",
      });
      expect(requests[1]).toEqual({
        sessionId: "claude_code-memory-existing",
        source: "claude_code",
      });
    } finally {
      await close(server);
    }
  });

  it("sends a compaction boundary only when Memory has an L1 head", async () => {
    const fixture = createFixture();
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    let throughL1MemoryId = "";
    const server = createServer(async (request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: request.method === "POST" ? await requestBody(request) : {},
      });
      if (request.method === "GET") return json(response, 200, { throughL1MemoryId });
      return json(response, 200, { scheduled: true });
    });
    const endpoint = await listen(server);
    const session = runtimeSession(fixture, endpoint);
    try {
      await expect(notifyRuntimeBoundary(session, "token_compaction")).resolves.toBe(false);
      expect(requests).toHaveLength(1);

      throughL1MemoryId = "l1-1";
      await expect(notifyRuntimeBoundary(session, "token_compaction")).resolves.toBe(true);
      expect(requests).toHaveLength(3);
      expect(requests[2]).toMatchObject({
        method: "POST",
        body: { trigger: "token_compaction", throughL1MemoryId: "l1-1" },
      });
    } finally {
      await close(server);
    }
  });

  it("ships a self-contained lifecycle asset without environment scanning code", async () => {
    const asset = await loadMemmyWorkspaceBridgeRuntimeAsset();
    const imports = [...asset.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)]
      .map((match) => match[1]);
    expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
    expect(asset).not.toContain("environment-sync");
    expect(asset).not.toContain("RuntimeWorkspaceBridge");
  });
});

function createFixture(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "memmy-runtime-lifecycle-")));
  temporaryDirectories.push(directory);
  return directory;
}

function runtimeConfig(directory: string, endpoint: string): URL {
  const configUrl = pathToFileURL(join(directory, "memmy-memory-config.json"));
  writeFileSync(configUrl, JSON.stringify({
    endpoint,
    userId: "installed-owner",
    workspaceHostId: "a".repeat(64),
    memmy_config_path: join(directory, "missing.yaml"),
  }));
  return configUrl;
}

function runtimeSession(workspaceRoot: string, endpoint: string): RuntimeSession {
  return {
    protocol: "v2",
    sessionId: "session-1",
    projectId: "project-1",
    sessionKey: "codex-memory-session-1",
    source: "codex",
    adapterId: "memmy-codex-hook",
    profileId: "default",
    workspaceRoot,
    config: {
      endpoint,
      token: "",
      userId: "user-1",
      workspaceHostId: "a".repeat(64),
    },
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
