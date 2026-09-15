export type WindowsStoreMigrationEdition = "cn" | "intl";
export type WindowsLegacyManifestStatus = "latest" | "available" | "not-configured" | "error";

export interface WindowsStoreMigrationIdentity {
  edition: WindowsStoreMigrationEdition;
  storeId: string;
  packageFamilyName: string;
  aumid: string;
}

export interface WindowsStoreMigrationPolicy extends WindowsStoreMigrationIdentity {
  kind: "store-migration";
  acquisitionUri: string;
}

export interface ResolveWindowsStoreMigrationPolicyOptions {
  manifestStatus: WindowsLegacyManifestStatus;
  currentEdition: WindowsStoreMigrationEdition;
  internalEnabled?: boolean;
  storeDestination: unknown;
}

interface ExpectedWindowsStoreMigrationIdentity {
  storeId: string;
  packageFamilyName: string;
  aumid: string;
}

const expectedIdentities: Readonly<Record<WindowsStoreMigrationEdition, ExpectedWindowsStoreMigrationIdentity>> = Object.freeze({
  cn: {
    storeId: "9MZGLKWMZZV6",
    packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
    aumid: "Memtensor.Memmy_eyack96k521x2!Memmy"
  },
  intl: {
    storeId: "9NFVJC9K7ZK9",
    packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
    aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy"
  }
});

export const resolveExpectedWindowsStoreMigrationIdentity = (
  edition: WindowsStoreMigrationEdition
): WindowsStoreMigrationIdentity => ({
  edition,
  ...expectedIdentities[edition]
});

export const resolveWindowsStoreMigrationPolicy = (
  options: ResolveWindowsStoreMigrationPolicyOptions
): WindowsStoreMigrationPolicy | null => {
  if (options.manifestStatus === "available" || options.internalEnabled === false) return null;
  if (!isRecord(options.storeDestination)) return null;

  const identity = resolveWindowsStoreMigrationIdentity(options.storeDestination);
  if (!identity || identity.edition !== options.currentEdition) return null;
  const acquisitionUri = resolveWindowsStoreAcquisitionUri(
    options.storeDestination.acquisitionUri,
    identity.storeId
  );
  if (!acquisitionUri) return null;
  return { kind: "store-migration", ...identity, acquisitionUri };
};

export const resolveWindowsStoreMigrationIdentity = (
  value: unknown
): WindowsStoreMigrationIdentity | null => {
  if (!isRecord(value) || (value.edition !== "cn" && value.edition !== "intl")) return null;
  const expected = expectedIdentities[value.edition];
  if (
    value.storeId !== expected.storeId
    || value.packageFamilyName !== expected.packageFamilyName
    || value.aumid !== expected.aumid
    || value.aumid !== `${value.packageFamilyName}!Memmy`
  ) {
    return null;
  }
  return {
    edition: value.edition,
    storeId: expected.storeId,
    packageFamilyName: expected.packageFamilyName,
    aumid: expected.aumid
  };
};

const resolveWindowsStoreAcquisitionUri = (value: unknown, storeId: string): string | null => {
  if (typeof value !== "string" || !value || value !== value.trim()) return null;

  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    return null;
  }
  if (uri.username || uri.password || uri.port || uri.hash) return null;

  if (uri.protocol === "ms-windows-store:") {
    const parameters = [...uri.searchParams.entries()];
    return uri.hostname.toLowerCase() === "pdp"
      && uri.pathname === "/"
      && parameters.length === 1
      && parameters[0]?.[0] === "ProductId"
      && parameters[0]?.[1].toUpperCase() === storeId
      ? uri.toString()
      : null;
  }

  if (uri.protocol !== "https:" || uri.search) return null;
  const hostname = uri.hostname.toLowerCase();
  const pathname = uri.pathname.toUpperCase();
  const validPath = hostname === "get.microsoft.com"
    ? pathname === `/INSTALLER/DOWNLOAD/${storeId}`
    : hostname === "apps.microsoft.com"
      ? pathname === `/DETAIL/${storeId}`
      : false;
  return validPath ? uri.toString() : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
