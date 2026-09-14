export {
  RuntimeConfigSchema as DesktopRuntimeConfigSchema,
  type RuntimeConfig as DesktopRuntimeConfig
} from "@memmy/local-api-contracts";

export type MicrophoneAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unsupported";

export interface DesktopMenuBarIconResult {
  enabled: boolean;
}

export interface DesktopMemoryServiceRestartResult {
  ok: true;
  baseUrl: string;
}

export interface DesktopAppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  isWindowsStore: boolean;
  updateManifestUrl?: string;
}

export type DesktopUpdateCheckStatus = "not-configured" | "latest" | "available";

export type DesktopUpdateMode = "manual" | "silent" | "force";

export type DesktopUpdateProvider = "legacy-installer" | "microsoft-store" | "store-migration";

declare const desktopUpdateOfferTokenBrand: unique symbol;
declare const desktopStoreMigrationTokenBrand: unique symbol;

export type DesktopUpdateOfferToken = string & {
  readonly [desktopUpdateOfferTokenBrand]: "DesktopUpdateOfferToken";
};

export type DesktopStoreMigrationToken = string & {
  readonly [desktopStoreMigrationTokenBrand]: "DesktopStoreMigrationToken";
};

export interface DesktopWindowsStoreUpdateMetadata {
  baselinePackageVersion: string;
  baselinePackageFullName: string;
  canSilentlyDownload: boolean;
}

export type DesktopPreparedUpdateHandle =
  | {
      kind: "installer-file";
      filePath: string;
    }
  | {
      kind: "microsoft-store";
      baselinePackageVersion: string;
      baselinePackageFullName: string;
    }
  | {
      kind: "store-migration";
      offerToken: DesktopStoreMigrationToken;
    };

export interface DesktopUpdateCheckResult {
  status: DesktopUpdateCheckStatus;
  currentVersion: string;
  offerToken?: DesktopUpdateOfferToken;
  provider?: DesktopUpdateProvider;
  latestVersion?: string;
  minSupportedVersion?: string;
  updateMode?: DesktopUpdateMode;
  force?: boolean;
  downloadUrl?: string;
  windowsStore?: DesktopWindowsStoreUpdateMetadata;
  /** Main-owned migration offer; it is not an installer until download succeeds. */
  storeMigrationOffer?: Extract<DesktopPreparedUpdateHandle, { kind: "store-migration" }>;
  preparedUpdate?: DesktopPreparedUpdateHandle;
  releaseNotes?: string;
  publishedAt?: string;
}

export interface DesktopUpdateDownloadOptions {
  openInstaller?: boolean;
}

export type DesktopUpdateDownloadProgress =
  | {
      kind: "installer-file";
      downloadUrl: string;
      filePath: string;
      transferredBytes: number;
      totalBytes: number | null;
      percent: number | null;
    }
  | {
      kind: "microsoft-store";
      state: string;
      transferredBytes: number;
      totalBytes: number | null;
      percent: number | null;
    };

export interface DesktopUpdateInstallResult {
  preparedUpdate: DesktopPreparedUpdateHandle;
  filePath?: string;
  opened: boolean;
  willQuit?: boolean;
  background?: boolean;
}

export interface DesktopImageActionRequest {
  url: string;
  name?: string;
  mime?: string;
  data?: Uint8Array;
}

export type DesktopImageSaveResult =
  | { canceled: true }
  | { canceled: false; filePath: string; bytes: number };

export type DesktopProjectDirectorySelection =
  | { canceled: true }
  | { canceled: false; path: string };
