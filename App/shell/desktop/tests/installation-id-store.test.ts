import { describe, expect, it, vi } from "vitest";
import { getOrCreateInstallationId } from "../src/main/installation-id-store.js";

describe("installation-id-store", () => {
  it("reuses the persisted installation id instead of generating a new one", () => {
    const createId = vi.fn(() => "new-install-id");
    const writeFileSyncImpl = vi.fn();

    const id = getOrCreateInstallationId({
      existsSyncImpl: () => true,
      readFileSyncImpl: () => " persisted-install-id\n",
      writeFileSyncImpl,
      createId,
    });

    expect(id).toBe("persisted-install-id");
    expect(createId).not.toHaveBeenCalled();
    expect(writeFileSyncImpl).not.toHaveBeenCalled();
  });

  it("creates and persists an installation id when none exists", () => {
    const writeFileSyncImpl = vi.fn();

    const id = getOrCreateInstallationId({
      existsSyncImpl: () => false,
      readFileSyncImpl: () => "",
      mkdirSyncImpl: vi.fn(),
      writeFileSyncImpl,
      createId: () => "new-install-id",
    });

    expect(id).toBe("new-install-id");
    expect(writeFileSyncImpl).toHaveBeenCalledWith(
      expect.stringMatching(/installation-id$/),
      "new-install-id\n",
      "utf8",
    );
  });
});
