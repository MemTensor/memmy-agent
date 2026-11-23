import { describe, expect, it, vi } from "vitest";
import type { OnboardingStateDto, ScanPreferences } from "@memmy/local-api-contracts";
import type { ConfigClient } from "../config-client.js";
import { scanPreferencesWriter } from "../scan-preferences-writer.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let stored: ScanPreferences = { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false };
  const grant = deferred();
  const client = {
    updateOnboarding: vi.fn(async ({ scanPermission }) => {
      await grant.promise;
      return { scanPermission } as OnboardingStateDto;
    }),
    updateScanPreferences: vi.fn(async (patch) => { stored = { ...stored, ...patch }; return stored; })
  } as unknown as ConfigClient;
  const writer = scanPreferencesWriter(client);
  const confirmed = vi.fn();
  const error = vi.fn();
  const write = (patch: Partial<ScanPreferences>) => writer.write({
    patch, previous: stored, permission: "none", onOnboarding: vi.fn(), onConfirmed: confirmed, onError: error
  });
  return { client, writer, grant, write, confirmed, error, stored: () => stored };
}
describe("scan preference intent ordering", () => {
  it.each([[true, false], [true, false, true]])("serializes whole grant/save operations: %j", async (...choices) => {
    const f = fixture();
    const before = f.writer.revision;
    const writes = choices.map(value => f.write({ autoScanKnownAgents: value }));
    await Promise.resolve();
    expect(f.client.updateScanPreferences).not.toHaveBeenCalled();
    expect(f.writer.canRefresh(before)).toBe(false);
    f.grant.resolve();
    await Promise.all(writes);
    const last = choices.at(-1);
    expect(f.stored().autoScanKnownAgents).toBe(last);
    expect(f.confirmed).toHaveBeenCalledTimes(1);
    expect(f.confirmed).toHaveBeenCalledWith(expect.objectContaining({ autoScanKnownAgents: last }));
    expect(f.writer.canRefresh(before)).toBe(false);
    expect(f.writer.canRefresh(f.writer.revision)).toBe(true);
  });
  it("does not let a late grant failure roll back a newer disable, and permits retry", async () => {
    const f = fixture();
    const enable = f.write({ autoScanKnownAgents: true });
    const disable = f.write({ autoScanKnownAgents: false });
    f.grant.reject(new Error("save failed"));
    await Promise.all([enable, disable]);
    expect(f.stored().autoScanKnownAgents).toBe(false);
    expect(f.error).not.toHaveBeenCalled();
    expect(f.confirmed).toHaveBeenCalledTimes(1);
    vi.mocked(f.client.updateOnboarding).mockResolvedValue({ scanPermission: "scan_only" } as OnboardingStateDto);
    await f.write({ autoScanKnownAgents: true });
    expect(f.stored().autoScanKnownAgents).toBe(true);
  });
  it("rolls back a failed latest write to the last confirmed result, keeping unrelated switches", async () => {
    const f = fixture();
    vi.mocked(f.client.updateScanPreferences).mockImplementationOnce(async patch => ({ ...f.stored(), ...patch }))
      .mockRejectedValueOnce(new Error("disk full"));
    const first = f.write({ watchFileChanges: true });
    const second = f.write({ autoScanKnownAgents: true });
    f.grant.resolve();
    await Promise.all([first, second]);
    expect(f.confirmed).toHaveBeenLastCalledWith({ autoScanKnownAgents: false, watchFileChanges: true, autoInjectSkill: false });
    expect(f.error).toHaveBeenCalledTimes(1);
  });
  it("shares the queue across page remounts and does not downgrade an earlier skill grant", async () => {
    const f = fixture();
    const first = f.write({ autoInjectSkill: true });
    expect(scanPreferencesWriter(f.client)).toBe(f.writer);
    const second = f.write({ autoScanKnownAgents: true });
    f.grant.resolve();
    await Promise.all([first, second]);
    expect(f.client.updateOnboarding).toHaveBeenCalledTimes(1);
    expect(f.client.updateOnboarding).toHaveBeenCalledWith({ scanPermission: "scan_and_write_skill" });
    expect(f.stored()).toEqual({ autoScanKnownAgents: true, watchFileChanges: false, autoInjectSkill: true });
  });
});
