import { describe, expect, it } from "vitest";
import {
  resolveWindowsStoreMigrationIdentity,
  resolveWindowsStoreMigrationPolicy
} from "../src/main/windows-store-migration-config.js";

const cnDestination = {
  edition: "cn",
  storeId: "9MZGLKWMZZV6",
  packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
  aumid: "Memtensor.Memmy_eyack96k521x2!Memmy",
  acquisitionUri: "ms-windows-store://pdp/?ProductId=9MZGLKWMZZV6"
} as const;

const intlDestination = {
  edition: "intl",
  storeId: "9NFVJC9K7ZK9",
  packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
  aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy",
  acquisitionUri: "https://get.microsoft.com/installer/download/9NFVJC9K7ZK9"
} as const;

describe("Windows NSIS-to-Store manifest-first policy", () => {
  it.each([
    ["cn", cnDestination],
    ["intl", intlDestination]
  ] as const)("returns store-migration for a complete %s destination only after manifest latest", (currentEdition, storeDestination) => {
    expect(resolveWindowsStoreMigrationPolicy({
      manifestStatus: "latest",
      currentEdition,
      storeDestination
    })).toEqual({
      kind: "store-migration",
      ...storeDestination
    });
  });

  it.each(["available"] as const)(
    "never migrates while the NSIS manifest status is %s",
    (manifestStatus) => {
      expect(resolveWindowsStoreMigrationPolicy({
        manifestStatus,
        currentEdition: "cn",
        storeDestination: cnDestination
      })).toBeNull();
    }
  );

  it.each(["error", "not-configured"] as const)("offers Web Install when NSIS is %s", (manifestStatus) => {
    expect(resolveWindowsStoreMigrationPolicy({ manifestStatus, currentEdition: "cn", storeDestination: cnDestination })?.kind)
      .toBe("store-migration");
  });

  it("defaults the internal switch to enabled but honors an explicit false", () => {
    expect(resolveWindowsStoreMigrationPolicy({
      manifestStatus: "latest",
      currentEdition: "cn",
      storeDestination: cnDestination
    })?.kind).toBe("store-migration");
    expect(resolveWindowsStoreMigrationPolicy({
      manifestStatus: "latest",
      currentEdition: "cn",
      internalEnabled: true,
      storeDestination: cnDestination
    })?.kind).toBe("store-migration");
    expect(resolveWindowsStoreMigrationPolicy({
      manifestStatus: "latest",
      currentEdition: "cn",
      internalEnabled: false,
      storeDestination: cnDestination
    })).toBeNull();
  });

  it("fails closed for a Partner Center draft without acquisitionUri", () => {
    const { acquisitionUri: _missing, ...draftDestination } = cnDestination;

    expect(resolveWindowsStoreMigrationPolicy({
      manifestStatus: "latest",
      currentEdition: "cn",
      storeDestination: draftDestination
    })).toBeNull();
  });

  it.each(["edition", "storeId", "packageFamilyName", "aumid", "acquisitionUri"] as const)(
    "requires the complete current-edition Store destination field %s",
    (field) => {
      const incomplete = { ...intlDestination } as Record<string, unknown>;
      delete incomplete[field];
      expect(resolveWindowsStoreMigrationPolicy({
        manifestStatus: "latest",
        currentEdition: "intl",
        storeDestination: incomplete
      })).toBeNull();
    }
  );

  it("rejects cross-edition and internally inconsistent identities", () => {
    expect(resolveWindowsStoreMigrationPolicy({
      manifestStatus: "latest",
      currentEdition: "cn",
      storeDestination: intlDestination
    })).toBeNull();
    expect(resolveWindowsStoreMigrationIdentity({
      ...cnDestination,
      storeId: intlDestination.storeId
    })).toBeNull();
    expect(resolveWindowsStoreMigrationIdentity({
      ...cnDestination,
      packageFamilyName: intlDestination.packageFamilyName
    })).toBeNull();
    expect(resolveWindowsStoreMigrationIdentity({
      ...cnDestination,
      aumid: `${cnDestination.packageFamilyName}!Other`
    })).toBeNull();
  });

  it("accepts only a Microsoft acquisition URI bound to the current Store ID", () => {
    for (const acquisitionUri of [
      "https://example.com/installer/download/9MZGLKWMZZV6",
      "https://get.microsoft.com/installer/download/9NFVJC9K7ZK9",
      "ms-windows-store://pdp/?ProductId=9NFVJC9K7ZK9",
      "ms-windows-store://pdp/?ProductId=9MZGLKWMZZV6&mode=mini"
    ]) {
      expect(resolveWindowsStoreMigrationPolicy({
        manifestStatus: "latest",
        currentEdition: "cn",
        storeDestination: { ...cnDestination, acquisitionUri }
      })).toBeNull();
    }
  });
});
