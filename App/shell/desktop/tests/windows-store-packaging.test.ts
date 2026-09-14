import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDirectory, "../../..");
const publishingConfigPath = join(
  desktopDirectory,
  "build",
  "store-publishing-profiles.json",
);
const publishingResolverPath = join(
  repositoryRoot,
  "scripts",
  "internal",
  "windows-store-publishing-profile.ps1",
);
const packageScriptPath = join(
  repositoryRoot,
  "scripts",
  "internal",
  "package-windows-store.ps1",
);
const packageVersionResolverPath = join(
  repositoryRoot,
  "scripts",
  "internal",
  "windows-store-package-version.ps1",
);
const manifestVerifierPath = join(
  repositoryRoot,
  "scripts",
  "internal",
  "windows-store-msix-manifest.ps1",
);
const buildProfileAssertionPath = join(
  repositoryRoot,
  "scripts",
  "internal",
  "assert-windows-store-build-profile.ps1",
);
const windowsBuildScriptPath = join(
  repositoryRoot,
  "scripts",
  "internal",
  "win",
  "build-nsis.sh",
);
const packageWinScriptPath = join(repositoryRoot, "scripts", "package-win.sh");
const fileLockRunnerPath = join(
  repositoryRoot,
  "scripts",
  "internal",
  "shared",
  "run-with-file-lock.mjs",
);
const windowsBuildLockShellPath = join(
  repositoryRoot,
  "scripts",
  "internal",
  "shared",
  "windows-build-lock.sh",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Windows Store packaging identity", () => {
  it("contains only the two company Store products and separates listing names from Windows display names", () => {
    const config = readPublishingConfig();

    expect(config).toEqual({
      schemaVersion: 2,
      publisher: "CN=2CA03910-614F-4524-BAEC-BAE9D6F10DD0",
      publisherDisplayName: "Memtensor",
      windowsDisplayName: "Memmy",
      legacyNsisAumid: "cn.memtensor.memmy",
      applications: {
        cn: {
          storeListingDisplayName: "Memmy",
          storeProductId: "9MZGLKWMZZV6",
          acquisitionUri: "https://get.microsoft.com/installer/download/9MZGLKWMZZV6",
          identityName: "Memtensor.Memmy",
          manifestApplicationId: "Memmy",
          packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
        },
        intl: {
          storeListingDisplayName: "Memmy Agent",
          storeProductId: "9NFVJC9K7ZK9",
          acquisitionUri: "https://get.microsoft.com/installer/download/9NFVJC9K7ZK9",
          identityName: "Memtensor.MemmyAgent",
          manifestApplicationId: "Memmy",
          packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
        },
      },
    });

    const serialized = JSON.stringify(config);
    expect(serialized).not.toMatch(/environments|storeMigration/);
  });

  it("separates Store package and Windows application display names in the AppX manifest", () => {
    const manifest = readFileSync(
      join(desktopDirectory, "build", "appx-manifest.xml"),
      "utf8",
    );

    expect(manifest).toContain(
      "<DisplayName>${storeListingDisplayName}</DisplayName>",
    );
    expect(manifest).toContain('DisplayName="${displayName}"');
    expect(manifest.match(/\$\{displayName\}/g)).toHaveLength(1);
    expect(manifest).toContain('EntryPoint="Windows.FullTrustApplication"');
    expect(manifest).toContain("xmlns:desktop=");
    expect(manifest).toContain("xmlns:rescap=");

    const extensions = readFileSync(
      join(desktopDirectory, "build", "appx-extensions.xml"),
      "utf8",
    );
    expect(extensions).toContain('Category="windows.startupTask"');
    expect(extensions).toContain('TaskId="MemmyStartupTask"');
    expect(extensions).toContain('Enabled="false"');
    expect(extensions).toContain('DisplayName="Memmy"');
    expect(extensions).toContain('Executable="__MEMMY_STORE_EXECUTABLE__"');
    expect(extensions).toContain('AumId="__MEMMY_LEGACY_NSIS_AUMID__"');
    expect(extensions).not.toContain("__MEMMY_STORE_AUMID__");
  });

  it("defines a fail-closed AppX target without hard-coded fallback identities", () => {
    const storeConfig = readFileSync(
      join(desktopDirectory, "electron-builder.store.yml"),
      "utf8",
    );
    const unsignedConfig = readFileSync(
      join(desktopDirectory, "electron-builder.store.unsigned.yml"),
      "utf8",
    );
    const winConfig = readFileSync(
      join(desktopDirectory, "electron-builder.win.yml"),
      "utf8",
    );
    const winUnsignedConfig = readFileSync(
      join(desktopDirectory, "electron-builder.win.unsigned.yml"),
      "utf8",
    );

    expect(storeConfig).toContain("extends: electron-builder.win.yml");
    expect(storeConfig).toContain("target: appx");
    expect(storeConfig).toContain("- runFullTrust");
    expect(storeConfig).not.toContain("from: dist/native");
    for (const baseConfig of [winConfig, winUnsignedConfig]) {
      expect(baseConfig).toContain("from: dist/native");
      expect(baseConfig).toContain('"MemmyStoreUpdate.exe"');
    }
    expect(storeConfig).not.toContain("from: dist/runtime/memory");
    expect(storeConfig).not.toContain("from: dist/runtime/bin");
    expect(storeConfig).not.toContain("from: dist/embedding-models");
    expect(storeConfig).not.toContain("from: build/icon.ico");
    expect(storeConfig).toContain(
      "identityName: MEMMY_STORE_IDENTITY_REQUIRED",
    );
    expect(storeConfig).toContain(
      "applicationId: MEMMY_STORE_APPLICATION_ID_REQUIRED",
    );
    expect(storeConfig).toContain("publisher: MEMMY_STORE_PUBLISHER_REQUIRED");
    expect(storeConfig).toContain("addAutoLaunchExtension: false");
    expect(storeConfig).not.toMatch(
      /CN=2CA03910|Memtensor\.Memmy|unvirtualizedResources/,
    );
    expect(unsignedConfig).toContain("extends: electron-builder.store.yml");
    expect(unsignedConfig).toContain("signExecutable: false");
    expect(unsignedConfig).toContain("forceCodeSigning: false");
  });

  it("keeps AppX packaging on the shared Windows runtime, pruning, and verification pipeline", () => {
    const source = readFileSync(windowsBuildScriptPath, "utf8");
    const packageWinSource = readFileSync(packageWinScriptPath, "utf8");
    const buildLockSource = readFileSync(windowsBuildLockShellPath, "utf8");
    const desktopBuildIndex = source.indexOf(
      "npm_with_configured_script_shell run build -w @memmy/desktop",
    );
    const helperBuildIndex = source.indexOf(
      "build-windows-store-update-helper.ps1",
    );
    const pruneIndex = source.indexOf("prune-packaged-runtime.mjs");
    const builderIndex = source.indexOf("npx electron-builder");
    const verifyIndex = source.indexOf(
      "verify_packaged_windows_unpacked_artifacts",
      builderIndex,
    );

    expect(source).toContain('PACKAGE_TARGET="${MEMMY_WINDOWS_TARGET:-nsis}"');
    expect(source).toContain('--win "$PACKAGE_TARGET"');
    expect(source).toContain("MEMMY_WINDOWS_APPX_IDENTITY_NAME");
    expect(source).toContain("MEMMY_WINDOWS_APPX_PUBLISHER_DISPLAY_NAME");
    expect(source).toContain("MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH");
    expect(source).toContain("MEMMY_WINDOWS_APPX_PACKAGE_VERSION");
    expect(source).toContain("MEMMY_WINDOWS_APPX_CUSTOM_EXTENSIONS_PATH");
    expect(source).toContain("assert-windows-store-build-profile.ps1");
    expect(source).toContain("run-with-file-lock.mjs");
    expect(buildLockSource).toContain("MEMMY_WINDOWS_BUILD_LOCK_HELD");
    expect(buildLockSource).toContain("MEMMY_WINDOWS_BUILD_LOCK_TOKEN");
    expect(buildLockSource).toContain("MEMMY_WINDOWS_BUILD_LOCK_OWNER_PID");
    expect(buildLockSource).toContain("MEMMY_WINDOWS_BUILD_LOCK_OWNER_FILE");
    expect(source).toContain("memmy_windows_build_lock_is_held");
    expect(source).not.toContain(
      'npx electron-builder "${BUILDER_ARGS[@]}" --win "$PACKAGE_TARGET" --x64 "$@"',
    );
    expect(source.lastIndexOf("--config.appx.identityName")).toBeGreaterThan(
      source.lastIndexOf('BUILDER_ARGS+=("$@")'),
    );
    expect(packageWinSource).toContain(
      "Windows AppX packaging does not accept electron-builder passthrough arguments",
    );
    expect(packageWinSource).toContain("unset MEMMY_WINDOWS_BUILD_LOCK_HELD");
    expect(packageWinSource).toContain("unset MEMMY_WINDOWS_BUILD_LOCK_TOKEN");
    expect(packageWinSource).toContain(
      "unset MEMMY_WINDOWS_BUILD_LOCK_OWNER_PID",
    );
    expect(packageWinSource).toContain(
      "unset MEMMY_WINDOWS_BUILD_LOCK_OWNER_FILE",
    );
    expect(helperBuildIndex).toBeGreaterThan(desktopBuildIndex);
    expect(source).not.toContain(
      'if [ "$PACKAGE_TARGET" = "appx" ]; then\n  package_step_start "Build Windows Store native update helper"',
    );
    expect(source).toContain(
      "release/win-unpacked/resources/native/MemmyStoreUpdate.exe",
    );
    expect(source).toContain(
      'if [ "$PACKAGE_SIGNING" = "unsigned" ]; then',
    );
    expect(source).toContain(
      "verify_signed_packaged_windows_store_helper",
    );
    expect(source.match(/verify_packaged_windows_store_helper_protocol/g)).toHaveLength(
      2,
    );
    expect(source).toContain("Get-AuthenticodeSignature");
    expect(source).toContain("SignerCertificate.Thumbprint");
    expect(source).toContain('MEMMY_HELPER_SIGNATURE_PATH="$helper_windows_path"');
    expect(source).toContain('MEMMY_MAIN_SIGNATURE_PATH="$main_windows_path"');
    expect(source).not.toContain(
      "param([string]$HelperPath, [string]$MainPath)",
    );
    expect(source).toContain("package-family-registration");
    expect(source).toContain("verify_windows_x64_native_module");
    expect(source).not.toContain(
      'if [ "$PACKAGE_TARGET" = "appx" ]; then\n  require_packaged_runtime_file "$DESKTOP_DIR/release/win-unpacked/resources/native/MemmyStoreUpdate.exe"',
    );
    expect(pruneIndex).toBeGreaterThan(-1);
    expect(builderIndex).toBeGreaterThan(pruneIndex);
    expect(verifyIndex).toBeGreaterThan(builderIndex);
  });

  it("reuses the NSIS Windows signing configuration for signed MSIX packages", () => {
    const source = readFileSync(packageScriptPath, "utf8");
    const nsisSource = readFileSync(windowsBuildScriptPath, "utf8");

    expect(source).toContain('[ValidateSet("StoreUpload", "LocalTest")]');
    expect(source).toContain('@("WIN_CSC_LINK", "CSC_LINK")');
    expect(source).toContain(
      '@("WIN_CSC_KEY_PASSWORD", "CSC_KEY_PASSWORD")',
    );
    expect(source).toContain('@("WIN_CSC_SHA1", "CSC_SHA1")');
    expect(source).toContain(
      '@("WIN_CSC_SUBJECT_NAME", "CSC_SUBJECT_NAME")',
    );
    expect(source).toContain(
      '@("WIN_CSC_TIMESTAMP_SERVER", "CSC_TIMESTAMP_SERVER")',
    );
    expect(source).toContain(
      '@("MEMMY_WINDOWS_SIGNING_SOURCE")',
    );
    expect(source).toContain(
      '$requestedSigningSource -notin @("auto", "certificate-store", "pfx")',
    );
    expect(source).toContain("if ($hasCertificateStoreConfiguration)");
    expect(source).toContain('Kind = "CertificateStore"');
    expect(source).toContain(
      '$arguments += @("/sha1", $SigningConfiguration.Thumbprint)',
    );
    expect(nsisSource).toContain(
      'local signing_source="${MEMMY_WINDOWS_SIGNING_SOURCE:-auto}"',
    );
    expect(nsisSource).toContain(
      'resolved_signing_source="certificate-store"',
    );
    expect(nsisSource).toContain('resolved_signing_source="pfx"');
    expect(nsisSource).toContain(
      "MEMMY_WINDOWS_SIGNING_SOURCE=auto|certificate-store|pfx",
    );
    expect(source).toContain("Assert-SigningCertificatePublisher");
    expect(source).toContain("Get-AuthenticodeSignature");
    expect(source).toContain("X509ChainStatusFlags]::UntrustedRoot");
    expect(source).toContain("signer thumbprint mismatch");
    expect(source).toContain("signer publisher mismatch");
    expect(source).not.toContain("& $signTool verify /pa");
    expect(source).toContain("[StringComparison]::Ordinal");
    expect(source).toContain("Assert-MsixPayloadParity");
    expect(source).toContain(
      "Assert-MsixContainsWindowsStoreTransitionHelper",
    );
    expect(source).toContain(
      '$expectedEntryPath = "app/resources/native/MemmyStoreUpdate.exe"',
    );
    expect(source.match(/Assert-MsixContainsWindowsStoreTransitionHelper/g)).toHaveLength(
      3,
    );
    expect(source.match(/Assert-MemmyWindowsStoreMsixManifest/g)).toHaveLength(
      2,
    );
    expect(source).toContain('Get-WindowsSdkTool -Name "makeappx.exe"');
    expect(source).toContain("LegacyNsisAumid");
    expect(source).toContain("unsigned-staging-$stagingId.msix");
    expect(source.indexOf("Assert-MemmyWindowsStoreMsixManifest")).toBeLessThan(
      source.indexOf("Move-Item", source.indexOf('if ($Mode -eq "LocalTest")')),
    );
    expect(source).not.toContain("[string]$PublishingConfigPath");
    expect(source).not.toContain(
      "elseif ($env:MEMMY_STORE_PUBLISHING_CONFIG_PATH)",
    );
    expect(source).toContain("electron-builder.store.unsigned.yml");
    expect(source).toContain('$env:MEMMY_SKIP_CODESIGN = "1"');
    expect(source).toContain("CSC_LINK = $null");
    expect(source).toContain("CSC_SHA1 = $null");
    expect(source).toContain("WIN_CSC_SHA1 = $null");
    expect(source).toContain("WIN_CSC_KEY_PASSWORD = $null");
    expect(source).toContain("MEMMY_WINDOWS_SIGNING_SOURCE = $null");
    expect(source).toContain('"app\\Memmy.exe"');
    expect(source).toContain("[IO.FileShare]::None");
    expect(source).toContain(".memmy-store-publication");
    expect(source).not.toContain(".memmy-store-packaging.lock");
    expect(source).not.toMatch(
      /windows-store-development-password|Set-Content.*password/i,
    );
    expect(source).not.toMatch(
      /MEMMY_WINDOWS_(?:SOURCES_PREBUILT|RUNTIME_PREPARED|STOP_BEFORE_AGENT_RUNTIME_INSTALL)/,
    );
    const localTestIndex = source.indexOf('if ($Mode -eq "LocalTest")');
    const copyIndex = source.indexOf("Copy-Item", localTestIndex);
    const signIndex = source.indexOf("Sign-WindowsMsix", copyIndex);
    const parityIndex = source.indexOf("Assert-MsixPayloadParity", signIndex);
    expect(copyIndex).toBeGreaterThan(localTestIndex);
    expect(signIndex).toBeGreaterThan(copyIndex);
    expect(parityIndex).toBeGreaterThan(signIndex);
  });

  it("keeps the displayed app version separate from the generated MSIX package version", () => {
    const source = readFileSync(packageScriptPath, "utf8");

    expect(source).toContain("[ValidateRange(0, 99)]");
    expect(source).toContain("[int]$StoreBuild = 0");
    expect(source).toContain("Resolve-MemmyWindowsStorePackageVersion");
    expect(source).toContain(
      "MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH = $generatedManifestRelativePath",
    );
    expect(source).toContain("--version $appVersion");
    expect(source).not.toContain("--version $storePackageVersion");
    expect(source).toContain("-ExpectedPackageVersion $storePackageVersion");
    expect(source).toContain(
      '$artifactBaseName = "Memmy-$appVersion-$storeBuildLabel-win32-x64-$resolvedChannel"',
    );
    expect(source).toContain(
      '$unsignedArtifactName = "$artifactBaseName-unsigned.msix"',
    );
    expect(source).toContain(
      '$localTestArtifactName = "$artifactBaseName-signed.msix"',
    );
    expect(source).toContain("signed-staging-$stagingId.msix");
    expect(source).not.toContain("$artifactBaseName-local-test.msix");
    expect(source).not.toContain("app-$appVersion-msix-$storePackageVersion");
    expect(source).toContain(
      "Refusing to overwrite an existing Windows Store package",
    );
    expect(source).not.toContain(
      '$expectedMsixPackageVersion = "$resolvedVersion.0"',
    );
  });
});

describe.runIf(process.platform === "win32")(
  "Windows Store publishing profile resolver",
  () => {
    it.each([
      [
        "cn",
        "Memmy",
        "9MZGLKWMZZV6",
        "Memtensor.Memmy",
        "Memtensor.Memmy_eyack96k521x2",
      ],
      [
        "intl",
        "Memmy Agent",
        "9NFVJC9K7ZK9",
        "Memtensor.MemmyAgent",
        "Memtensor.MemmyAgent_eyack96k521x2",
      ],
    ])(
      "resolves and validates the %s company identity",
      (channel, listingName, productId, identityName, packageFamilyName) => {
        const result = invokeResolver(publishingConfigPath, channel);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          Channel: channel,
          Publisher: "CN=2CA03910-614F-4524-BAEC-BAE9D6F10DD0",
          PublisherDisplayName: "Memtensor",
          WindowsDisplayName: "Memmy",
          StoreListingDisplayName: listingName,
          StoreProductId: productId,
          IdentityName: identityName,
          ApplicationId: "Memmy",
          PackageFamilyName: packageFamilyName,
          Aumid: `${packageFamilyName}!Memmy`,
          LegacyNsisAumid: "cn.memtensor.memmy",
        });
      },
    );

    it("rejects Publisher casing drift even when every other configured value is unchanged", () => {
      const config = readPublishingConfig();
      config.publisher = config.publisher.replace("CN=", "cn=");
      const configPath = writeTemporaryConfig(config);

      const result = invokeResolver(configPath, "cn");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "packageFamilyName does not match identityName and publisher",
      );
    });

    it("pins canonical product identities to the two approved Memtensor Store products", () => {
      const config = readPublishingConfig();
      config.applications.intl.storeProductId = "9AAAAAAAAAAA";
      const configPath = writeTemporaryConfig(config);

      const result = invokeCompanyConfigAssertion(configPath);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Canonical Windows Store company/intl 'storeProductId' must exactly match '9NFVJC9K7ZK9'",
      );
    });

    it.each([
      ["cn", "Memmy China"],
      ["intl", "Memmy Global"],
    ] as const)("supports renaming the %s Store listing while keeping the Windows app name", (channel, listingName) => {
      const config = readPublishingConfig();
      const oldListingName = config.applications[channel].storeListingDisplayName;
      config.applications[channel].storeListingDisplayName = listingName;
      const configPath = writeTemporaryConfig(config);
      const assertion = invokeCompanyConfigAssertion(configPath);
      expect(assertion.status, assertion.stderr).toBe(0);

      const resolved = invokeResolver(configPath, channel);
      expect(resolved.status, resolved.stderr).toBe(0);
      const profile = JSON.parse(resolved.stdout);
      expect(profile.StoreListingDisplayName).toBe(listingName);
      expect(profile.WindowsDisplayName).toBe("Memmy");

      const generated = invokeVersionedManifestGenerator(
        "1.1.201.0",
        profile.StoreListingDisplayName,
      );
      expect(generated.status, generated.stderr).toBe(0);
      const template = JSON.parse(generated.stdout) as string;
      expect(template).toContain(`<DisplayName>${listingName}</DisplayName>`);
      expect(template).toContain('DisplayName="${displayName}"');

      const manifestPath = join(createTemporaryDirectory(), "AppxManifest.xml");
      writeFileSync(
        manifestPath,
        createUnpackedManifest(channel).replace(
          `<DisplayName>${oldListingName}</DisplayName>`,
          `<DisplayName>${listingName}</DisplayName>`,
        ),
        "utf8",
      );
      const verified = invokeUnpackedManifestVerifier(manifestPath, channel, configPath);
      expect(verified.status, verified.stderr).toBe(0);
    });

    it("allows custom publishing configs only through the explicit test-only resolver switch", () => {
      const configPath = writeTemporaryConfig(readPublishingConfig());

      const result = invokeResolver(configPath, "cn", false);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Custom Windows Store publishing configs are test-only",
      );
    });

    it("rejects reused Product IDs across CN and Intl profiles", () => {
      const config = readPublishingConfig();
      config.applications.intl.storeProductId =
        config.applications.cn.storeProductId;
      const configPath = writeTemporaryConfig(config);

      const result = invokeResolver(configPath, "intl");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "reuse storeProductId",
      );
    });

    it("rejects legacy NSIS AUMID drift", () => {
      const config = readPublishingConfig();
      config.legacyNsisAumid = "Memtensor.Memmy_eyack96k521x2!Memmy";
      const configPath = writeTemporaryConfig(config);

      const result = invokeResolver(configPath, "cn");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "legacyNsisAumid must exactly match",
      );
    });

    it("defaults StoreBuild to 00 and derives the MSIX version from the app patch version", () => {
      const result = invokePackageVersionResolver("1.1.2");

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        AppVersion: "1.1.2",
        StoreBuild: 0,
        StoreBuildLabel: "00",
        PackageVersion: "1.1.200.0",
      });
    });

    it.each([
      ["1.1.2", 1, "01", "1.1.201.0"],
      ["1.1.2", 99, "99", "1.1.299.0"],
      ["1.1.3", 0, "00", "1.1.300.0"],
      ["1.2.0", 0, "00", "1.2.0.0"],
    ])(
      "maps app %s and StoreBuild %i (%s) to MSIX %s",
      (appVersion, storeBuild, storeBuildLabel, packageVersion) => {
        const result = invokePackageVersionResolver(appVersion, storeBuild);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          AppVersion: appVersion,
          StoreBuild: storeBuild,
          StoreBuildLabel: storeBuildLabel,
          PackageVersion: packageVersion,
        });
      },
    );

    it.each([-1, 100])("rejects StoreBuild %i outside 00-99", (storeBuild) => {
      const result = invokePackageVersionResolver("1.1.2", storeBuild);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("StoreBuild");
    });

    it("rejects an encoded MSIX build segment above 65535", () => {
      const result = invokePackageVersionResolver("1.1.656");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "must not exceed 65535",
      );
    });

    it.each(["cn", "intl"] as const)("generates the %s Store package name and version separately from the Windows app name", (channel) => {
      const listingName =
        readPublishingConfig().applications[channel].storeListingDisplayName;
      const result = invokeVersionedManifestGenerator("1.1.201.0", listingName);

      expect(result.status, result.stderr).toBe(0);
      const generatedManifest = JSON.parse(result.stdout) as string;
      const manifestTemplate = readFileSync(
        join(desktopDirectory, "build", "appx-manifest.xml"),
        "utf8",
      );
      expect(generatedManifest).toContain('Version="1.1.201.0"');
      expect(generatedManifest).not.toContain('Version="${version}"');
      expect(generatedManifest).toContain(
        `<DisplayName>${listingName}</DisplayName>`,
      );
      expect(generatedManifest).toContain('DisplayName="${displayName}"');
      expect(
        generatedManifest.replace(
          'Version="1.1.201.0"',
          'Version="${version}"',
        ).replace(
          `<DisplayName>${listingName}</DisplayName>`,
          "<DisplayName>${storeListingDisplayName}</DisplayName>",
        ),
      ).toBe(manifestTemplate);
    });

    it.each(["cn", "intl"] as const)("strictly validates %s Store identity and display names from an unpacked manifest", (channel) => {
      const directory = createTemporaryDirectory();
      const manifestPath = join(directory, "AppxManifest.xml");
      writeFileSync(manifestPath, createUnpackedManifest(channel), "utf8");

      const result = invokeUnpackedManifestVerifier(manifestPath, channel);
      const application = readPublishingConfig().applications[channel];

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        IdentityName: application.identityName,
        Publisher: "CN=2CA03910-614F-4524-BAEC-BAE9D6F10DD0",
        PackageVersion: "1.1.1.0",
        ApplicationId: "Memmy",
        Executable: "app\\Memmy.exe",
        EntryPoint: "Windows.FullTrustApplication",
        PackageFamilyName: application.packageFamilyName,
        Aumid: `${application.packageFamilyName}!Memmy`,
        LegacyNsisAumid: "cn.memtensor.memmy",
        StartupTaskId: "MemmyStartupTask",
        RunFullTrust: "runFullTrust",
      });
    });

    it.each([
      [
        "unreserved package name",
        "<DisplayName>Memmy Agent</DisplayName>",
        "<DisplayName>Memmy</DisplayName>",
        "Package/Properties/DisplayName mismatch",
      ],
      [
        "Store listing name used as the Windows app name",
        '<uap:VisualElements DisplayName="Memmy"',
        '<uap:VisualElements DisplayName="Memmy Agent"',
        "uap:VisualElements/DisplayName mismatch",
      ],
    ])("rejects Intl %s", (_name, original, replacement, expectedError) => {
      const directory = createTemporaryDirectory();
      const manifestPath = join(directory, "AppxManifest.xml");
      writeFileSync(
        manifestPath,
        createUnpackedManifest("intl").replace(original, replacement),
        "utf8",
      );

      const result = invokeUnpackedManifestVerifier(manifestPath, "intl");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expectedError);
    });

    it("rejects a Store package Identity version that does not match the requested version", () => {
      const directory = createTemporaryDirectory();
      const manifestPath = join(directory, "AppxManifest.xml");
      writeFileSync(
        manifestPath,
        createUnpackedManifest().replace(
          'Version="1.1.1.0"',
          'Version="1.1.1.1"',
        ),
        "utf8",
      );

      const result = invokeUnpackedManifestVerifier(manifestPath, "cn");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Package/Identity/Version mismatch",
      );
    });

    it.each([
      [
        "runFullTrust",
        (manifest: string) =>
          manifest.replace(
            '    <rescap:Capability Name="runFullTrust" />\n',
            "",
          ),
        "exactly one runFullTrust restricted capability",
      ],
      [
        "application EntryPoint",
        (manifest: string) =>
          manifest.replace(
            'EntryPoint="Windows.FullTrustApplication"',
            'EntryPoint="Personal.EntryPoint"',
          ),
        "Application/EntryPoint mismatch",
      ],
      [
        "startup executable",
        (manifest: string) =>
          manifest.replace(
            'Category="windows.startupTask" Executable="app\\Memmy.exe"',
            'Category="windows.startupTask" Executable="app\\Personal.exe"',
          ),
        "windows.startupTask desktop extension/Executable mismatch",
      ],
      [
        "startup EntryPoint",
        (manifest: string) =>
          manifest.replace(
            'Category="windows.startupTask" Executable="app\\Memmy.exe" EntryPoint="Windows.FullTrustApplication"',
            'Category="windows.startupTask" Executable="app\\Memmy.exe" EntryPoint="Personal.EntryPoint"',
          ),
        "windows.startupTask desktop extension/EntryPoint mismatch",
      ],
      [
        "startup TaskId",
        (manifest: string) =>
          manifest.replace(
            'TaskId="MemmyStartupTask"',
            'TaskId="PersonalTask"',
          ),
        "desktop:StartupTask/TaskId mismatch",
      ],
      [
        "startup Enabled",
        (manifest: string) =>
          manifest.replace('Enabled="false"', 'Enabled="true"'),
        "desktop:StartupTask/Enabled mismatch",
      ],
      [
        "startup DisplayName",
        (manifest: string) =>
          manifest.replace(
            'Enabled="false" DisplayName="Memmy"',
            'Enabled="false" DisplayName="Personal"',
          ),
        "desktop:StartupTask/DisplayName mismatch",
      ],
      [
        "legacy ShortcutPath pair",
        (manifest: string) =>
          manifest.replace(
            '            <rescap3:DesktopApp ShortcutPath="%USERPROFILE%\\Desktop\\Memmy.lnk" />\n',
            "",
          ),
        "exactly two windows.desktopAppMigration DesktopApp ShortcutPath entries",
      ],
      [
        "legacy ShortcutPath value",
        (manifest: string) =>
          manifest.replace(
            "%USERPROFILE%\\Desktop\\Memmy.lnk",
            "%USERPROFILE%\\Desktop\\Personal.lnk",
          ),
        "ShortcutPath entries do not exactly match",
      ],
      [
        "desktop7 shortcut File",
        (manifest: string) =>
          manifest.replace(
            'File="$(Desktop)\\Memmy.lnk"',
            'File="$(Desktop)\\Personal.lnk"',
          ),
        "desktop7:Shortcut/File mismatch",
      ],
      [
        "desktop7 shortcut Icon",
        (manifest: string) =>
          manifest.replace(
            'Icon="$(Package)\\app\\resources\\icon.ico"',
            'Icon="$(Package)\\app\\resources\\personal.ico"',
          ),
        "desktop7:Shortcut/Icon mismatch",
      ],
      [
        "desktop7 shortcut Description",
        (manifest: string) =>
          manifest.replace(
            'Description="Memmy" />',
            'Description="Personal" />',
          ),
        "desktop7:Shortcut/Description mismatch",
      ],
    ])("rejects %s manifest drift", (_name, mutateManifest, expectedError) => {
      const directory = createTemporaryDirectory();
      const manifestPath = join(directory, "AppxManifest.xml");
      writeFileSync(
        manifestPath,
        mutateManifest(createUnpackedManifest()),
        "utf8",
      );

      const result = invokeUnpackedManifestVerifier(manifestPath, "cn");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expectedError);
    });

    it("rejects a Store AUMID substituted as the legacy migration source", () => {
      const directory = createTemporaryDirectory();
      const manifestPath = join(directory, "AppxManifest.xml");
      writeFileSync(
        manifestPath,
        createUnpackedManifest().replace(
          'AumId="cn.memtensor.memmy"',
          'AumId="Memtensor.Memmy_eyack96k521x2!Memmy"',
        ),
        "utf8",
      );

      const result = invokeUnpackedManifestVerifier(manifestPath, "cn");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "windows.desktopAppMigration DesktopApp/AumId mismatch",
      );
    });

    it.each(["cn", "intl"] as const)("makes the AppX build re-resolve the %s company profile and reject identity and name drift", (channel) => {
      const generatedManifestRelativePath = `build/appx-manifest.generated.${process.pid}.xml`;
      const generatedManifestPath = join(
        desktopDirectory,
        ...generatedManifestRelativePath.split("/"),
      );
      const generatedExtensionsRelativePath = `build/appx-extensions.generated.${process.pid}.xml`;
      const generatedExtensionsPath = join(
        desktopDirectory,
        ...generatedExtensionsRelativePath.split("/"),
      );
      const listingName =
        readPublishingConfig().applications[channel].storeListingDisplayName;
      const generated = invokeVersionedManifestGenerator("1.1.201.0", listingName);
      expect(generated.status, generated.stderr).toBe(0);
      const generatedManifest = JSON.parse(generated.stdout) as string;
      writeFileSync(generatedManifestPath, generatedManifest, "utf8");
      writeFileSync(
        generatedExtensionsPath,
        '<rescap3:DesktopApp AumId="cn.memtensor.memmy" />\n',
        "utf8",
      );
      try {
        const valid = invokeBuildProfileAssertion(
          channel,
          generatedManifestRelativePath,
          generatedExtensionsRelativePath,
        );
        expect(valid.status, valid.stderr).toBe(0);

        const drifted = invokeBuildProfileAssertion(
          channel,
          generatedManifestRelativePath,
          generatedExtensionsRelativePath,
          { MEMMY_WINDOWS_APPX_IDENTITY_NAME: "Personal.Memmy" },
        );
        expect(drifted.status).not.toBe(0);
        expect(`${drifted.stdout}\n${drifted.stderr}`).toContain(
          `must exactly match company/${channel}`,
        );

        writeFileSync(
          generatedManifestPath,
          generatedManifest.replace(
            `<DisplayName>${listingName}</DisplayName>`,
            "<DisplayName>Wrong product name</DisplayName>",
          ),
          "utf8",
        );
        const nameDrifted = invokeBuildProfileAssertion(
          channel,
          generatedManifestRelativePath,
          generatedExtensionsRelativePath,
        );
        expect(nameDrifted.status).not.toBe(0);
        expect(`${nameDrifted.stdout}\n${nameDrifted.stderr}`).toContain(
          "Generated Store manifest must exactly match the canonical template",
        );

        writeFileSync(
          generatedManifestPath,
          generatedManifest.replace(
            'Version="1.1.201.0"',
            'Version="1.1.202.0"',
          ),
          "utf8",
        );
        const versionDrifted = invokeBuildProfileAssertion(
          channel,
          generatedManifestRelativePath,
          generatedExtensionsRelativePath,
        );
        expect(versionDrifted.status).not.toBe(0);
        expect(`${versionDrifted.stdout}\n${versionDrifted.stderr}`).toContain(
          "Generated Store manifest must exactly match the canonical template",
        );
      } finally {
        rmSync(generatedManifestPath, { force: true });
        rmSync(generatedExtensionsPath, { force: true });
      }
    });

    it.each([
      "--config.appx.identityName=Personal.Memmy",
      "--config.win.publisherName=Personal",
      "--config.artifactName=Personal.msix",
      "--config=personal.yml",
    ])(
      "rejects AppX electron-builder override %s before building",
      (argument) => {
        const result = spawnSync("bash", [windowsBuildScriptPath, argument], {
          encoding: "utf8",
          env: {
            ...process.env,
            MEMMY_DESKTOP_VERSION: readDesktopVersion(),
            MEMMY_WINDOWS_TARGET: "appx",
          },
        });

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          "Windows AppX packaging does not accept electron-builder passthrough arguments",
        );
      },
    );

    it("rejects a competing Windows build while the shared build lock is held", async () => {
      const directory = createTemporaryDirectory();
      const lockPath = join(directory, "windows-build");
      writeFileSync(`${lockPath}.owner-stale`, "stale\nstale\n", "utf8");
      const holder = spawn(process.execPath, [
        fileLockRunnerPath,
        lockPath,
        "bash",
        "-c",
        'source "$1"; memmy_windows_build_lock_is_held "$2" || exit 9; printf "lock-holder-ready\\n"; sleep 0.75',
        "memmy-lock-holder",
        windowsBuildLockShellPath.replaceAll("\\", "/"),
        lockPath.replaceAll("\\", "/"),
      ]);
      try {
        await waitForChildOutput(holder, "lock-holder-ready");
        const contender = spawnSync(
          process.execPath,
          [fileLockRunnerPath, lockPath, process.execPath, "-e", ""],
          { encoding: "utf8" },
        );

        expect(contender.status).not.toBe(0);
        expect(`${contender.stdout}\n${contender.stderr}`).toContain(
          "Another Memmy Windows package build is using the shared dist/runtime",
        );
        const [status] = await once(holder, "exit");
        expect(status).toBe(0);
        expect(existsSync(`${lockPath}.lock`)).toBe(false);
        expect(
          readdirSync(directory).filter((name) =>
            name.startsWith("windows-build.owner-"),
          ),
        ).toEqual([]);
      } finally {
        if (holder.exitCode === null) {
          holder.kill();
          await once(holder, "exit");
        }
      }
    });

    it("does not trust a residual external build-lock marker", () => {
      const directory = createTemporaryDirectory();
      const lockPath = join(directory, "windows-build").replaceAll("\\", "/");
      const result = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; memmy_windows_build_lock_is_held "$2"',
          "memmy-lock-test",
          windowsBuildLockShellPath.replaceAll("\\", "/"),
          lockPath,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            MEMMY_WINDOWS_BUILD_LOCK_HELD: "1",
            MEMMY_WINDOWS_BUILD_LOCK_TOKEN: "",
            MEMMY_WINDOWS_BUILD_LOCK_OWNER_PID: "",
            MEMMY_WINDOWS_BUILD_LOCK_OWNER_FILE: "",
          },
        },
      );

      expect(result.status).not.toBe(0);
    });

    it("requires the NSIS-compatible signing configuration before any LocalTest build starts", () => {
      const result = invokePackageWrapper("LocalTest", "cn");

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Windows signed MSIX requires WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD or WIN_CSC_SHA1/WIN_CSC_SUBJECT_NAME",
      );
    });

    it("rejects obsolete Store-specific signing variables", () => {
      const result = invokePackageWrapper("StoreUpload", "intl", {
        MEMMY_STORE_LOCAL_CERT_SHA1: "A".repeat(40),
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "MEMMY_STORE_LOCAL_CERT_SHA1 is no longer supported; use the NSIS-compatible WIN_CSC_* signing variables",
      );
    });

    it("prioritizes and validates SimplySign when both signing sources are configured", () => {
      const result = invokePackageWrapper("LocalTest", "intl", {
        WIN_CSC_SHA1: "not-a-thumbprint",
        WIN_CSC_LINK: "C:\\missing\\local-signing.pfx",
        WIN_CSC_KEY_PASSWORD: "not-used",
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "WIN_CSC_SHA1 must be a 40-character SHA-1 thumbprint",
      );
    });

    it("validates an explicit Windows signing-source override before packaging", () => {
      const result = invokePackageWrapper("LocalTest", "intl", {
        MEMMY_WINDOWS_SIGNING_SOURCE: "unsupported",
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "MEMMY_WINDOWS_SIGNING_SOURCE must be auto, certificate-store, or pfx",
      );
    });

    it("rejects publishing-config environment overrides in the canonical entrypoint", () => {
      const result = invokePackageWrapper("StoreUpload", "cn", {
        MEMMY_STORE_PUBLISHING_CONFIG_PATH: publishingConfigPath,
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "MEMMY_STORE_PUBLISHING_CONFIG_PATH is not supported",
      );
    });

    it("does not expose a publishing-config path parameter on the canonical entrypoint", () => {
      const result = invokePackageWrapperWithExtraArguments(
        "StoreUpload",
        "cn",
        ["-PublishingConfigPath", publishingConfigPath],
      );

      expect(result.status).not.toBe(0);
    });
  },
);

interface StorePublishingConfig {
  schemaVersion: number;
  publisher: string;
  publisherDisplayName: string;
  windowsDisplayName: string;
  legacyNsisAumid: string;
  applications: Record<
    "cn" | "intl",
    {
      storeListingDisplayName: string;
      storeProductId: string;
      acquisitionUri: string;
      identityName: string;
      manifestApplicationId: string;
      packageFamilyName: string;
    }
  >;
}

function readPublishingConfig(): StorePublishingConfig {
  return JSON.parse(
    readFileSync(publishingConfigPath, "utf8"),
  ) as StorePublishingConfig;
}

function writeTemporaryConfig(config: StorePublishingConfig): string {
  const directory = createTemporaryDirectory();
  const configPath = join(directory, "store-publishing-profiles.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "memmy-store-publishing-"));
  temporaryDirectories.push(directory);
  return directory;
}

function invokeResolver(
  configPath: string,
  channel: string,
  allowCustomConfig = configPath !== publishingConfigPath,
) {
  const script = [
    `. '${quotePowerShellLiteral(publishingResolverPath)}'`,
    `Resolve-MemmyStorePublishingProfile -ConfigPath '${quotePowerShellLiteral(configPath)}' -Channel '${quotePowerShellLiteral(channel)}'${allowCustomConfig ? " -TestOnlyAllowCustomConfig" : ""} | ConvertTo-Json -Compress`,
  ].join("; ");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" },
  );
}

function invokeCompanyConfigAssertion(configPath: string) {
  const script = [
    `. '${quotePowerShellLiteral(publishingResolverPath)}'`,
    `$config = Get-Content -Raw -LiteralPath '${quotePowerShellLiteral(configPath)}' | ConvertFrom-Json`,
    "Assert-MemmyCompanyStorePublishingConfig -Config $config",
  ].join("; ");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" },
  );
}

function invokeUnpackedManifestVerifier(
  manifestPath: string,
  channel: string,
  configPath = publishingConfigPath,
) {
  const script = [
    `. '${quotePowerShellLiteral(manifestVerifierPath)}'`,
    `$profile = Resolve-MemmyStorePublishingProfile -ConfigPath '${quotePowerShellLiteral(configPath)}' -Channel '${quotePowerShellLiteral(channel)}'${configPath === publishingConfigPath ? "" : " -TestOnlyAllowCustomConfig"}`,
    `Assert-MemmyWindowsStoreUnpackedManifest -ManifestPath '${quotePowerShellLiteral(manifestPath)}' -Profile $profile -ExpectedPackageVersion '1.1.1.0' -ExpectedExecutable 'app\\Memmy.exe' -ExpectedLegacyNsisAumid 'cn.memtensor.memmy' | ConvertTo-Json -Compress`,
  ].join("; ");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" },
  );
}

function invokePackageVersionResolver(
  appVersion: string,
  storeBuild?: number,
) {
  const command = [
    `. '${quotePowerShellLiteral(packageVersionResolverPath)}'`,
    `Resolve-MemmyWindowsStorePackageVersion -AppVersion '${quotePowerShellLiteral(appVersion)}'${storeBuild === undefined ? "" : ` -StoreBuild ${storeBuild}`} | ConvertTo-Json -Compress`,
  ].join("; ");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  );
}

function invokeVersionedManifestGenerator(
  packageVersion: string,
  listingName: string,
) {
  const manifestTemplatePath = join(
    desktopDirectory,
    "build",
    "appx-manifest.xml",
  );
  const command = [
    `. '${quotePowerShellLiteral(packageVersionResolverPath)}'`,
    `$template = Get-Content -Raw -LiteralPath '${quotePowerShellLiteral(manifestTemplatePath)}'`,
    `New-MemmyWindowsStoreVersionedManifestContent -Template $template -PackageVersion '${quotePowerShellLiteral(packageVersion)}' -StoreListingDisplayName '${quotePowerShellLiteral(listingName)}' | ConvertTo-Json -Compress`,
  ].join("; ");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  );
}

function invokePackageWrapper(
  mode: "StoreUpload" | "LocalTest",
  channel: "cn" | "intl",
  environmentOverrides: NodeJS.ProcessEnv = {},
) {
  const environment = { ...process.env };
  for (const name of [
    "MEMMY_STORE_LOCAL_CERT_SHA1",
    "MEMMY_STORE_LOCAL_CERT_STORE",
    "MEMMY_STORE_LOCAL_PFX",
    "MEMMY_STORE_LOCAL_PFX_PASSWORD",
    "MEMMY_STORE_LOCAL_TIMESTAMP_URL",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "WIN_CSC_SHA1",
    "WIN_CSC_SUBJECT_NAME",
    "WIN_CSC_TIMESTAMP_SERVER",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "CSC_SHA1",
    "CSC_SUBJECT_NAME",
    "CSC_TIMESTAMP_SERVER",
    "MEMMY_WINDOWS_SIGNING_SOURCE",
    "MEMMY_STORE_PUBLISHING_CONFIG_PATH",
  ]) {
    delete environment[name];
  }
  Object.assign(environment, environmentOverrides);
  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      packageScriptPath,
      "-Mode",
      mode,
      "-Channel",
      channel,
    ],
    { encoding: "utf8", env: environment },
  );
}

function invokeBuildProfileAssertion(
  channel: "cn" | "intl",
  generatedManifestRelativePath: string,
  generatedExtensionsRelativePath: string,
  overrides: NodeJS.ProcessEnv = {},
) {
  const config = readPublishingConfig();
  const application = config.applications[channel];
  const packageFamilyName = application.packageFamilyName;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MEMMY_WINDOWS_APPX_IDENTITY_NAME: application.identityName,
    MEMMY_WINDOWS_APPX_APPLICATION_ID: application.manifestApplicationId,
    MEMMY_WINDOWS_APPX_PUBLISHER: config.publisher,
    MEMMY_WINDOWS_APPX_PUBLISHER_DISPLAY_NAME: config.publisherDisplayName,
    MEMMY_WINDOWS_APPX_DISPLAY_NAME: config.windowsDisplayName,
    MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH: generatedManifestRelativePath,
    MEMMY_WINDOWS_APPX_PACKAGE_VERSION: "1.1.201.0",
    MEMMY_WINDOWS_APPX_CUSTOM_EXTENSIONS_PATH: generatedExtensionsRelativePath,
    MEMMY_WINDOWS_BUILDER_CONFIG: "electron-builder.store.unsigned.yml",
    MEMMY_STORE_PRODUCT_ID: application.storeProductId,
    MEMMY_STORE_LISTING_DISPLAY_NAME: application.storeListingDisplayName,
    MEMMY_STORE_PUBLISHER: config.publisher,
    MEMMY_STORE_PUBLISHER_DISPLAY_NAME: config.publisherDisplayName,
    MEMMY_STORE_WINDOWS_DISPLAY_NAME: config.windowsDisplayName,
    MEMMY_STORE_IDENTITY_NAME: application.identityName,
    MEMMY_STORE_APPLICATION_ID: application.manifestApplicationId,
    MEMMY_STORE_PACKAGE_FAMILY_NAME: packageFamilyName,
    MEMMY_STORE_AUMID: `${packageFamilyName}!${application.manifestApplicationId}`,
    MEMMY_STORE_LEGACY_NSIS_AUMID: config.legacyNsisAumid,
  };
  delete environment.MEMMY_STORE_PUBLISHING_CONFIG_PATH;
  Object.assign(environment, overrides);
  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      buildProfileAssertionPath,
      "-Channel",
      channel,
    ],
    { encoding: "utf8", env: environment },
  );
}

function invokePackageWrapperWithExtraArguments(
  mode: "StoreUpload" | "LocalTest",
  channel: "cn" | "intl",
  extraArguments: string[],
) {
  const environment = { ...process.env };
  delete environment.MEMMY_STORE_PUBLISHING_CONFIG_PATH;
  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      packageScriptPath,
      "-Mode",
      mode,
      "-Channel",
      channel,
      ...extraArguments,
    ],
    { encoding: "utf8", env: environment },
  );
}

function createUnpackedManifest(channel: "cn" | "intl" = "cn"): string {
  const application = readPublishingConfig().applications[channel];
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:desktop7="http://schemas.microsoft.com/appx/manifest/desktop/windows10/7"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  xmlns:rescap3="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities/3">
  <Identity Name="${application.identityName}" Publisher="CN=2CA03910-614F-4524-BAEC-BAE9D6F10DD0" Version="1.1.1.0" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${application.storeListingDisplayName}</DisplayName>
    <PublisherDisplayName>Memtensor</PublisherDisplayName>
  </Properties>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
  <Applications>
    <Application Id="Memmy" Executable="app\\Memmy.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Memmy" Square150x150Logo="appx\\Square150x150Logo.png" Square44x44Logo="appx\\Square44x44Logo.png" Description="Memmy" BackgroundColor="transparent" />
      <Extensions>
        <rescap3:Extension Category="windows.desktopAppMigration">
          <rescap3:DesktopAppMigration>
            <rescap3:DesktopApp AumId="cn.memtensor.memmy" />
            <rescap3:DesktopApp ShortcutPath="%USERPROFILE%\\Desktop\\Memmy.lnk" />
            <rescap3:DesktopApp ShortcutPath="%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Memmy.lnk" />
          </rescap3:DesktopAppMigration>
        </rescap3:Extension>
        <desktop:Extension Category="windows.startupTask" Executable="app\\Memmy.exe" EntryPoint="Windows.FullTrustApplication">
          <desktop:StartupTask TaskId="MemmyStartupTask" Enabled="false" DisplayName="Memmy" />
        </desktop:Extension>
        <desktop7:Extension Category="windows.shortcut">
          <desktop7:Shortcut File="$(Desktop)\\Memmy.lnk" Icon="$(Package)\\app\\resources\\icon.ico" Description="Memmy" />
        </desktop7:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
`;
}

function readDesktopVersion(): string {
  return (
    JSON.parse(
      readFileSync(join(desktopDirectory, "package.json"), "utf8"),
    ) as { version: string }
  ).version;
}

function waitForChildOutput(
  child: ReturnType<typeof spawn>,
  expected: string,
): Promise<void> {
  return new Promise((resolveOutput, rejectOutput) => {
    let output = "";
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolveOutput();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      rejectOutput(error);
    };
    const onExit = () => {
      cleanup();
      rejectOutput(
        new Error(`Lock holder exited before emitting ${expected}: ${output}`),
      );
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function quotePowerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
