import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWindowsStoreAumid,
  resolveWindowsStoreIdentity,
  resolveWindowsStorePackageFamilyName,
  resolveWindowsStoreUserDataPath
} from "../src/main/windows-store-paths.js";

const publisher = "CN=2CA03910-614F-4524-BAEC-BAE9D6F10DD0";
const publisherId = "eyack96k521x2";
const localAppDataPath = "C:\\Users\\lee\\AppData\\Local";

describe("Windows Store package paths", () => {
  it.each([
    {
      edition: "cn",
      identityName: "Memtensor.Memmy",
      packageFamilyName: "Memtensor.Memmy_eyack96k521x2"
    },
    {
      edition: "intl",
      identityName: "Memtensor.MemmyAgent",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
    }
  ] as const)("resolves the actual $edition manifest identity, PFN, AUMID, and LocalState", async ({
    edition,
    identityName,
    packageFamilyName
  }) => {
    await withStorePackage({ identityName, publisher, applicationId: "Memmy", publisherId }, async (resourcesPath, packageRoot) => {
      const options = { isWindowsStore: true, resourcesPath, localAppDataPath };

      expect(resolveWindowsStoreIdentity(options)).toEqual({
        edition,
        identityName,
        publisher,
        publisherId,
        applicationId: "Memmy",
        packageFamilyName,
        aumid: `${packageFamilyName}!Memmy`,
        packageRoot
      });
      expect(resolveWindowsStorePackageFamilyName(options)).toBe(packageFamilyName);
      expect(resolveWindowsStoreAumid(options)).toBe(`${packageFamilyName}!Memmy`);
      expect(resolveWindowsStoreUserDataPath(options)).toBe(
        `${localAppDataPath}\\Packages\\${packageFamilyName}\\LocalState\\Memmy`
      );
    });
  });

  it("does not inspect package state for non-Store builds", () => {
    const options = {
      isWindowsStore: false,
      resourcesPath: "Z:\\missing\\resources"
    };

    expect(resolveWindowsStoreIdentity(options)).toBeNull();
    expect(resolveWindowsStorePackageFamilyName(options)).toBeNull();
    expect(resolveWindowsStoreAumid(options)).toBeNull();
    expect(resolveWindowsStoreUserDataPath(options)).toBeNull();
  });

  it.each([
    {
      label: "unknown identity",
      identityName: "PersonalPublisher.Memmy",
      publisher,
      applicationId: "Memmy",
      publisherId
    },
    {
      label: "wrong publisher",
      identityName: "Memtensor.Memmy",
      publisher: "CN=UNTRUSTED",
      applicationId: "Memmy",
      publisherId
    },
    {
      label: "wrong Application Id",
      identityName: "Memtensor.MemmyAgent",
      publisher,
      applicationId: "App",
      publisherId
    },
    {
      label: "wrong package publisher id",
      identityName: "Memtensor.Memmy",
      publisher,
      applicationId: "Memmy",
      publisherId: "differentid"
    }
  ])("fails closed for $label", async ({ identityName, publisher: manifestPublisher, applicationId, publisherId: packagePublisherId }) => {
    await withStorePackage({
      identityName,
      publisher: manifestPublisher,
      applicationId,
      publisherId: packagePublisherId
    }, async (resourcesPath) => {
      expect(() => resolveWindowsStoreIdentity({
        isWindowsStore: true,
        resourcesPath,
        localAppDataPath
      })).toThrow("Windows Store");
    });
  });

  it("fails closed when the manifest has more than one Application identity", async () => {
    await withStorePackage({
      identityName: "Memtensor.Memmy",
      publisher,
      applicationId: "Memmy",
      publisherId,
      extraApplicationId: "Secondary"
    }, async (resourcesPath) => {
      expect(() => resolveWindowsStoreAumid({
        isWindowsStore: true,
        resourcesPath,
        localAppDataPath
      })).toThrow("exactly one Application");
    });
  });

  it("fails closed when AppxManifest identity fields disagree with PackageFullName", async () => {
    await withStorePackage({
      identityName: "Memtensor.Memmy",
      publisher,
      applicationId: "Memmy",
      publisherId,
      manifestVersion: "1.1.3.0"
    }, async (resourcesPath) => {
      expect(() => resolveWindowsStoreIdentity({
        isWindowsStore: true,
        resourcesPath,
        localAppDataPath
      })).toThrow("PackageFullName");
    });
  });

  it("requires an absolute LOCALAPPDATA path before deriving LocalState", async () => {
    await withStorePackage({
      identityName: "Memtensor.Memmy",
      publisher,
      applicationId: "Memmy",
      publisherId
    }, async (resourcesPath) => {
      expect(() => resolveWindowsStoreUserDataPath({
        isWindowsStore: true,
        resourcesPath
      })).toThrow("LOCALAPPDATA");
      expect(() => resolveWindowsStoreUserDataPath({
        isWindowsStore: true,
        resourcesPath,
        localAppDataPath: "relative\\Local"
      })).toThrow("absolute");
    });
  });
});

interface StorePackageFixture {
  identityName: string;
  publisher: string;
  applicationId: string;
  publisherId: string;
  extraApplicationId?: string;
  manifestVersion?: string;
}

async function withStorePackage(
  fixture: StorePackageFixture,
  run: (resourcesPath: string, packageRoot: string) => Promise<void>
): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "memmy-store-paths-"));
  const packageRoot = join(
    temporaryRoot,
    `${fixture.identityName}_1.1.2.0_x64__${fixture.publisherId}`
  );
  const resourcesPath = join(packageRoot, "resources", "app");
  const extraApplication = fixture.extraApplicationId
    ? `<Application Id="${fixture.extraApplicationId}" Executable="Other.exe" />`
    : "";
  const manifest = [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<Package xmlns=\"http://schemas.microsoft.com/appx/manifest/foundation/windows10\">",
    `  <Identity Publisher="${fixture.publisher}" Name="${fixture.identityName}" Version="${fixture.manifestVersion ?? "1.1.2.0"}" ProcessorArchitecture="x64" />`,
    "  <Applications>",
    `    <Application Executable="Memmy.exe" Id="${fixture.applicationId}" />`,
    `    ${extraApplication}`,
    "  </Applications>",
    "</Package>"
  ].join("\n");

  try {
    await mkdir(resourcesPath, { recursive: true });
    await writeFile(join(packageRoot, "AppxManifest.xml"), manifest, "utf8");
    await run(resourcesPath, packageRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
