import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import type { HistoryPermissions } from "../../../../src/tools/computer-history/mac/permissions.js";

const roots: string[] = [];
const instances: ComputerHistoryDemoService[] = [];
const granted = { supported: true, accessibility: true, inputMonitoring: true };
function service(permissionReader: () => Promise<HistoryPermissions>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-permission-test-"));
  roots.push(root);
  const instance = new ComputerHistoryDemoService({ permissionReader,
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
  });
  instances.push(instance);
  return { instance, root };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.shutdown()));
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
describe("Computer History permission preflight", () => {
  it.each([[false, false], [true, false], [false, true]])("blocks recording before file writes with Accessibility=%s Input Monitoring=%s", async (accessibility, inputMonitoring) => {
    const status = { supported: true, accessibility, inputMonitoring };
    const { instance, root } = service(async () => status);
    const start = vi.spyOn(instance, "startObservation");
    const before = fs.readdirSync(root, { recursive: true });
    const result = await instance.startObservationWithPermissions();
    expect(result.observation).toMatchObject({ state: "stopped", error: null, segmentId: null, permissions: status });
    expect(start).not.toHaveBeenCalled();
    expect(fs.readdirSync(root, { recursive: true })).toEqual(before);
  });
  it("checks fresh grants for each start and resume instead of caching them", async () => {
    const read = vi.fn().mockResolvedValue(granted);
    const { instance } = service(read);
    const start = vi.spyOn(instance, "startObservation").mockImplementation(() => instance.snapshot());
    const resume = vi.spyOn(instance, "resumeObservation").mockImplementation(() => instance.snapshot());
    await instance.startObservationWithPermissions();
    expect(start).toHaveBeenCalledOnce();
    await instance.startObservationWithPermissions(true);
    expect(resume).toHaveBeenCalledOnce();
    read.mockResolvedValue({ ...granted, accessibility: false });
    await instance.startObservationWithPermissions();
    expect(start).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(3);
  });
  it.each(["stop", "shutdown"])("does not start when %s happens during a permission check", async (action) => {
    let finish!: (status: HistoryPermissions) => void;
    const { instance } = service(() => new Promise((resolve) => { finish = resolve; }));
    const start = vi.spyOn(instance, "startObservation");
    const pending = instance.startObservationWithPermissions();
    if (action === "stop") await expect(instance.stopObservation()).rejects.toThrow("not running");
    else await instance.shutdown();
    finish(granted);
    await pending;
    expect(start).not.toHaveBeenCalled();
  });
  it("keeps actual helper failures distinguishable from missing permissions", async () => {
    const { instance } = service(async () => { throw new Error("helper unavailable"); });
    await expect(instance.startObservationWithPermissions()).rejects.toThrow("helper unavailable");
    expect(instance.snapshot().observation.segmentId).toBeNull();
  });
});
