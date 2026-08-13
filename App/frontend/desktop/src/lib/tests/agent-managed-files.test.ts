import { describe, expect, it, vi } from "vitest";
import {
  AGENT_MANAGED_FILES_CHANGED_EVENT,
  readAgentManagedFiles,
  registerAgentManagedFiles,
  type AgentManagedFile
} from "../agent-managed-files.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}

const generated: AgentManagedFile = {
  id: "generated-1",
  path: "Memmy 文件/生成/综述.md",
  name: "综述.md",
  size: "—",
  updated: "刚刚",
  source: "agent-generated"
};

describe("agent managed files", () => {
  it("persists generated files and replaces duplicate identities", () => {
    const storage = memoryStorage();

    registerAgentManagedFiles([generated], storage);
    registerAgentManagedFiles([{ ...generated, path: "Memmy Files/Generated/review.md" }], storage);

    expect(readAgentManagedFiles(storage)).toEqual([{ ...generated, path: "Memmy Files/Generated/review.md" }]);
  });

  it("notifies an open all-files view after registration", () => {
    const storage = memoryStorage();
    const target = new EventTarget();
    const listener = vi.fn();
    target.addEventListener(AGENT_MANAGED_FILES_CHANGED_EVENT, listener);

    registerAgentManagedFiles([generated], storage, target);

    expect(listener).toHaveBeenCalledOnce();
  });
});
