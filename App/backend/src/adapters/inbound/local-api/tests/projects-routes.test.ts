/** Local project routes: the managed folder a project created by name alone runs its tasks in. */
import { mkdtemp, rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionManager } from "../../../../permission/index.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import type { BackendServices } from "../../../../services/index.js";
import {
  createProjectDirectoryService,
  type ProjectDirectoryService
} from "../../../../services/project-directory-service.js";
import {
  createProjectInstructionsService,
  type ProjectInstructionsService
} from "../../../../services/project-instructions-service.js";
import { createLocalApiServer } from "../server.js";

let app: FastifyInstance | undefined;
const roots: string[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project local api routes", () => {
  it("prepares a managed working directory behind the runtime token", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-project-routes-"));
    roots.push(root);
    app = createServer(createProjectDirectoryService({ root }));

    const response = await injectJson("POST", "/api/projects/working-directory", { name: "周报整理" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ path: join(root, "周报整理") });
  });

  it("rejects the route without a runtime token", async () => {
    app = createServer({ prepareManagedDirectory: async () => ({ path: "/tmp/unused" }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/working-directory",
      payload: { name: "周报整理" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a project name that is only whitespace", async () => {
    app = createServer({ prepareManagedDirectory: async () => ({ path: "/tmp/unused" }) });

    const response = await injectJson("POST", "/api/projects/working-directory", { name: "   " });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("reads and saves a project's instructions, keyed by the project folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-project-instructions-routes-"));
    roots.push(root);
    const instructions = createProjectInstructionsService({ filePath: join(root, "project-instructions.json") });
    app = createServer(undefined, instructions);
    const directory = join(root, "memmy");

    const empty = await injectJson("GET", `/api/projects/instructions?directory=${encodeURIComponent(directory)}`);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ text: "", origin: null, cloudProjectId: null, updatedAt: null });

    const saved = await injectJson("PUT", "/api/projects/instructions", {
      directory,
      text: "本项目负责 Memmy 桌面端的研发。"
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ text: "本项目负责 Memmy 桌面端的研发。", origin: "local" });

    const read = await injectJson("GET", `/api/projects/instructions?directory=${encodeURIComponent(directory)}`);
    expect(read.json()).toMatchObject({ text: "本项目负责 Memmy 桌面端的研发。" });
  });

  it("rejects instructions that are too long or a folder that is not absolute", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-project-instructions-limit-"));
    roots.push(root);
    app = createServer(undefined, createProjectInstructionsService({ filePath: join(root, "project-instructions.json") }));

    const tooLong = await injectJson("PUT", "/api/projects/instructions", {
      directory: join(root, "memmy"),
      text: "字".repeat(10_001)
    });
    expect(tooLong.statusCode).toBe(400);

    const relative = await injectJson("GET", "/api/projects/instructions?directory=memmy");
    expect(relative.statusCode).toBeGreaterThanOrEqual(400);
  });
});

async function injectJson(method: string, url: string, payload?: unknown) {
  if (!app) throw new Error("Test server is not initialized");
  return app.inject({
    method,
    url,
    headers: { "x-memmy-local-token": "test-token" },
    payload
  });
}

function createServer(
  projectDirectory?: ProjectDirectoryService,
  projectInstructions?: ProjectInstructionsService
): FastifyInstance {
  const services = {
    bootstrap: {
      async getBootstrap() {
        throw new Error("bootstrap not used");
      }
    },
    progressBus: createProgressBus(),
    ...(projectInstructions ? { projectInstructions } : {})
  } as unknown as BackendServices;

  return createLocalApiServer({
    permissionManager: createPermissionManager(),
    services,
    ...(projectDirectory ? { projectDirectory } : {}),
    heartbeatIntervalMs: 20
  });
}

function createPermissionManager(): PermissionManager {
  return {
    async getRuntimeToken() {
      return "test-token";
    },
    async verifyRuntimeToken(token) {
      return token === "test-token";
    },
    async getScanPermission() {
      return "scan_and_write_skill";
    },
    async setScanPermission() {
      return undefined;
    },
    async canDetectAgentSources() {
      return true;
    },
    async canScanAgentSource() {
      return true;
    },
    async canWriteAgentSkill() {
      return true;
    }
  } as unknown as PermissionManager;
}
