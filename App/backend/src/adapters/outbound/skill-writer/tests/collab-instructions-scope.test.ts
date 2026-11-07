/**
 * 协作项目指令在 Codex 侧按 Codex 自己的项目认领：项目根可以嵌套，嵌套的另一个项目不该被串进来。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCollabProjectInstructions } from "../workspace-bridge/runtime.js";

const PRODUCT_PROJECT = "01a17657-0cd5-7be0-a611-3fdcd387e8ae";
const SCENE_PROJECT = "01a17c05-fa6c-7aa0-9225-3612b2a6f6a6";

describe("collab project instructions for Codex", () => {
  let root: string;
  let memmyHome: string;
  let codexHome: string;
  let configUrl: URL;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memmy-collab-codex-scope-"));
    memmyHome = join(root, "memmy");
    codexHome = join(root, "codex");
    mkdirSync(memmyHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(memmyHome, "config.yaml"), "", "utf8");
    configUrl = pathToFileURL(join(memmyHome, "memmy-memory-config.json"));
    writeFileSync(configUrl, JSON.stringify({ memmy_config_path: join(memmyHome, "config.yaml"), codex_home: codexHome }), "utf8");
    // 只关联「产品工作」这个 Codex 项目，它的根是整个工作区。
    writeFileSync(join(memmyHome, "collab-project-instructions.json"), JSON.stringify({
      version: 1,
      projects: {
        "p-1": {
          scopes: [{ sourceId: "codex", groupId: PRODUCT_PROJECT, roots: [join(root, "ws")] }],
          text: "团队约定：先看 PRD。",
          updatedAt: "2026-10-28T12:00:00.000Z"
        }
      }
    }), "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Codex 的项目表：一个项目可以有多个根。 */
  function writeCodexState() {
    const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER)");
    db.exec("CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER)");
    db.exec(`INSERT INTO projects VALUES ('${PRODUCT_PROJECT}', 'MemOS产品工作', 0)`);
    db.exec(`INSERT INTO projects VALUES ('${SCENE_PROJECT}', 'MemOS产品场景包', 1)`);
    db.exec(`INSERT INTO project_roots VALUES ('${PRODUCT_PROJECT}', '${join(root, "ws")}', 0)`);
    // 场景包是产品工作根目录下的子目录，属于另一个项目。
    db.exec(`INSERT INTO project_roots VALUES ('${SCENE_PROJECT}', '${join(root, "ws", "scene")}', 0)`);
    db.close();
  }

  it("injects into the associated Codex project", async () => {
    writeCodexState();
    const hit = await readCollabProjectInstructions({
      configUrl,
      sourceId: "codex",
      directory: join(root, "ws", "packages", "app"),
      conversationId: "session-1"
    });
    expect(hit).toEqual({ projectId: "p-1", text: "团队约定：先看 PRD。" });
  });

  it("keeps a nested Codex project out, even though its folder is inside the associated project's root", async () => {
    writeCodexState();
    const hit = await readCollabProjectInstructions({
      configUrl,
      sourceId: "codex",
      directory: join(root, "ws", "scene", "packages", "app"),
      conversationId: "session-2"
    });
    // 场景包属于另一个 Codex 项目，而那个项目没有被关联。
    expect(hit).toBeNull();
  });

  it("still matches by folder when Codex's state database is unavailable", async () => {
    // 没有状态库时算不出项目，只能退回按目录认领；这是已知的退化行为。
    const hit = await readCollabProjectInstructions({
      configUrl,
      sourceId: "codex",
      directory: join(root, "ws", "scene", "packages", "app"),
      conversationId: "session-3"
    });
    expect(hit).toEqual({ projectId: "p-1", text: "团队约定：先看 PRD。" });
  });

  it("does not use a Codex project's root for another agent's session", async () => {
    writeCodexState();
    const hit = await readCollabProjectInstructions({
      configUrl,
      sourceId: "claude_code",
      directory: join(root, "ws", "packages", "app"),
      conversationId: "session-4"
    });
    expect(hit).toBeNull();
  });
});
