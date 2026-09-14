import { describe, expect, it, vi } from "vitest";
import { createWindowsStoreMigrationOfferRegistry } from "../src/main/windows-store-migration-offer-registry.js";

const OWNER_ID = 41;
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);

describe("Windows Store migration offer registry", () => {
  it("keeps verified prepared offers usable until their last renderer closes", async () => {
    let now = 1_000;
    const registry = createWindowsStoreMigrationOfferRegistry<Policy, Authority>({
      createToken: () => TOKEN_A, now: () => now, maxAgeMs: 500
    });
    const handle = registry.getOrCreate(createOffer());
    registry.bindOwner(handle, OWNER_ID);
    expect(() => registry.markPrepared(OWNER_ID + 1, handle)).toThrow("unavailable");
    registry.markPrepared(OWNER_ID, handle);
    now = 60_000;
    expect(registry.prune()).toBe(0);
    expect(() => registry.read(OWNER_ID + 1, handle)).toThrow("unavailable");
    expect(registry.read(OWNER_ID, handle).transactionId).toBe("transaction-a");
    registry.unbindOwner(OWNER_ID);
    expect(registry.prune()).toBe(1);
    expect(() => registry.read(OWNER_ID, handle)).toThrow("unavailable");
  });

  it("reads a bound download offer without consuming or exposing mutable authority", async () => {
    let now = 1_000;
    const registry = createWindowsStoreMigrationOfferRegistry<Policy, Authority>({
      createToken: () => TOKEN_A, now: () => now, maxAgeMs: 500
    });
    const offer = createOffer();
    const handle = registry.getOrCreate(offer);
    registry.bindOwner(handle, OWNER_ID);
    const snapshot = registry.read(OWNER_ID, handle);
    snapshot.policy.storeId = "tampered";
    expect(registry.read(OWNER_ID, handle)).toEqual(offer);
    expect(() => registry.read(OWNER_ID + 1, handle)).toThrow("unavailable");
    expect(() => registry.read(OWNER_ID, { ...handle, filePath: "C:\\other.exe" })).toThrow("invalid");
    now = 1_500;
    expect(() => registry.read(OWNER_ID, handle)).toThrow("expired");
  });

  it("reuses an unconsumed main-owned offer across background checks", async () => {
    const registry = createWindowsStoreMigrationOfferRegistry<Policy, Authority>({
      createToken: () => TOKEN_A,
      now: () => 1_000
    });
    const firstOffer = createOffer();
    const firstHandle = registry.getOrCreate(firstOffer);
    registry.bindOwner(firstHandle, OWNER_ID);

    const reusable = registry.findReusable(firstOffer.contextKey);
    expect(reusable).toEqual(firstOffer);
    reusable!.policy.storeId = "tampered";
    const backgroundHandle = registry.getOrCreate(createOffer());
    expect(backgroundHandle).toEqual(firstHandle);

    const action = vi.fn(async (trustedOffer: typeof firstOffer) => trustedOffer.transactionId);
    await expect(registry.run(OWNER_ID, firstHandle, action)).resolves.toBe("transaction-a");
    expect(action).toHaveBeenCalledWith(firstOffer);
  });

  it("binds the opaque handle to its renderer and rejects forged handles", async () => {
    const registry = createWindowsStoreMigrationOfferRegistry<Policy, Authority>({ createToken: () => TOKEN_A });
    const handle = registry.getOrCreate(createOffer());
    registry.bindOwner(handle, OWNER_ID);
    const action = vi.fn(async () => "opened");

    await expect(registry.run(OWNER_ID + 1, handle, action)).rejects.toThrow("missing, expired, or unavailable");
    await expect(registry.run(OWNER_ID, { ...handle, acquisitionUri: "https://attacker.example" }, action))
      .rejects.toThrow("prepared handle is invalid");
    await expect(registry.run(OWNER_ID, { kind: "store-migration", offerToken: TOKEN_B }, action))
      .rejects.toThrow("missing, expired, or unavailable");
    expect(action).not.toHaveBeenCalled();
  });

  it("expires, unbinds, and consumes offers only after successful single-flight work", async () => {
    let now = 1_000;
    const tokens = [TOKEN_A, TOKEN_B];
    const registry = createWindowsStoreMigrationOfferRegistry<Policy, Authority>({
      createToken: () => tokens.shift()!,
      maxAgeMs: 500,
      now: () => now
    });
    const expired = registry.getOrCreate(createOffer());
    registry.bindOwner(expired, OWNER_ID);
    now = 1_500;
    await expect(registry.run(OWNER_ID, expired, async () => "unexpected"))
      .rejects.toThrow("missing, expired, or unavailable");

    const active = registry.getOrCreate(createOffer({ transactionId: "transaction-b" }));
    registry.bindOwner(active, OWNER_ID);
    const failed = vi.fn(async () => {
      throw new Error("Store unavailable");
    });
    await expect(registry.run(OWNER_ID, active, failed)).rejects.toThrow("Store unavailable");

    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const action = vi.fn(() => pending);
    const first = registry.run(OWNER_ID, active, action);
    const joined = registry.run(OWNER_ID, active, action);
    expect(joined).toBe(first);
    release("opened");
    await expect(first).resolves.toBe("opened");
    await expect(registry.run(OWNER_ID, active, action)).rejects.toThrow("missing, expired, or unavailable");
  });

  it("creates a distinct offer when policy or current-install authority changes", () => {
    const tokens = [TOKEN_A, TOKEN_B];
    const registry = createWindowsStoreMigrationOfferRegistry<Policy, Authority>({
      createToken: () => tokens.shift()!
    });
    const first = registry.getOrCreate(createOffer());
    const secondOffer = createOffer({
      transactionId: "transaction-b",
      contextKey: "context-b",
      authority: { executablePath: "D:\\Memmy\\Memmy.exe" }
    });
    expect(registry.findReusable(secondOffer.contextKey)).toBeNull();
    const second = registry.getOrCreate(secondOffer);
    expect(second).not.toEqual(first);
    expect(registry.size).toBe(2);
  });

  it("removes owner bindings without deleting a reusable background offer", async () => {
    const registry = createWindowsStoreMigrationOfferRegistry<Policy, Authority>({ createToken: () => TOKEN_A });
    const offer = createOffer();
    const handle = registry.getOrCreate(offer);
    registry.bindOwner(handle, OWNER_ID);
    expect(registry.unbindOwner(OWNER_ID)).toBe(1);
    await expect(registry.run(OWNER_ID, handle, async () => "unexpected"))
      .rejects.toThrow("missing, expired, or unavailable");
    expect(registry.findReusable(offer.contextKey)).toEqual(offer);
  });
});

interface Policy {
  storeId: string;
}

interface Authority {
  executablePath: string;
}

const createOffer = (overrides: Partial<{
  transactionId: string;
  acquisitionUri: string;
  contextKey: string;
  policy: Policy;
  authority: Authority;
}> = {}) => ({
  transactionId: overrides.transactionId ?? "transaction-a",
  acquisitionUri: overrides.acquisitionUri ?? "ms-windows-store://pdp/?ProductId=9MZGLKWMZZV6",
  contextKey: overrides.contextKey ?? "context-a",
  policy: overrides.policy ?? { storeId: "9MZGLKWMZZV6" },
  authority: overrides.authority ?? { executablePath: "C:\\Program Files\\Memmy\\Memmy.exe" }
});
