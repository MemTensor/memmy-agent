import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStandaloneTaskWorkspace,
  standaloneTaskWorkspaceName,
} from "../../../src/core/session/standalone-task-workspace.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-task-root-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("standalone task workspaces", () => {
  it("names folders by their local creation time", () => {
    expect(standaloneTaskWorkspaceName(new Date(2026, 8, 3, 7, 5, 9))).toBe("2026-09-03-07-05-09");
  });

  it("creates the root on demand and returns the canonical folder", () => {
    const root = path.join(tempRoot(), "Memmy");
    const created = createStandaloneTaskWorkspace(root, new Date(2026, 8, 27, 17, 30, 0));

    expect(created).toBe(path.join(fs.realpathSync(root), "2026-09-27-17-30-00"));
    expect(fs.statSync(created).isDirectory()).toBe(true);
  });

  it("never reuses a folder created in the same second", () => {
    const root = tempRoot();
    const now = new Date(2026, 8, 27, 17, 30, 0);

    const first = createStandaloneTaskWorkspace(root, now);
    fs.writeFileSync(path.join(first, "report.md"), "keep", "utf8");
    const second = createStandaloneTaskWorkspace(root, now);
    const third = createStandaloneTaskWorkspace(root, now);

    expect(path.basename(second)).toBe("2026-09-27-17-30-00-2");
    expect(path.basename(third)).toBe("2026-09-27-17-30-00-3");
    expect(fs.readFileSync(path.join(first, "report.md"), "utf8")).toBe("keep");
  });
});
