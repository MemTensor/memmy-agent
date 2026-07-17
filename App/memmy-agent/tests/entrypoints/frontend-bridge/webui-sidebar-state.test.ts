import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultWebuiSidebarState,
  readWebuiSidebarState,
  webuiSidebarStatePath,
  writeWebuiSidebarState,
} from "../../../src/entrypoints/frontend-bridge/sidebar-state.js";

const roots: string[] = [];
const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function useDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-sidebar-state-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  return root;
}

afterEach(() => {
  if (oldDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("webui sidebar state", () => {
  it("returns defaults when the state file is missing", () => {
    const root = useDataDir();

    expect(readWebuiSidebarState()).toEqual(defaultWebuiSidebarState());
    expect(webuiSidebarStatePath()).toBe(path.join(root, "webui", "sidebar-state.json"));
  });

  it("normalizes old or partial payloads", () => {
    useDataDir();
    const file = webuiSidebarStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        pinned_keys: ["websocket:a", "websocket:a", "", 123],
        archived_keys: ["websocket:b"],
        title_overrides: { "websocket:a": "  Release notes  ", bad: "" },
        tags_by_key: { "websocket:a": ["work", "work", ""] },
        collapsed_groups: { Earlier: 1 },
        view: { density: "tiny", show_archived: true, sort: "nope" },
      }),
      "utf8",
    );

    const state = readWebuiSidebarState();

    expect(state.schema_version).toBe(1);
    expect(state.pinned_keys).toEqual(["websocket:a"]);
    expect(state.archived_keys).toEqual(["websocket:b"]);
    expect(state.title_overrides).toEqual({ "websocket:a": "Release notes" });
    expect(state.tags_by_key).toEqual({ "websocket:a": ["work"] });
    expect(state.collapsed_groups).toEqual({ Earlier: true });
    expect(state.view).toEqual({
      density: "comfortable",
      show_previews: false,
      show_timestamps: false,
      show_archived: true,
      sort: "updated_desc",
    });
  });

  it("writes state scoped to the configured data directory", () => {
    useDataDir();

    const state = writeWebuiSidebarState({
      pinned_keys: ["websocket:a"],
      archived_keys: ["websocket:b"],
      title_overrides: { "websocket:a": "Release" },
      view: { density: "compact", show_previews: true },
    });

    expect(state.pinned_keys).toEqual(["websocket:a"]);
    expect(state.archived_keys).toEqual(["websocket:b"]);
    expect(state.title_overrides).toEqual({ "websocket:a": "Release" });
    expect(state.view.density).toBe("compact");
    expect(state.view.show_previews).toBe(true);
    expect(fs.existsSync(webuiSidebarStatePath())).toBe(true);
    expect(readWebuiSidebarState().pinned_keys).toEqual(["websocket:a"]);
  });

  it("writes stable sorted JSON keys through the atomic state path", () => {
    useDataDir();

    writeWebuiSidebarState({
      title_overrides: { "websocket:z": "Zed", "websocket:a": "Alpha" },
      collapsed_groups: { Later: true, Earlier: true },
    });

    const text = fs.readFileSync(webuiSidebarStatePath(), "utf8");
    expect(text.indexOf('"archived_keys"')).toBeLessThan(text.indexOf('"collapsed_groups"'));
    expect(text.indexOf('"collapsed_groups"')).toBeLessThan(text.indexOf('"pinned_keys"'));
    expect(text.indexOf('"websocket:a"')).toBeLessThan(text.indexOf('"websocket:z"'));
    expect(fs.readdirSync(path.dirname(webuiSidebarStatePath())).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
