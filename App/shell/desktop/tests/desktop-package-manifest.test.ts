import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../../../../scripts/internal/shared/write-desktop-package-manifest.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop package manifest", () => {
  it("copies only the allowlisted cloud service value from the repository env", () => {
    const directory = mkdtempSync(join(tmpdir(), "memmy-package-manifest-"));
    temporaryDirectories.push(directory);
    const envPath = join(directory, ".env");
    const manifestPath = join(directory, "desktop-edition.json");
    writeFileSync(
      envPath,
      "MEMMY_CLOUD_SERVICE=https://cloud.example.com\nSECRET_DO_NOT_PACKAGE=fixture-secret\n",
    );
    const env = { ...process.env };
    delete env.MEMMY_CLOUD_SERVICE;

    const result = spawnSync(
      process.execPath,
      [scriptPath, envPath, manifestPath, "cn", "phone", "unsigned"],
      { encoding: "utf8", env },
    );

    expect(result.status).toBe(0);
    const rawManifest = readFileSync(manifestPath, "utf8");
    expect(JSON.parse(rawManifest)).toEqual({
      edition: "cn",
      accountChannel: "phone",
      signing: "unsigned",
      cloudService: "https://cloud.example.com",
    });
    expect(rawManifest).not.toContain("SECRET_DO_NOT_PACKAGE");
    expect(rawManifest).not.toContain("fixture-secret");
  });

  it("rejects cloud service URLs containing credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "memmy-package-manifest-"));
    temporaryDirectories.push(directory);
    const envPath = join(directory, ".env");
    const manifestPath = join(directory, "desktop-edition.json");
    writeFileSync(envPath, "MEMMY_CLOUD_SERVICE=https://user:password@cloud.example.com\n");
    const env = { ...process.env };
    delete env.MEMMY_CLOUD_SERVICE;

    const result = spawnSync(
      process.execPath,
      [scriptPath, envPath, manifestPath, "cn", "phone", "signed"],
      { encoding: "utf8", env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not contain credentials");
  });
});
