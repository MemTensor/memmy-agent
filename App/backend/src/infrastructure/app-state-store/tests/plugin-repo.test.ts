import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore, type AppStateStore } from "../index.js";

let root: string | undefined;
let store: AppStateStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("PluginRepository", () => {
  it("persists lifecycle state, config, and approved permissions", () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-repo-"));
    store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    const repository = store.repositories.plugins;
    const manifest = {
      apiVersion: "memmy/v1" as const,
      id: "com.example.review",
      name: "Review",
      version: "1.0.0",
      runtime: { adapter: "http" as const, config: { baseUrl: "https://plugin.example" } },
      capabilities: [{
        id: "run",
        name: "Run review",
        description: "Runs a review",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        execution: "job" as const
      }],
      permissions: [{ type: "network" as const, hosts: ["plugin.example"] }]
    };

    repository.save({ manifest, state: "pending_approval", artifactHash: "abc" });
    repository.setApprovedPermissions(manifest.id, manifest.permissions);
    repository.setConfig(manifest.id, { database: "crossref" });
    repository.setState(manifest.id, "active");

    store.close();
    store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    expect(store.repositories.plugins.get(manifest.id)).toMatchObject({
      id: manifest.id,
      state: "active",
      artifactHash: "abc",
      config: { database: "crossref" },
      approvedPermissions: manifest.permissions
    });
  });

  it("fails closed when a plugin does not exist", () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-repo-"));
    store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    expect(() => store?.repositories.plugins.setState("missing", "active")).toThrow(/Plugin not found/);
  });
});
