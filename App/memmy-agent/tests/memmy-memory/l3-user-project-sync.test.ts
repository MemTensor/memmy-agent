import { describe, expect, it, vi } from "vitest";
import type { WebuiProjectRegistrySnapshot } from "../../src/entrypoints/frontend-bridge/projects.js";
import { L3UserProjectSync } from "../../src/memmy-memory/l3-user-project-sync.js";

const envelope = {
  adapterId: "memmy-agent",
  source: "memmy-agent",
  namespace: { source: "memmy-agent", profileId: "default", userId: "u1" },
};

function project(rootPath: string, name: string) {
  return { id: name, name, rootPath, pinned: false, createdAt: "2026-10-24T00:00:00.000Z" };
}

function setup(initial: WebuiProjectRegistrySnapshot, now: () => number = () => 0) {
  let snapshot = initial;
  const replaceL3UserProjects = vi.fn().mockResolvedValue({ count: 0, serverTime: "2026-10-24T00:00:00.000Z" });
  const sync = new L3UserProjectSync({
    client: { replaceL3UserProjects },
    envelope,
    readProjects: () => snapshot,
    standaloneRoots: () => ["/Users/me/Memmy"],
    now,
  });
  return { sync, replaceL3UserProjects, set: (next: WebuiProjectRegistrySnapshot) => { snapshot = next; } };
}

describe("L3UserProjectSync", () => {
  it("pushes the active project list once and again only after it changes", async () => {
    const { sync, replaceL3UserProjects, set } = setup({ state: "ready", projects: [project("/work/a", "A")] });
    expect(await sync.syncNow()).toBe(true);
    expect(await sync.syncNow()).toBe(true);
    expect(replaceL3UserProjects).toHaveBeenCalledTimes(1);
    expect(replaceL3UserProjects.mock.calls[0]![0]).toMatchObject({
      ...envelope,
      projects: [{ rootPath: "/work/a", name: "A" }],
      standaloneRoots: ["/Users/me/Memmy"],
    });
    set({ state: "ready", projects: [project("/work/a", "A2")] });
    await sync.syncNow();
    expect(replaceL3UserProjects).toHaveBeenCalledTimes(2);
    expect(replaceL3UserProjects.mock.calls[1]![0].projects).toEqual([{ rootPath: "/work/a", name: "A2" }]);
  });

  it("pushes an unchanged list again after ten minutes, in case Memory lost it", async () => {
    let clock = 0;
    const { sync, replaceL3UserProjects } = setup({ state: "ready", projects: [project("/work/a", "A")] }, () => clock);
    await sync.syncNow();
    clock = 9 * 60_000;
    await sync.syncNow();
    expect(replaceL3UserProjects).toHaveBeenCalledTimes(1);
    clock = 10 * 60_000;
    await sync.syncNow();
    expect(replaceL3UserProjects).toHaveBeenCalledTimes(2);
  });

  it("does not push a corrupt registry, so a failed load never wipes Memory's list", async () => {
    const { sync, replaceL3UserProjects } = setup({ state: "corrupt", projects: [] });
    expect(await sync.syncNow()).toBe(false);
    expect(replaceL3UserProjects).not.toHaveBeenCalled();
  });

  it("retries on the next run after Memory was unreachable", async () => {
    const { sync, replaceL3UserProjects } = setup({ state: "ready", projects: [project("/work/a", "A")] });
    replaceL3UserProjects.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect(await sync.syncNow()).toBe(false);
    expect(await sync.syncNow()).toBe(true);
    expect(replaceL3UserProjects).toHaveBeenCalledTimes(2);
  });

  it("runs one push at a time", async () => {
    const { sync, replaceL3UserProjects } = setup({ state: "ready", projects: [project("/work/a", "A")] });
    const [first, second] = [sync.syncNow(), sync.syncNow()];
    expect(first).toBe(second);
    await first;
    expect(replaceL3UserProjects).toHaveBeenCalledTimes(1);
  });
});
