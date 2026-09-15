import { describe, expect, it, vi } from "vitest";
import type { DesktopUpdateCheckResult } from "@memmy/desktop-interface";
import { createDesktopUpdateOfferRegistry } from "../src/main/desktop-update-offer-registry.js";

const OWNER_ID = 41;
const OFFER_TOKEN = "a".repeat(43);
const SECOND_OFFER_TOKEN = "b".repeat(43);

describe("desktop update offer registry", () => {
  it("binds an opaque token to an immutable main-process offer and consumes it only after success", async () => {
    const offer = createLegacyInstallerOffer();
    const registry = createDesktopUpdateOfferRegistry({
      createToken: () => OFFER_TOKEN,
      now: () => 1_000
    });
    const token = registry.issue(OWNER_ID, offer);
    offer.downloadUrl = "https://attacker.example/forged.exe";
    offer.provider = "microsoft-store";

    const action = vi.fn(async (trustedOffer: DesktopUpdateCheckResult) => ({
      provider: trustedOffer.provider,
      downloadUrl: trustedOffer.downloadUrl,
      force: trustedOffer.force
    }));
    await expect(registry.run(OWNER_ID, token, action)).resolves.toEqual({
      provider: "legacy-installer",
      downloadUrl: "https://updates.example.com/Memmy.exe",
      force: false
    });
    expect(action).toHaveBeenCalledTimes(1);
    await expect(registry.run(OWNER_ID, token, action)).rejects.toThrow("missing, expired, or unavailable");
  });

  it("rejects malformed, unknown, and cross-renderer tokens before invoking an action", async () => {
    const registry = createDesktopUpdateOfferRegistry({ createToken: () => OFFER_TOKEN });
    const token = registry.issue(OWNER_ID, createLegacyInstallerOffer());
    const action = vi.fn(async () => "unexpected");

    await expect(registry.run(OWNER_ID, { downloadUrl: "https://attacker.example/forged.exe" }, action))
      .rejects.toThrow("invalid");
    await expect(registry.run(OWNER_ID, "not-an-offer-token", action)).rejects.toThrow("invalid");
    await expect(registry.run(OWNER_ID, SECOND_OFFER_TOKEN, action))
      .rejects.toThrow("missing, expired, or unavailable");
    await expect(registry.run(OWNER_ID + 1, token, action))
      .rejects.toThrow("missing, expired, or unavailable");
    expect(action).not.toHaveBeenCalled();
  });

  it("expires offers and revokes every offer owned by a destroyed renderer", async () => {
    let now = 1_000;
    const tokens = [OFFER_TOKEN, SECOND_OFFER_TOKEN];
    const registry = createDesktopUpdateOfferRegistry({
      createToken: () => tokens.shift()!,
      maxAgeMs: 500,
      now: () => now
    });
    const expiredToken = registry.issue(OWNER_ID, createLegacyInstallerOffer());
    now = 1_500;
    await expect(registry.run(OWNER_ID, expiredToken, async () => "unexpected"))
      .rejects.toThrow("missing, expired, or unavailable");

    const revokedToken = registry.issue(OWNER_ID, createLegacyInstallerOffer());
    expect(registry.revokeOwner(OWNER_ID)).toBe(1);
    await expect(registry.run(OWNER_ID, revokedToken, async () => "unexpected"))
      .rejects.toThrow("missing, expired, or unavailable");
  });

  it("joins concurrent callers to one action, preserves the token after failure, and consumes it after retry", async () => {
    const registry = createDesktopUpdateOfferRegistry({ createToken: () => OFFER_TOKEN });
    const token = registry.issue(OWNER_ID, createLegacyInstallerOffer());
    let resolveAction!: (value: string) => void;
    const actionPromise = new Promise<string>((resolve) => {
      resolveAction = resolve;
    });
    const action = vi.fn(() => actionPromise);

    const first = registry.run(OWNER_ID, token, action);
    const joined = registry.run(OWNER_ID, token, action);
    expect(joined).toBe(first);
    expect(action).toHaveBeenCalledTimes(1);
    resolveAction("downloaded");
    await expect(first).resolves.toBe("downloaded");
    await expect(joined).resolves.toBe("downloaded");

    const retryRegistry = createDesktopUpdateOfferRegistry({ createToken: () => SECOND_OFFER_TOKEN });
    const retryToken = retryRegistry.issue(OWNER_ID, createLegacyInstallerOffer());
    const failingAction = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    await expect(retryRegistry.run(OWNER_ID, retryToken, failingAction)).rejects.toThrow("network unavailable");
    await expect(retryRegistry.run(OWNER_ID, retryToken, async () => "retried"))
      .resolves.toBe("retried");
  });

  it("issues tokens only for available offers and stays bounded without evicting in-flight work", async () => {
    const tokens = [OFFER_TOKEN, SECOND_OFFER_TOKEN, "c".repeat(43)];
    const registry = createDesktopUpdateOfferRegistry({
      createToken: () => tokens.shift()!,
      maxEntries: 1
    });
    expect(() => registry.issue(OWNER_ID, {
      status: "latest",
      currentVersion: "1.1.2"
    })).toThrow("available");

    const firstToken = registry.issue(OWNER_ID, createLegacyInstallerOffer());
    let release!: () => void;
    const inFlight = registry.run(OWNER_ID, firstToken, () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    expect(() => registry.issue(OWNER_ID, createLegacyInstallerOffer())).toThrow("capacity");
    release();
    await inFlight;
    expect(() => registry.issue(OWNER_ID, createLegacyInstallerOffer())).not.toThrow();
  });
});

const createLegacyInstallerOffer = (): DesktopUpdateCheckResult => ({
  status: "available",
  currentVersion: "1.1.2",
  latestVersion: "1.1.3",
  provider: "legacy-installer",
  updateMode: "manual",
  force: false,
  downloadUrl: "https://updates.example.com/Memmy.exe"
});
